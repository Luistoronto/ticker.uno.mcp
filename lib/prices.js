// Precios en dólares para mostrar totales y aplicar límites. USDC/USDT se toman a USD 1.
import { fetchJson } from './chain.js';

const IDS = ['ethereum', 'bitcoin', 'polygon-ecosystem-token', 'binancecoin'];
let cached = { at: 0, data: null };

export async function prices() {
  if (cached.data && Date.now() - cached.at < 60_000) return cached.data;
  const base = (process.env.PRICE_API_URL || 'https://api.coingecko.com/api/v3').replace(/\/$/, '');
  try {
    const j = await fetchJson(`${base}/simple/price?ids=${IDS.join(',')}&vs_currencies=usd`);
    const data = Object.fromEntries(IDS.map((id) => [id, Number(j?.[id]?.usd) || null]));
    cached = { at: Date.now(), data };
    return data;
  } catch {
    return cached.data || {};
  }
}

// Valor en USD de un monto (número decimal en string). null si no hay precio.
export async function usdValue(asset, amountStr) {
  if (asset.stable) return Number(amountStr);
  const p = (await prices())[asset.priceId];
  return p ? Number(amountStr) * p : null;
}

export const fmtUsd = (v) => (v == null ? 'sin precio' : `USD ${v.toFixed(2)}`);
