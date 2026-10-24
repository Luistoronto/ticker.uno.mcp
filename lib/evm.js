// Redes compatibles con Ethereum (EVM) y sus monedas estables.
// La misma dirección 0x… sirve en todas estas redes.
// Contratos verificados con Circle (USDC) y listados oficiales de Tether/Binance (USDT).
import { createPublicClient, createWalletClient, fallback, http } from 'viem';
import { mainnet, sepolia, base, baseSepolia, arbitrum, arbitrumSepolia, polygon, polygonAmoy, bsc, bscTestnet } from 'viem/chains';
import { MAINNET } from './chain.js';

const ALCHEMY = (process.env.ALCHEMY_API_KEY || '').trim();

const MAIN = {
  ethereum: { label: 'Ethereum', chain: mainnet, native: { symbol: 'ETH', priceId: 'ethereum' }, explorer: 'https://etherscan.io', alchemy: 'eth-mainnet', public: 'https://ethereum-rpc.publicnode.com',
    tokens: [{ symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 }, { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 }] },
  base: { label: 'Base', chain: base, native: { symbol: 'ETH', priceId: 'ethereum' }, explorer: 'https://basescan.org', alchemy: 'base-mainnet', public: 'https://base-rpc.publicnode.com',
    tokens: [{ symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 }] },
  arbitrum: { label: 'Arbitrum', chain: arbitrum, native: { symbol: 'ETH', priceId: 'ethereum' }, explorer: 'https://arbiscan.io', alchemy: 'arb-mainnet', public: 'https://arbitrum-one-rpc.publicnode.com',
    tokens: [{ symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 }, { symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 }] },
  polygon: { label: 'Polygon', chain: polygon, native: { symbol: 'POL', priceId: 'polygon-ecosystem-token' }, explorer: 'https://polygonscan.com', alchemy: 'polygon-mainnet', public: 'https://polygon-bor-rpc.publicnode.com',
    tokens: [{ symbol: 'USDC', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 }, { symbol: 'USDT', address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 }] },
  bnb: { label: 'BNB Chain', chain: bsc, native: { symbol: 'BNB', priceId: 'binancecoin' }, explorer: 'https://bscscan.com', alchemy: 'bnb-mainnet', public: 'https://bsc-rpc.publicnode.com',
    tokens: [{ symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 }, { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 }] },
};

const TEST = {
  ethereum: { label: 'Ethereum Sepolia', chain: sepolia, native: { symbol: 'ETH', priceId: 'ethereum' }, explorer: 'https://sepolia.etherscan.io', alchemy: 'eth-sepolia', public: 'https://ethereum-sepolia-rpc.publicnode.com',
    tokens: [{ symbol: 'USDC', address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', decimals: 6 }] },
  base: { label: 'Base Sepolia', chain: baseSepolia, native: { symbol: 'ETH', priceId: 'ethereum' }, explorer: 'https://sepolia.basescan.org', alchemy: 'base-sepolia', public: 'https://base-sepolia-rpc.publicnode.com',
    tokens: [{ symbol: 'USDC', address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6 }] },
  arbitrum: { label: 'Arbitrum Sepolia', chain: arbitrumSepolia, native: { symbol: 'ETH', priceId: 'ethereum' }, explorer: 'https://sepolia.arbiscan.io', alchemy: 'arb-sepolia', public: 'https://arbitrum-sepolia-rpc.publicnode.com',
    tokens: [{ symbol: 'USDC', address: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', decimals: 6 }] },
  polygon: { label: 'Polygon Amoy', chain: polygonAmoy, native: { symbol: 'POL', priceId: 'polygon-ecosystem-token' }, explorer: 'https://amoy.polygonscan.com', alchemy: 'polygon-amoy', public: 'https://polygon-amoy-bor-rpc.publicnode.com',
    tokens: [{ symbol: 'USDC', address: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582', decimals: 6 }] },
  bnb: { label: 'BNB Chain Testnet', chain: bscTestnet, native: { symbol: 'BNB', priceId: 'binancecoin' }, explorer: 'https://testnet.bscscan.com', alchemy: 'bnb-testnet', public: 'https://bsc-testnet-rpc.publicnode.com',
    tokens: [] },
};

export const EVM_CHAINS = MAINNET ? MAIN : TEST;
export const EVM_KEYS = Object.keys(EVM_CHAINS);

export function rpcUrls(key) {
  const c = EVM_CHAINS[key];
  const urls = [];
  const override = process.env[`RPC_URL_${key.toUpperCase()}`] || (key === 'ethereum' ? process.env.ETH_RPC_URL : '');
  if (override) urls.push(override.trim());
  if (ALCHEMY) urls.push(`https://${c.alchemy}.g.alchemy.com/v2/${ALCHEMY}`);
  urls.push(c.public);
  for (const u of c.chain.rpcUrls?.default?.http || []) if (!urls.includes(u)) urls.push(u);
  return urls;
}

const cache = {};
function transport(key) {
  return fallback(rpcUrls(key).map((u) => http(u, { timeout: 10000, retryCount: 1 })));
}
export function publicClient(key) {
  return (cache[key] ||= createPublicClient({ chain: EVM_CHAINS[key].chain, transport: transport(key) }));
}
export function walletClient(key, account) {
  return createWalletClient({ account, chain: EVM_CHAINS[key].chain, transport: transport(key) });
}

export const addressUrl = (key, a) => `${EVM_CHAINS[key].explorer}/address/${a}`;
export const txUrl = (key, h) => `${EVM_CHAINS[key].explorer}/tx/${h}`;
export const chainList = () => EVM_KEYS.map((k) => EVM_CHAINS[k].label).join(', ');

// Activos disponibles en una red: la moneda nativa y sus estables.
export function assetsOn(key) {
  const c = EVM_CHAINS[key];
  return [{ symbol: c.native.symbol, native: true, decimals: 18, priceId: c.native.priceId }, ...c.tokens.map((t) => ({ ...t, native: false, stable: true }))];
}
