// Dónde se guardan las direcciones creadas.
// En Vercel: Upstash Redis (se conecta desde la pestaña Storage del proyecto).
// Sin Redis configurado: memoria temporal (solo para pruebas; se pierde al reiniciar).
import { Redis } from '@upstash/redis';

const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = url && token ? new Redis({ url, token }) : null;
const PREFIX = 'tumcp:';

const mem = { counters: {}, list: [] };

export const persistent = Boolean(redis);

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
