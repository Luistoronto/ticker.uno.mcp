// Definición del servidor MCP: herramientas que Claude puede usar.
// Las claves privadas nunca se devuelven; solo direcciones públicas.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NETWORKS, derive, balance } from './chain.js';
import { nextIndex, addEntry, listEntries } from './store.js';

const text = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }] });
const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });

export function buildServer(mnemonic) {
  const server = new McpServer({ name: 'ticker-uno-mcp', version: '0.2.0' });

  server.registerTool('create_address', {
    title: 'Crear dirección',
    description: 'Crea una nueva dirección de depósito en una red de PRUEBA (testnet): "ethereum" = Ethereum Sepolia, "bitcoin" = Bitcoin testnet4. Las monedas de testnet no tienen valor. La clave privada nunca se devuelve. Devuelve la dirección, la red y un link al explorador.',
    inputSchema: {
      network: z.enum(['ethereum', 'bitcoin']).describe('Red: "ethereum" (Sepolia) o "bitcoin" (testnet4)'),
      label: z.string().max(40).optional().describe('Nombre opcional para reconocer la dirección, ej. "Ahorro"'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ network, label }) => {
    try {
      const index = await nextIndex(network);
      const { address, path } = derive(mnemonic, network, index);
      const entry = { label: label || `${network === 'ethereum' ? 'ETH' : 'BTC'} ${index + 1}`, network, address, path, created_at: new Date().toISOString() };
      await addEntry(entry);
      return text({ etiqueta: entry.label, red: NETWORKS[network].label, direccion: address, explorador: NETWORKS[network].explorer(address), aviso: 'Red de prueba: no enviar fondos reales a esta dirección.' });
    } catch (err) { return fail(`No pude crear la dirección: ${err.message}`); }
  });

  server.registerTool('list_addresses', {
    title: 'Listar direcciones',
    description: 'Lista todas las direcciones creadas (etiqueta, red, dirección y link al explorador). No consulta saldos.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const list = (await listEntries()).map((e) => ({ etiqueta: e.label, red: NETWORKS[e.network].label, direccion: e.address, explorador: NETWORKS[e.network].explorer(e.address), creada: e.created_at }));
    return text(list.length ? list : 'Todavía no hay direcciones. Podés pedir que cree una en ethereum o bitcoin.');
  });

  server.registerTool('get_balance', {
    title: 'Consultar saldo',
    description: 'Consulta en la blockchain de prueba el saldo de una dirección creada (por etiqueta o dirección). Sin parámetro, consulta todas. Los saldos son de testnet y no tienen valor.',
    inputSchema: { address_or_label: z.string().optional().describe('Dirección o etiqueta. Vacío = todas') },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ address_or_label }) => {
    let list = await listEntries();
    if (address_or_label) {
      const q = address_or_label.trim().toLowerCase();
      list = list.filter((e) => e.address.toLowerCase() === q || e.label.toLowerCase() === q);
      if (!list.length) return fail(`No encontré una dirección con "${address_or_label}". Usá list_addresses para ver las disponibles.`);
    }
    if (!list.length) return text('Todavía no hay direcciones creadas.');
    const out = await Promise.all(list.map(async (e) => {
      try {
        const b = await balance(e);
        return { etiqueta: e.label, red: NETWORKS[e.network].label, direccion: e.address, saldo: `${b.confirmed} ${b.unit}`, ...(b.pending ? { pendiente_de_confirmar: `${b.pending} ${b.unit}` } : {}), explorador: NETWORKS[e.network].explorer(e.address) };
      } catch (err) {
        return { etiqueta: e.label, direccion: e.address, error: err.message };
      }
    }));
    return text(out);
  });

  return server;
}
