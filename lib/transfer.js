// Transferencias de ETH y BTC desde las direcciones creadas.
// Dos pasos: quote() calcula comisión y saldo restante sin mover nada; send() firma y transmite,
// y solo funciona con el PIN correcto (TRANSFER_PIN) y dentro del límite por operación.
import { timingSafeEqual } from 'node:crypto';
import { createPublicClient, createWalletClient, fallback, http, isAddress, getAddress, parseUnits } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { mainnet, sepolia } from 'viem/chains';
import { p2wpkh, selectUTXO, Address, OutScript } from '@scure/btc-signer';
import { NETWORKS, MAINNET, deriveKey, fetchJson, formatUnits } from './chain.js';

const DECIMALS = { ethereum: 18, bitcoin: 8 };
const DEFAULT_LIMIT = { ethereum: '0.005', bitcoin: '0.0002' };

export function limitFor(network) {
  const raw = network === 'ethereum' ? process.env.MAX_ETH_PER_TX : process.env.MAX_BTC_PER_TX;
  return parseUnits((raw || DEFAULT_LIMIT[network]).trim(), DECIMALS[network]);
}

export function pinConfigured() {
  return (process.env.TRANSFER_PIN || '').length >= 6;
}

export function pinOk(given) {
  const expected = process.env.TRANSFER_PIN || '';
  if (expected.length < 6 || typeof given !== 'string') return false;
  const a = Buffer.from(given.trim()), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseAmount(network, amount) {
  if (!/^\d+(\.\d+)?$/.test(String(amount).trim())) throw new Error('Monto inválido: usá un número como 0.001');
  const v = parseUnits(String(amount).trim(), DECIMALS[network]);
  if (v <= 0n) throw new Error('El monto tiene que ser mayor a cero');
  return v;
}

function indexFromPath(path) {
  const i = Number(path.split('/').pop());
  if (!Number.isInteger(i) || i < 0) throw new Error('Ruta de derivación inválida');
  return i;
}

// ---------- Ethereum ----------
function ethClients(mnemonic, entry) {
  const n = NETWORKS.ethereum;
  const chain = MAINNET ? mainnet : sepolia;
  const transport = fallback(n.rpc.map((u) => http(u, { timeout: 10000 })));
  const account = mnemonicToAccount(mnemonic, { addressIndex: indexFromPath(entry.path) });
  if (account.address.toLowerCase() !== entry.address.toLowerCase()) throw new Error('La dirección guardada no coincide con la semilla configurada');
  return { account, pub: createPublicClient({ chain, transport }), wallet: createWalletClient({ account, chain, transport }) };
}

async function ethQuote(mnemonic, entry, to, value) {
  if (!isAddress(to)) throw new Error('Dirección de destino de Ethereum inválida');
  const { account, pub, wallet } = ethClients(mnemonic, entry);
  const [bal, fees] = await Promise.all([pub.getBalance({ address: account.address }), pub.estimateFeesPerGas()]);
  const gas = await pub.estimateGas({ account, to: getAddress(to), value }).catch(() => 21000n);
  const maxFee = fees.maxFeePerGas * gas;
  return { bal, fee: maxFee, total: value + maxFee, ok: bal >= value + maxFee, send: () => wallet.sendTransaction({ to: getAddress(to), value, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }) };
}

// ---------- Bitcoin ----------
export function buildBtcTx({ privateKey, publicKey, utxos, to, value, feeRate, net }) {
  const spend = p2wpkh(publicKey, net);
  const inputs = utxos.map((u) => ({ txid: u.txid, index: u.vout, witnessUtxo: { script: spend.script, amount: BigInt(u.value) } }));
  const sel = selectUTXO(inputs, [{ address: to, amount: value }], 'default', {
    changeAddress: spend.address, feePerByte: BigInt(feeRate), bip69: true, createTx: true, network: net,
  });
  if (!sel || !sel.tx) return null;
  sel.tx.sign(privateKey);
  sel.tx.finalize();
  return { hex: sel.tx.hex, txid: sel.tx.id, fee: sel.fee };
}

async function btcQuote(mnemonic, entry, to, value) {
  const n = NETWORKS.bitcoin;
  try { OutScript.encode(Address(n.net).decode(to)); } catch { throw new Error(`Dirección de destino de Bitcoin inválida para ${n.label}`); }
  const key = deriveKey(mnemonic, entry.path);
  if (p2wpkh(key.publicKey, n.net).address !== entry.address) throw new Error('La dirección guardada no coincide con la semilla configurada');
  const [utxos, fees] = await Promise.all([fetchJson(`${n.api}/address/${entry.address}/utxo`), fetchJson(`${n.api}/v1/fees/recommended`)]);
  const bal = utxos.reduce((s, u) => s + BigInt(u.value), 0n);
  const feeRate = Math.max(1, Number(fees.halfHourFee || fees.hourFee || 1));
  const built = utxos.length ? buildBtcTx({ privateKey: key.privateKey, publicKey: key.publicKey, utxos, to, value, feeRate, net: n.net }) : null;
  return {
    bal, fee: built ? built.fee : null, total: built ? value + built.fee : null, ok: Boolean(built), feeRate,
    send: async () => {
      const r = await fetch(`${n.api}/tx`, { method: 'POST', body: built.hex });
      const body = await r.text();
      if (!r.ok) throw new Error(`La red rechazó la transacción: ${body.slice(0, 200)}`);
      return body.trim();
    },
  };
}

// ---------- API común ----------
export async function quote(mnemonic, entry, to, amount) {
  const value = parseAmount(entry.network, amount);
  const q = entry.network === 'ethereum' ? await ethQuote(mnemonic, entry, to.trim(), value) : await btcQuote(mnemonic, entry, to.trim(), value);
  const d = DECIMALS[entry.network], unit = NETWORKS[entry.network].unit;
  const limit = limitFor(entry.network);
  return {
    value, limit, q,
    summary: {
      desde: `${entry.label} (${entry.address})`,
      hacia: to.trim(),
      red: NETWORKS[entry.network].label,
      monto: `${formatUnits(value, d)} ${unit}`,
      comision_estimada: q.fee != null ? `${formatUnits(q.fee, d)} ${unit}` : 'no se pudo calcular',
      total: q.total != null ? `${formatUnits(q.total, d)} ${unit}` : 'no se pudo calcular',
      saldo_actual: `${formatUnits(q.bal, d)} ${unit}`,
      saldo_despues: q.total != null && q.ok ? `${formatUnits(q.bal - q.total, d)} ${unit}` : '—',
      limite_por_operacion: `${formatUnits(limit, d)} ${unit}`,
    },
  };
}

export async function send(mnemonic, entry, to, amount) {
  const { value, limit, q, summary } = await quote(mnemonic, entry, to, amount);
  if (value > limit) throw new Error(`El monto supera el límite por operación (${summary.limite_por_operacion})`);
  if (!q.ok) throw new Error(`Saldo insuficiente para monto + comisión (saldo ${summary.saldo_actual})`);
  const hash = await q.send();
  return { ...summary, estado: 'Transmitida a la red. Puede tardar unos minutos en confirmarse.', transaccion: hash, ver_transaccion: NETWORKS[entry.network].txExplorer(hash) };
}
