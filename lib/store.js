// Dónde se guardan las direcciones creadas.
// Acepta cualquier base Upstash Redis conectada desde Vercel, sin importar el prefijo
// de las variables (KV_REST_API_URL, STORAGE_KV_REST_API_URL, UPSTASH_REDIS_REST_URL,
// o una REDIS_URL de Upstash). Sin base: memoria temporal (se pierde al reiniciar).
import { Redis } from '@upstash/redis';
import { MODE } from './chain.js';

function findEnv(suffixes) {
  for (const [k, v] of Object.entries(process.env)) {
    if (v && suffixes.some((s) => k === s || k.endsWith('_' + s))) return v;
  }
  return null;
}

function restCredentials() {
  const url = findEnv(['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL']);
  const token = findEnv(['KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']);
  if (url && token) return { url, token };
  // REDIS_URL de Upstash: rediss://default:TOKEN@HOST:6379 → API REST https://HOST
  const ru = findEnv(['REDIS_URL', 'KV_URL']);
  if (ru) {
    try {
      const u = new URL(ru);
      if (u.hostname.endsWith('upstash.io') && u.password) return { url: `https://${u.hostname}`, token: decodeURIComponent(u.password) };
    } catch { /* formato no reconocido */ }
  }
  return null;
}

const creds = restCredentials();
const redis = creds ? new Redis(creds) : null;
const PREFIX = `tumcp:${MODE}:`; // listas separadas para red de prueba y red principal

const mem = { counters: {}, list: [], daily: {} };

export const persistent = Boolean(redis);
export const storageInfo = redis ? 'Upstash Redis' : 'memoria temporal (no se guarda)';

export async function nextIndex(network) {
  if (redis) return (await redis.incr(`${PREFIX}counter:${network}`)) - 1;
  mem.counters[network] = (mem.counters[network] || 0) + 1;
  return mem.counters[network] - 1;
}

export async function addEntry(entry) {
  if (redis) await redis.rpush(`${PREFIX}addresses`, entry);
  else mem.list.push(entry);
}

export async function listEntries() {
  if (redis) return (await redis.lrange(`${PREFIX}addresses`, 0, -1)).map((e) => (typeof e === 'string' ? JSON.parse(e) : e));
  return [...mem.list];
}

// Contador: lo lleva al menos hasta n (para sincronizar cuentas creadas fuera del servidor).
export async function counterAtLeast(network, n) {
  if (redis) {
    const k = `${PREFIX}counter:${network}`;
    const cur = Number((await redis.get(k)) || 0);
    if (cur < n) await redis.set(k, n);
    return;
  }
  mem.counters[network] = Math.max(mem.counters[network] || 0, n);
}

// Gasto diario en centavos de USD (día UTC), para el límite por día.
const today = () => new Date().toISOString().slice(0, 10);
export async function dailySpentCents() {
  if (redis) return Number((await redis.get(`${PREFIX}daily:${today()}`)) || 0);
  return mem.daily[today()] || 0;
}
export async function addDailyCents(c) {
  const v = Math.max(0, Math.round(c));
  if (redis) {
    const k = `${PREFIX}daily:${today()}`;
    await redis.incrby(k, v);
    await redis.expire(k, 60 * 60 * 48);
    return;
  }
  mem.daily[today()] = (mem.daily[today()] || 0) + v;
}
