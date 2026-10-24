// Saldos de todas las monedas en todas las redes, con valor en USD.
import { erc20Abi } from 'viem';
import { NETWORKS, MAINNET, balance as btcBalance, formatUnits } from './chain.js';
import { EVM_CHAINS, EVM_KEYS, publicClient, assetsOn, addressUrl } from './evm.js';
import { usdValue, fmtUsd } from './prices.js';

export const BTC_ASSET = { symbol: 'BTC', native: true, decimals: 8, priceId: 'bitcoin' };

async function evmChainHoldings(key, address) {
  const pc = publicClient(key);
  const assets = assetsOn(key);
  const raw = await Promise.all(assets.map((a) => (a.native
    ? pc.getBalance({ address })
    : pc.readContract({ address: a.address, abi: erc20Abi, functionName: 'balanceOf', args: [address] }))));
  const out = [];
  for (let i = 0; i < assets.length; i++) {
    if (raw[i] === 0n) continue;
    const amount = formatUnits(raw[i], assets[i].decimals);
    out.push({ red: EVM_CHAINS[key].label, activo: assets[i].symbol, cantidad: amount, usd: await usdValue(assets[i], amount) });
  }
  return out;
}

export async function holdings(entry, onlyChain) {
  const errores = [];
  let items = [];
  if (entry.network === 'bitcoin') {
    try {
      const b = await btcBalance(entry);
      if (b.confirmed !== '0' || b.pending) items.push({ red: NETWORKS.bitcoin.label, activo: 'BTC', cantidad: b.confirmed, ...(b.pending ? { pendiente: b.pending } : {}), usd: await usdValue(BTC_ASSET, b.confirmed) });
    } catch (e) { errores.push(`Bitcoin: ${e.message}`); }
  } else {
    const keys = onlyChain && EVM_KEYS.includes(onlyChain) ? [onlyChain] : EVM_KEYS;
    const res = await Promise.allSettled(keys.map((k) => evmChainHoldings(k, entry.address)));
    res.forEach((r, i) => (r.status === 'fulfilled' ? items.push(...r.value) : errores.push(`${EVM_CHAINS[keys[i]].label}: no respondió`)));
  }
  const total = items.reduce((s, x) => s + (x.usd || 0), 0);
  return {
    etiqueta: entry.label,
    direccion: entry.address,
    tipo: entry.network === 'bitcoin' ? 'Bitcoin' : 'EVM (misma dirección en todas las redes)',
    saldos: items.length ? items.map((x) => ({ ...x, usd: fmtUsd(x.usd) })) : 'sin fondos',
    total_usd: fmtUsd(total) + (MAINNET ? '' : ' (testnet: referencial, sin valor real)'),
    _total: total,
    ...(errores.length ? { errores } : {}),
    explorador: entry.network === 'bitcoin' ? NETWORKS.bitcoin.explorer(entry.address) : addressUrl('ethereum', entry.address),
  };
}
