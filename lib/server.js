// Definición del servidor MCP: herramientas que Claude puede usar.
// Las claves privadas nunca se devuelven; solo direcciones públicas.
// Las transferencias requieren PIN (TRANSFER_PIN) y respetan un límite por operación.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NETWORKS, MAINNET, derive, balance } from './chain.js';
import { nextIndex, addEntry, listEntries, persistent } from './store.js';
import { quote, send, pinConfigured, pinOk } from './transfer.js';

const text = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }] });
const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });

const NET_DESC = MAINNET
  ? '"ethereum" = Ethereum red principal, "bitcoin" = Bitcoin red principal. Son REDES REALES: los fondos que se envíen tienen valor.'
  : '"ethereum" = Ethereum Sepolia, "bitcoin" = Bitcoin testnet4. Son redes de PRUEBA: las monedas no tienen valor.';
const AVISO = MAINNET
  ? 'Red real. Prototipo: usar solo montos chicos. Verificá la red antes de enviar (ETH a la red Ethereum, BTC a la red Bitcoin).'
  : 'Red de prueba: no enviar fondos reales a esta dirección.';
const NO_GUARDA = 'ATENCIÓN: la base de datos no está conectada, así que esta lista se borra cuando el servidor se reinicia. La dirección igual se puede regenerar con la semilla.';

export function buildServer(mnemonic) {
  const server = new McpServer({ name: 'ticker-uno-mcp', version: '0.3.0' });

  server.registerTool('create_address', {
    title: 'Crear dirección',
    description: `Crea una nueva dirección de depósito. ${NET_DESC} La clave privada nunca se devuelve. Devuelve la dirección, la red y un link al explorador. Antes de mostrarla, recordale al usuario en qué red usarla.`,
    inputSchema: {
      network: z.enum(['ethereum', 'bitcoin']).describe('Red: "ethereum" o "bitcoin"'),
      label: z.string().max(40).optional().describe('Nombre opcional para reconocer la dirección, ej. "Ahorro"'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ network, label }) => {
    try {
      const index = await nextIndex(network);
      const { address, path } = derive(mnemonic, network, index);
      const entry = { label: label || `${network === 'ethereum' ? 'ETH' : 'BTC'} ${index + 1}`, network, address, path, created_at: new Date().toISOString() };
      await addEntry(entry);
      return text({ etiqueta: entry.label, red: NETWORKS[network].label, direccion: address, explorador: NETWORKS[network].explorer(address), aviso: AVISO, ...(persistent ? {} : { guardado: NO_GUARDA }) });
    } catch (err) { return fail(`No pude crear la dirección: ${err.message}`); }
  });

  server.registerTool('list_addresses', {
    title: 'Listar direcciones',
    description: `Lista todas las direcciones creadas (etiqueta, red, dirección y link al explorador). No consulta saldos. ${MAINNET ? 'Redes reales.' : 'Redes de prueba.'}`,
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const list = (await listEntries()).map((e) => ({ etiqueta: e.label, red: NETWORKS[e.network].label, direccion: e.address, explorador: NETWORKS[e.network].explorer(e.address), creada: e.created_at }));
    if (!list.length) return text(`Todavía no hay direcciones. Podés pedir que cree una en ethereum o bitcoin.${persistent ? '' : ' ' + NO_GUARDA}`);
    return text(persistent ? list : { direcciones: list, guardado: NO_GUARDA });
  });

  server.registerTool('get_balance', {
    title: 'Consultar saldo',
    description: `Consulta en la blockchain el saldo nativo (ETH o BTC) de una dirección creada, por etiqueta o dirección. Sin parámetro, consulta todas. ${MAINNET ? 'Redes reales.' : 'Redes de prueba; los saldos no tienen valor.'} No incluye tokens como USDT o USDC.`,
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

  async function findEntry(q) {
    const s = (q || '').trim().toLowerCase();
    return (await listEntries()).find((e) => e.address.toLowerCase() === s || e.label.toLowerCase() === s);
  }

  const transferInput = {
    from: z.string().describe('Etiqueta o dirección de origen (una de las creadas)'),
    to: z.string().describe('Dirección de destino, de la misma red que el origen'),
    amount: z.string().describe('Monto en la moneda nativa (ETH o BTC), ej. "0.001"'),
  };

  server.registerTool('prepare_transfer', {
    title: 'Preparar transferencia',
    description: `Calcula una transferencia de ETH o BTC desde una dirección creada SIN enviarla: muestra monto, comisión estimada, total, saldo después y límite por operación. ${MAINNET ? 'Redes REALES: los fondos tienen valor y una transferencia enviada no se puede revertir.' : 'Redes de prueba.'} Mostrale el resumen al usuario y pedile que confirme explícitamente y que escriba su PIN antes de usar send_transfer.`,
    inputSchema: transferInput,
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ from, to, amount }) => {
    const entry = await findEntry(from);
    if (!entry) return fail(`No encontré una dirección de origen "${from}". Usá list_addresses para ver las disponibles.`);
    try {
      const { value, limit, q, summary } = await quote(mnemonic, entry, to, amount);
      const problemas = [];
      if (value > limit) problemas.push(`supera el límite por operación (${summary.limite_por_operacion})`);
      if (!q.ok) problemas.push('saldo insuficiente para monto + comisión');
      if (!pinConfigured()) problemas.push('las transferencias están deshabilitadas: falta configurar TRANSFER_PIN en el servidor');
      return text({ ...summary, se_puede_enviar: problemas.length === 0, ...(problemas.length ? { problemas } : { siguiente_paso: 'Si el usuario confirma estos datos, pedile su PIN y llamá a send_transfer con los mismos from, to y amount.' }) });
    } catch (err) { return fail(`No pude preparar la transferencia: ${err.message}`); }
  });

  server.registerTool('send_transfer', {
    title: 'Enviar transferencia',
    description: `Firma y envía una transferencia de ETH o BTC. ${MAINNET ? 'MUEVE FONDOS REALES Y NO SE PUEDE DESHACER.' : 'Redes de prueba.'} Usar SOLO después de prepare_transfer, cuando el usuario confirmó explícitamente en este chat el destino, el monto y la comisión. El PIN lo tiene que escribir el usuario en este momento: nunca lo inventes, lo adivines ni lo reutilices de mensajes anteriores sin que el usuario lo vuelva a dar.`,
    inputSchema: { ...transferInput, pin: z.string().describe('PIN de transferencias que escribe el usuario') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ from, to, amount, pin }) => {
    if (!pinConfigured()) return fail('Las transferencias están deshabilitadas: falta configurar TRANSFER_PIN en el servidor.');
    if (!pinOk(pin)) return fail('PIN incorrecto. No se envió nada.');
    const entry = await findEntry(from);
    if (!entry) return fail(`No encontré una dirección de origen "${from}".`);
    try {
      return text(await send(mnemonic, entry, to, amount));
    } catch (err) { return fail(`No se envió: ${err.message}`); }
  });

  return server;
}
