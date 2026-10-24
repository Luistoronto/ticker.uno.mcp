// Derivación de direcciones (BIP44 para Ethereum, BIP84 para Bitcoin) y consulta de saldos.
// NETWORK_MODE=mainnet usa las redes reales; cualquier otro valor usa las redes de prueba.
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { p2wpkh, NETWORK as BTC_MAIN, TEST_NETWORK as BTC_TEST } from '@scure/btc-signer';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

export const MAINNET = (process.env.NETWORK_MODE || '').trim().toLowerCase() === 'mainnet';
export const MODE = MAINNET ? 'mainnet' : 'testnet';

export const NETWORKS = MAINNET
  ? {
      ethereum: {
        label: 'Ethereum (red principal)',
        path: (i) => `m/44'/60'/0'/0/${i}`,
        explorer: (a) => `https://etherscan.io/address/${a}`,
        txExplorer: (h) => `https://etherscan.io/tx/${h}`,
        unit: 'ETH',
        rpc: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://cloudflare-eth.com'],
      },
      bitcoin: {
        label: 'Bitcoin (red principal)',
        path: (i) => `m/84'/0'/0'/0/${i}`,
        explorer: (a) => `https://mempool.space/address/${a}`,
        txExplorer: (h) => `https://mempool.space/tx/${h}`,
        unit: 'BTC',
        api: 'https://mempool.space/api',
        net: BTC_MAIN,
      },
    }
  : {
      ethereum: {
        label: 'Ethereum Sepolia (testnet)',
        path: (i) => `m/44'/60'/0'/0/${i}`,
        explorer: (a) => `https://sepolia.etherscan.io/address/${a}`,
        txExplorer: (h) => `https://sepolia.etherscan.io/tx/${h}`,
        unit: 'SepoliaETH',
        rpc: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.drpc.org', 'https://rpc.sepolia.org'],
      },
      bitcoin: {
        label: 'Bitcoin testnet4',
        path: (i) => `m/84'/1'/0'/0/${i}`,
        explorer: (a) => `https://mempool.space/testnet4/address/${a}`,
        txExplorer: (h) => `https://mempool.space/testnet4/tx/${h}`,
        unit: 'tBTC',
        api: 'https://mempool.space/testnet4/api',
        net: BTC_TEST,
      },
    };

// Overrides opcionales (por ejemplo, un nodo propio o de Alchemy/Infura).
if (process.env.ETH_RPC_URL) NETWORKS.ethereum.rpc = [process.env.ETH_RPC_URL.trim(), ...NETWORKS.ethereum.rpc];
if (process.env.BTC_API_URL) NETWORKS.bitcoin.api = process.env.BTC_API_URL.trim().replace(/\/$/, '');

export function isValidMnemonic(m) {
  return validateMnemonic(m, wordlist);
}

function ethAddress(pubCompressed) {
  const raw = secp256k1.Point.fromBytes(pubCompressed).toBytes(false).slice(1);
  const hex = bytesToHex(keccak_256(raw).slice(-20));
  const h = bytesToHex(keccak_256(new TextEncoder().encode(hex)));
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? hex[i].toUpperCase() : hex[i];
  return out;
}

export function deriveKey(mnemonic, path) {
  if (!isValidMnemonic(mnemonic)) throw new Error('Semilla inválida');
  return HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive(path);
}

export function derive(mnemonic, network, index) {
  if (!isValidMnemonic(mnemonic)) throw new Error('Semilla inválida');
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic));
  const p = NETWORKS[network].path(index);
  const key = root.derive(p);
  const address = network === 'ethereum' ? ethAddress(key.publicKey) : p2wpkh(key.publicKey, NETWORKS.bitcoin.net).address;
  return { address, path: p };
}

export async function fetchJson(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

export function formatUnits(v, decimals) {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(decimals + 1, '0');
  const int = s.slice(0, -decimals), frac = s.slice(-decimals).replace(/0+$/, '');
  return (neg ? '-' : '') + (frac ? `${int}.${frac}` : int);
}

export async function balance(entry) {
  const n = NETWORKS[entry.network];
  if (entry.network === 'ethereum') {
    let lastErr;
    for (const url of n.rpc) {
      try {
        const j = await fetchJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [entry.address, 'latest'] }) });
        if (j.error) throw new Error(j.error.message);
        return { confirmed: formatUnits(BigInt(j.result), 18), pending: null, unit: n.unit };
      } catch (e) { lastErr = e; }
    }
    throw new Error(`No pude consultar la red de Ethereum (${lastErr?.message})`);
  }
  const j = await fetchJson(`${n.api}/address/${entry.address}`);
  const c = j.chain_stats.funded_txo_sum - j.chain_stats.spent_txo_sum;
  const m = j.mempool_stats.funded_txo_sum - j.mempool_stats.spent_txo_sum;
  return { confirmed: formatUnits(BigInt(c), 8), pending: m ? formatUnits(BigInt(m), 8) : null, unit: n.unit };
}
