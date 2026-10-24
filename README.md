# ticker.uno MCP · prototipo

Servidor MCP remoto para Claude. Crea direcciones de depósito y consulta saldos en Ethereum y Bitcoin: redes de prueba (Sepolia, testnet4) o redes reales con `NETWORK_MODE=mainnet`. Permite transferir ETH y BTC con PIN y límite por operación. Corre en Vercel.

## Herramientas

| Herramienta | Qué hace |
|---|---|
| `create_address` | Crea una dirección en `ethereum` o `bitcoin`, con etiqueta opcional |
| `list_addresses` | Lista las direcciones creadas |
| `get_balance` | Consulta el saldo de una o de todas las direcciones |
| `prepare_transfer` | Calcula una transferencia (comisión, total, saldo después) sin enviarla |
| `send_transfer` | Firma y envía la transferencia; requiere el PIN y respeta el límite por operación |

Las claves se derivan de una semilla (BIP39) guardada como variable secreta. Las herramientas solo devuelven direcciones públicas.

## Variables de entorno (Vercel → Settings → Environment Variables)

| Variable | Valor |
|---|---|
| `NETWORK_MODE` | `mainnet` para redes reales; vacío o `testnet` para redes de prueba |
| `SEED_MNEMONIC` | Semilla de las redes de prueba |
| `SEED_MNEMONIC_MAINNET` | Semilla de las redes reales. Generala en una billetera y pegala solo en Vercel; nunca la compartas |
| `ACCESS_KEY` | Clave de acceso de al menos 16 caracteres; va en la URL del conector |
| `TRANSFER_PIN` | PIN de al menos 6 caracteres para enviar fondos. Sin esta variable, las transferencias están deshabilitadas |
| `MAX_ETH_PER_TX` | Límite por operación en ETH (por defecto 0.005) |
| `MAX_BTC_PER_TX` | Límite por operación en BTC (por defecto 0.0002) |
| `ETH_RPC_URL` / `BTC_API_URL` | Opcionales: nodo propio en lugar de los públicos |
| Variables de Upstash | Se crean solas al conectar Upstash Redis desde Storage; se aceptan con cualquier prefijo |

## URL del conector

`https://<proyecto>.vercel.app/mcp/<ACCESS_KEY>`

## Estructura

- `api/mcp.js`: punto de entrada HTTP (MCP Streamable HTTP, sin sesión)
- `lib/server.js`: definición de las herramientas
- `lib/chain.js`: derivación de direcciones y consulta de saldos
- `lib/transfer.js`: armado, firma y envío de transferencias
- `lib/store.js`: guardado en Upstash Redis (o memoria temporal si no está configurado)
- `vercel.json`: ruta `/mcp/:key` → `api/mcp`

**Prototipo. En red real, usar solo montos chicos y fondos propios.**
