// Definición del servidor MCP: herramientas que Claude puede usar.
// Las claves privadas nunca se devuelven. Las transferencias requieren PIN (TRANSFER_PIN)
// y respetan límites en USD por operación y por día.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NETWORKS, MAINNET, derive } from './chain.js';
import { EVM_KEYS, chainList } from './evm.js';
import { nextIndex, addEntry, listEntries, persistent, counterAtLeast } from './store.js';
import { quote, send, pinConfigured, pinOk, limits } from './transfer.js';
import { holdings } from './portfolio.js';
import { fmtUsd } from './prices.js';

const text = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }] });
const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });

const REAL = MAINNET ? 'Son REDES REALES: los fondos tienen valor.' : 'Son redes de PRUEBA: los montos no tienen valor.';
const NO_GUARDA = 'ATENCIÓN: la base de datos no está conectada, así que esta lista se borra cuando el servidor se reinicia. Las direcciones igual se pueden regenerar con la semilla.';
const CHAINS = [...EVM_KEYS, 'bitcoin'];

const label = (network, index) => (network === 'ethereum' ? `Cuenta ${index + 1}` : `BTC ${index + 1}`);
const view = (e) => ({ etiqueta: e.label, tipo: NETWORKS[e.network].label, direccion: e.address, explorador: NETWORKS[e.network].explorer(e.address) });

