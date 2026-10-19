// Punto de entrada en Vercel: https://<proyecto>.vercel.app/mcp/<ACCESS_KEY>
// Modo sin sesión: cada pedido crea un servidor nuevo (ideal para funciones serverless).
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { buildServer } from '../lib/server.js';

function keyOk(given) {
  const expected = process.env.ACCESS_KEY || '';
  if (expected.length < 16 || typeof given !== 'string') return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const rpcError = (res, status, message) => res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });

export default async function handler(req, res) {
  if (!keyOk(req.query?.key)) return rpcError(res, 404, 'Not found');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return rpcError(res, 405, 'Method not allowed');
  }
  const mnemonic = (process.env.SEED_MNEMONIC || '').trim().replace(/\s+/g, ' ');
  if (!validateMnemonic(mnemonic, wordlist)) return rpcError(res, 500, 'Falta configurar SEED_MNEMONIC');

  const server = buildServer(mnemonic);
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
