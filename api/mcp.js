// Punto de entrada en Vercel: https://<proyecto>.vercel.app/mcp/<ACCESS_KEY>
// Modo sin sesión: cada pedido crea un servidor nuevo (ideal para funciones serverless).
import { timingSafeEqual, createHash } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { MAINNET, isValidMnemonic } from '../lib/chain.js';
import { buildServer } from '../lib/server.js';

// Semillas que ya quedaron expuestas y nunca deben usarse en la red real (hash SHA-256).
const BLOCKED_SEEDS = new Set(['bf1361e18f6574dadc99f8e4a25db0f1dc9efc29db06870e2f9a14fbe7605f79']);

function keyOk(given) {
  const expected = process.env.ACCESS_KEY || '';
  if (expected.length < 16 || typeof given !== 'string') return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function loadSeed() {
  const raw = MAINNET ? process.env.SEED_MNEMONIC_MAINNET : process.env.SEED_MNEMONIC;
  const m = (raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!isValidMnemonic(m)) return { error: `Falta configurar ${MAINNET ? 'SEED_MNEMONIC_MAINNET' : 'SEED_MNEMONIC'} o no es una semilla válida` };
  if (MAINNET && BLOCKED_SEEDS.has(createHash('sha256').update(m).digest('hex'))) {
    return { error: 'Esa semilla quedó expuesta y no se puede usar en la red real. Generá una nueva.' };
  }
  return { mnemonic: m };
}

const rpcError = (res, status, message) => res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });

export default async function handler(req, res) {
  if (!keyOk(req.query?.key)) return rpcError(res, 404, 'Not found');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return rpcError(res, 405, 'Method not allowed');
  }
  const seed = loadSeed();
  if (seed.error) return rpcError(res, 500, seed.error);

  const server = buildServer(seed.mnemonic);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) rpcError(res, 500, 'Error interno');
  }
}
