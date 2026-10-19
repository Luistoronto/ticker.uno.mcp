# ticker.uno MCP · prototipo

Servidor MCP remoto para Claude. Crea direcciones de depósito y consulta saldos en **redes de prueba** (Ethereum Sepolia y Bitcoin testnet4). Corre en Vercel.

## Herramientas

| Herramienta | Qué hace |
|---|---|
| `create_address` | Crea una dirección en `ethereum` (Sepolia) o `bitcoin` (testnet4), con etiqueta opcional |
| `list_addresses` | Lista las direcciones creadas |
| `get_balance` | Consulta el saldo de una o de todas las direcciones |

Las claves se derivan de una semilla (BIP39) guardada como variable secreta. Las herramientas solo devuelven direcciones públicas.

## Variables de entorno (Vercel → Settings → Environment Variables)

| Variable | Valor |
|---|---|
| `SEED_MNEMONIC` | Semilla de 24 palabras (solo testnet) |
| `ACCESS_KEY` | Clave de acceso de al menos 16 caracteres; va en la URL del conector |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Se crean solas al conectar Upstash Redis desde la pestaña Storage |

## URL del conector

`https://<proyecto>.vercel.app/mcp/<ACCESS_KEY>`

## Estructura

- `api/mcp.js`: punto de entrada HTTP (MCP Streamable HTTP, sin sesión)
- `lib/server.js`: definición de las herramientas
- `lib/chain.js`: derivación de direcciones y consulta de saldos
- `lib/store.js`: guardado en Upstash Redis (o memoria temporal si no está configurado)
- `vercel.json`: ruta `/mcp/:key` → `api/mcp`

**Prototipo. No usar con fondos reales.**
