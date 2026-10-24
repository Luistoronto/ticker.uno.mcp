// Transferencias de monedas nativas (ETH, POL, BNB, BTC) y estables (USDC, USDT).
// Dos pasos: quote() calcula todo sin mover nada; send() firma y transmite solo con PIN,
// dentro del límite por operación y del límite diario en USD.
import { timingSafeEqual } from 'node:crypto';
import { isAddress, getAddress, parseUnits, erc20Abi, encodeFunctionData } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { p2wpkh, selectUTXO, Address, OutScript } from '@scure/btc-signer';
import { NETWORKS, MAINNET, deriveKey, fetchJson, formatUnits } from './chain.js';
import { EVM_CHAINS, EVM_KEYS, publicClient, walletClient, assetsOn, txUrl } from './evm.js';
import { usdValue, fmtUsd } from './prices.js';
import { dailySpentCents, addDailyCents } from './store.js';
import { BTC_ASSET } from './portfolio.js';

export const limits = () => ({
  perTx: Number(process.env.MAX_USD_PER_TX || 20),
  perDay: Number(process.env.MAX_USD_PER_DAY || 50),
});

export function pinConfigured() {
  return (process.env.TRANSFER_PIN || '').length >= 6;
}
export function pinOk(given) {
  const expected = process.env.TRANSFER_PIN || '';
  if (expected.length < 6 || typeof given !== 'string') return false;
  const a = Buffer.from(given.trim()), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseAmount(amount, decimals) {
  const s = String(amount).trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('Monto inválido: usá un número como 0.001');
  const v = parseUnits(s, decimals);
  if (v <= 0n) throw new Error('El monto tiene que ser mayor a cero');
  return { v, s };
}

const ASSET_ALIASES = { MATIC: 'POL', 'USDT0': 'USDT', 'USD₮0': 'USDT', 'USDC.E': 'USDC' };
const normAsset = (a) => { const u = String(a || '').trim().toUpperCase(); return ASSET_ALIASES[u] || u; };

function indexFromPath(path) {
  const i = Number(path.split('/').pop());
  if (!Number.isInteger(i) || i < 0) throw new Error('Ruta de derivación inválida');
  return i;
}

async function feeParams(pc) {
  try {
    const f = await pc.estimateFeesPerGas();
    if (f.maxFeePerGas) return { params: { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas }, perGas: f.maxFeePerGas };
  } catch { /* red sin EIP-1559: precio clásico */ }
  const gp = await pc.getGasPrice();
  return { params: { gasPrice: gp }, perGas: gp };
}

// ---------- EVM ----------
async function evmQuote(mnemonic, entry, chainKey, assetSym, to, amount) {
  const c = EVM_CHAINS[chainKey];
  const asset = assetsOn(chainKey).find((a) => a.symbol === assetSym);
  if (!asset) throw new Error(`${assetSym} no está disponible en ${c.label}. Disponibles: ${assetsOn(chainKey).map((a) => a.symbol).join(', ')}`);
  if (!isAddress(to)) throw new Error('Dirección de destino inválida: tiene que ser una dirección 0x…');
  const dest = getAddress(to);
  const account = mnemonicToAccount(mnemonic, { addressIndex: indexFromPath(entry.path) });
  if (account.address.toLowerCase() !== entry.address.toLowerCase()) throw new Error('La dirección guardada no coincide con la semilla configurada');
  const pc = publicClient(chainKey);

  if (!asset.native) {
    const [dec, sym] = await Promise.all([
      pc.readContract({ address: asset.address, abi: erc20Abi, functionName: 'decimals' }),
      pc.readContract({ address: asset.address, abi: erc20Abi, functionName: 'symbol' }).catch(() => ''),
    ]);
    if (Number(dec) !== asset.decimals || !/USD/i.test(sym)) throw new Error(`El contrato de ${asset.symbol} en ${c.label} no respondió como se esperaba; no se envía nada`);
  }
  const { v: value, s: amountStr } = parseAmount(amount, asset.decimals);

  const [nativeBal, assetBal, fp] = await Promise.all([
    pc.getBalance({ address: account.address }),
    asset.native ? Promise.resolve(null) : pc.readContract({ address: asset.address, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }),
    feeParams(pc),
  ]);
  const tx = asset.native
    ? { to: dest, value }
    : { to: asset.address, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [dest, value] }) };
  const gas = await pc.estimateGas({ account: account.address, ...tx }).catch(() => (asset.native ? 21000n : 100000n));
  const gasLimit = (gas * 12n) / 10n; // margen del 20%
  const fee = gasLimit * fp.perGas;

  const problemas = [];
  if (asset.native) {
    if (nativeBal < value + fee) problemas.push(`saldo insuficiente: tenés ${formatUnits(nativeBal, 18)} ${asset.symbol} y necesitás ${formatUnits(value + fee, 18)} (monto + comisión)`);
  } else {
    if (assetBal < value) problemas.push(`saldo insuficiente de ${asset.symbol}: tenés ${formatUnits(assetBal, asset.decimals)}`);
    if (nativeBal < fee) problemas.push(`falta ${c.native.symbol} en ${c.label} para pagar la comisión: tenés ${formatUnits(nativeBal, 18)} y necesitás ~${formatUnits(fee, 18)} ${c.native.symbol}`);
  }

  const nativeAsset = assetsOn(chainKey)[0];
  return {
    asset, amountStr, usd: await usdValue(asset, amountStr), problemas,
    feeText: `${formatUnits(fee, 18)} ${c.native.symbol} (${fmtUsd(await usdValue(nativeAsset, formatUnits(fee, 18)))}, máximo estimado)`,
    saldo: asset.native ? `${formatUnits(nativeBal, 18)} ${asset.symbol}` : `${formatUnits(assetBal, asset.decimals)} ${asset.symbol} y ${formatUnits(nativeBal, 18)} ${c.native.symbol} para comisiones`,
    redLabel: c.label,
    send: async () => {
      const hash = await walletClient(chainKey, account).sendTransaction({ ...tx, gas: gasLimit, ...fp.params });
      return { hash, url: txUrl(chainKey, hash) };
    },
  };
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

