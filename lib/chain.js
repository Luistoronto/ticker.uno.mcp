// Derivación de direcciones (BIP44/BIP84) y consulta de saldos.
// Solo redes de prueba: Ethereum Sepolia y Bitcoin testnet4.
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { p2wpkh, TEST_NETWORK } from '@scure/btc-signer';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

export const NETWORKS = {
  ethereum: {
    label: 'Ethereum Sepolia (testnet)',
    path: (i) => `m/44'/60'/0'/0/${i}`,
    explorer: (a) => `https://sepolia.etherscan.io/address/${a}`,
    unit: 'SepoliaETH',
  },
  bitcoin: {
    label: 'Bitcoin testnet4',
    path: (i) => `m/84'/1'/0'/0/${i}`,
    explorer: (a) => `https://mempool.space/testnet4/address/${a}`,
    unit: 'tBTC',
  },
};

function ethAddress(pubCompressed) {
  const raw = secp256k1.Point.fromBytes(pubCompressed).toBytes(false).slice(1);
  const hex = bytesToHex(keccak_256(raw).slice(-20));
  const h = bytesToHex(keccak_256(new TextEncoder().encode(hex)));
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? hex[i].toUpperCase() : hex[i];
  return out;
}

export function derive(mnemonic, network, index) {
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error('Semilla inválida');
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic));
  const p = NETWORKS[network].path(index);
  const key = root.derive(p);
  const address = network === 'ethereum' ? ethAddress(key.publicKey) : p2wpkh(key.publicKey, TEST_NETWORK).address;
  return { address, path: p };
}

async function fetchJson(url, opts = {}) {
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

const SEPOLIA_RPC = ['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.drpc.org', 'https://rpc.sepolia.org'];

function formatUnits(v, decimals) {
  const s = v.toString().padStart(decimals + 1, '0');
  const int = s.slice(0, -decimals), frac = s.slice(-decimals).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

export async function balance(entry) {
  if (entry.network === 'ethereum') {
    let lastErr;
    for (const url of SEPOLIA_RPC) {
      try {
        const j = await fetchJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [entry.address, 'latest'] }) });
        if (j.error) throw new Error(j.error.message);
        return { confirmed: formatUnits(BigInt(j.result), 18), pending: null, unit: NETWORKS.ethereum.unit };
      } catch (e) { lastErr = e; }
    }
    throw new Error(`No pude consultar Sepolia (${lastErr?.message})`);
  }
  const j = await fetchJson(`https://mempool.space/testnet4/api/address/${entry.address}`);
  const c = j.chain_stats.funded_txo_sum - j.chain_stats.spent_txo_sum;
  const m = j.mempool_stats.funded_txo_sum - j.mempool_stats.spent_txo_sum;
  return { confirmed: formatUnits(BigInt(c), 8), pending: m ? formatUnits(BigInt(m), 8) : null, unit: NETWORKS.bitcoin.unit };
}