export function buildServer(mnemonic) {
  const server = new McpServer({ name: 'ticker-uno-mcp', version: '0.5.0' });

  async function findEntry(q) {
    const s = (q || '').trim().toLowerCase();
    return (await listEntries()).find((e) => e.address.toLowerCase() === s || e.label.toLowerCase() === s);
  }

  server.registerTool('create_address', {
    title: 'Crear dirección',
    description: `Crea una nueva dirección de depósito. "ethereum" crea una dirección EVM (0x…) que sirve en todas estas redes: ${chainList()}. "bitcoin" crea una dirección de Bitcoin. ${REAL} La clave privada nunca se devuelve. Al mostrarla, aclarale al usuario por qué red mandar cada moneda.`,
    inputSchema: {
      network: z.enum(['ethereum', 'bitcoin']).describe('"ethereum" (dirección EVM para todas las redes compatibles) o "bitcoin"'),
      label: z.string().max(40).optional().describe('Nombre opcional, ej. "Ahorro"'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ network, label: lbl }) => {
    try {
      const index = await nextIndex(network);
      const { address, path } = derive(mnemonic, network, index);
      const entry = { label: lbl || label(network, index), network, address, path, created_at: new Date().toISOString() };
      await addEntry(entry);
      return text({ ...view(entry), ...(network === 'ethereum' ? { redes: chainList(), cuenta_metamask: `Account ${index + 1}` } : {}), aviso: MAINNET ? 'Red real. Prototipo: usar montos chicos y verificar la red antes de enviar.' : 'Red de prueba.', ...(persistent ? {} : { guardado: NO_GUARDA }) });
    } catch (err) { return fail(`No pude crear la dirección: ${err.message}`); }
  });

  server.registerTool('list_addresses', {
    title: 'Listar direcciones',
    description: `Lista las direcciones creadas (etiqueta, tipo, dirección y explorador). No consulta saldos. Las direcciones EVM sirven en: ${chainList()}.`,
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const list = (await listEntries()).map(view);
    if (!list.length) return text(`Todavía no hay direcciones. Podés pedir que cree una en ethereum o bitcoin.${persistent ? '' : ' ' + NO_GUARDA}`);
    return text(persistent ? list : { direcciones: list, guardado: NO_GUARDA });
  });

  server.registerTool('get_balance', {
    title: 'Consultar saldos',
    description: `Consulta los saldos de una o de todas las direcciones creadas: monedas nativas (ETH, POL, BNB, BTC) y estables (USDC, USDT) en ${chainList()} y Bitcoin, con su valor y el total en USD. Solo muestra lo que tiene saldo. ${REAL}`,
    inputSchema: {
      address_or_label: z.string().optional().describe('Dirección o etiqueta. Vacío = todas'),
      chain: z.enum(CHAINS).optional().describe('Opcional: limitar a una red'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ address_or_label, chain }) => {
    let list = await listEntries();
    if (address_or_label) {
      const q = address_or_label.trim().toLowerCase();
      list = list.filter((e) => e.address.toLowerCase() === q || e.label.toLowerCase() === q);
      if (!list.length) return fail(`No encontré una dirección con "${address_or_label}". Usá list_addresses para ver las disponibles.`);
    }
    if (chain === 'bitcoin') list = list.filter((e) => e.network === 'bitcoin');
    else if (chain) list = list.filter((e) => e.network === 'ethereum');
    if (!list.length) return text('No hay direcciones para consultar.');
    const res = await Promise.all(list.map((e) => holdings(e, chain)));
    const total = res.reduce((s, r) => s + r._total, 0);
    res.forEach((r) => delete r._total);
    return text({ cuentas: res, total_general: fmtUsd(total) + (MAINNET ? '' : ' (testnet: referencial)') });
  });

  server.registerTool('sync_accounts', {
    title: 'Sincronizar cuentas',
    description: 'Agrega a la lista las cuentas que faltan hasta el número indicado, en el mismo orden que MetaMask (Cuenta 1 = Account 1, etc.). Sirve cuando el usuario creó cuentas en su billetera con la misma semilla. No mueve fondos.',
    inputSchema: {
      network: z.enum(['ethereum', 'bitcoin']).default('ethereum'),
      up_to: z.number().int().min(1).max(20).describe('Hasta qué número de cuenta sincronizar, ej. 5'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ network, up_to }) => {
    try {
      const have = new Set((await listEntries()).filter((e) => e.network === network).map((e) => Number(e.path.split('/').pop())));
      const added = [];
      for (let i = 0; i < up_to; i++) {
        if (have.has(i)) continue;
        const { address, path } = derive(mnemonic, network, i);
        const entry = { label: label(network, i), network, address, path, created_at: new Date().toISOString() };
        await addEntry(entry);
        added.push(view(entry));
      }
      await counterAtLeast(network, up_to);
      return text(added.length ? { agregadas: added } : `Ya estaban todas las cuentas hasta la ${up_to}.`);
    } catch (err) { return fail(`No pude sincronizar: ${err.message}`); }
  });

  const transferInput = {
    from: z.string().describe('Etiqueta o dirección de origen (una de las creadas)'),
    to: z.string().describe('Dirección de destino'),
    amount: z.string().describe('Monto en la moneda elegida, ej. "5" para 5 USDC o "0.001" para ETH'),
    asset: z.string().describe('Moneda: ETH, POL, BNB, BTC, USDC o USDT'),
    chain: z.enum(CHAINS).describe(`Red por la que se envía: ${CHAINS.join(', ')}. Si el usuario no la dijo, preguntásela; no la adivines.`),
  };

  server.registerTool('prepare_transfer', {
    title: 'Preparar transferencia',
    description: `Calcula una transferencia SIN enviarla: red, moneda, monto en USD, comisión estimada, saldo y límites. ${MAINNET ? 'Redes REALES: una transferencia enviada no se puede revertir.' : 'Redes de prueba.'} Mostrale el resumen al usuario, destacando la RED, y pedile que confirme explícitamente y escriba su PIN antes de usar send_transfer.`,
    inputSchema: transferInput,
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (p) => {
    const entry = await findEntry(p.from);
    if (!entry) return fail(`No encontré una dirección de origen "${p.from}". Usá list_addresses para ver las disponibles.`);
    try {
      const { q, summary } = await quote(mnemonic, entry, p);
      if (!pinConfigured()) q.problemas.push('las transferencias están deshabilitadas: falta configurar TRANSFER_PIN en el servidor');
      return text({ ...summary, se_puede_enviar: q.problemas.length === 0, ...(q.problemas.length ? { problemas: q.problemas } : { siguiente_paso: 'Si el usuario confirma estos datos, pedile su PIN y llamá a send_transfer con los mismos parámetros.' }) });
    } catch (err) { return fail(`No pude preparar la transferencia: ${err.message}`); }
  });

  server.registerTool('send_transfer', {
    title: 'Enviar transferencia',
    description: `Firma y envía una transferencia. ${MAINNET ? 'MUEVE FONDOS REALES Y NO SE PUEDE DESHACER.' : 'Redes de prueba.'} Usar SOLO después de prepare_transfer, cuando el usuario confirmó explícitamente en este chat la red, la moneda, el destino, el monto y la comisión. El PIN lo tiene que escribir el usuario en este momento: nunca lo inventes, lo adivines ni lo reutilices de mensajes anteriores sin que el usuario lo vuelva a dar.`,
    inputSchema: { ...transferInput, pin: z.string().describe('PIN de transferencias que escribe el usuario') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ pin, ...p }) => {
    if (!pinConfigured()) return fail('Las transferencias están deshabilitadas: falta configurar TRANSFER_PIN en el servidor.');
    if (!pinOk(pin)) return fail('PIN incorrecto. No se envió nada.');
    const entry = await findEntry(p.from);
    if (!entry) return fail(`No encontré una dirección de origen "${p.from}".`);
    try {
      return text(await send(mnemonic, entry, p));
    } catch (err) { return fail(`No se envió: ${err.message}`); }
  });

  server.registerTool('get_limits', {
    title: 'Ver límites',
    description: 'Muestra los límites de transferencia vigentes (USD por operación y por día) y si las transferencias están habilitadas.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const L = limits();
    return text({ por_operacion: `USD ${L.perTx}`, por_dia: `USD ${L.perDay}`, transferencias_habilitadas: pinConfigured(), modo: MAINNET ? 'redes reales' : 'redes de prueba', redes: [...EVM_KEYS, 'bitcoin'] });
  });

  return server;
}