async function btcQuote(mnemonic, entry, to, amount) {
  const n = NETWORKS.bitcoin;
  try { OutScript.encode(Address(n.net).decode(to)); } catch { throw new Error(`Dirección de destino de Bitcoin inválida para ${n.label}`); }
  const key = deriveKey(mnemonic, entry.path);
  if (p2wpkh(key.publicKey, n.net).address !== entry.address) throw new Error('La dirección guardada no coincide con la semilla configurada');
  const { v: value, s: amountStr } = parseAmount(amount, 8);
  const [utxos, fees] = await Promise.all([fetchJson(`${n.api}/address/${entry.address}/utxo`), fetchJson(`${n.api}/v1/fees/recommended`)]);
  const bal = utxos.reduce((s, u) => s + BigInt(u.value), 0n);
  const feeRate = Math.max(1, Number(fees.halfHourFee || fees.hourFee || 1));
  const built = utxos.length ? buildBtcTx({ privateKey: key.privateKey, publicKey: key.publicKey, utxos, to, value, feeRate, net: n.net }) : null;
  const problemas = built ? [] : [`saldo insuficiente: tenés ${formatUnits(bal, 8)} BTC y necesitás el monto más la comisión`];
  return {
    asset: BTC_ASSET, amountStr, usd: await usdValue(BTC_ASSET, amountStr), problemas,
    feeText: built ? `${formatUnits(built.fee, 8)} BTC (${fmtUsd(await usdValue(BTC_ASSET, formatUnits(built.fee, 8)))}, ${feeRate} sat/vB)` : 'no se pudo calcular',
    saldo: `${formatUnits(bal, 8)} BTC`,
    redLabel: n.label,
    send: async () => {
      const r = await fetch(`${n.api}/tx`, { method: 'POST', body: built.hex });
      const body = await r.text();
      if (!r.ok) throw new Error(`La red rechazó la transacción: ${body.slice(0, 200)}`);
      const hash = body.trim();
      return { hash, url: n.txExplorer(hash) };
    },
  };
}

// ---------- API común ----------
export async function quote(mnemonic, entry, { chain, asset, to, amount }) {
  const assetSym = normAsset(asset);
  let q;
  if (entry.network === 'bitcoin') {
    if (chain && chain !== 'bitcoin') throw new Error('El origen es una dirección de Bitcoin: solo puede enviar BTC por la red Bitcoin');
    if (assetSym && assetSym !== 'BTC') throw new Error('Desde una dirección de Bitcoin solo se puede enviar BTC');
    q = await btcQuote(mnemonic, entry, to.trim(), amount);
  } else {
    if (!chain || !EVM_KEYS.includes(chain)) throw new Error(`Indicá la red: ${EVM_KEYS.join(', ')}`);
    q = await evmQuote(mnemonic, entry, chain, assetSym, to.trim(), amount);
  }
  const L = limits();
  const spent = (await dailySpentCents()) / 100;
  if (q.usd == null) q.problemas.push('no pude obtener el precio en USD para validar los límites; probá en un rato');
  else {
    if (q.usd > L.perTx) q.problemas.push(`supera el límite por operación (USD ${L.perTx})`);
    if (spent + q.usd > L.perDay) q.problemas.push(`supera el límite diario (USD ${L.perDay}; hoy ya se enviaron USD ${spent.toFixed(2)})`);
  }
  return {
    q,
    summary: {
      desde: `${entry.label} (${entry.address})`,
      hacia: to.trim(),
      red: q.redLabel,
      activo: q.asset.symbol,
      monto: `${q.amountStr} ${q.asset.symbol} (${fmtUsd(q.usd)})`,
      comision_estimada: q.feeText,
      saldo_disponible: q.saldo,
      limites: `USD ${L.perTx} por operación · USD ${L.perDay} por día (usado hoy: USD ${spent.toFixed(2)})`,
      ...(MAINNET ? {} : { aviso: 'Red de prueba: los montos no tienen valor real' }),
    },
  };
}

export async function send(mnemonic, entry, params) {
  const { q, summary } = await quote(mnemonic, entry, params);
  if (q.problemas.length) throw new Error(q.problemas.join('; '));
  const { hash, url } = await q.send();
  await addDailyCents((q.usd || 0) * 100);
  return { ...summary, estado: 'Transmitida a la red. Puede tardar unos minutos en confirmarse.', transaccion: hash, ver_transaccion: url };
}
