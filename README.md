# ticker.uno MCP · prototipo (v0.5)

Servidor MCP remoto para Claude. Crea direcciones, consulta saldos y transfiere monedas nativas y estables en varias redes. Corre en Vercel.

## Redes y monedas

| Red | Moneda nativa | Estables |
|---|---|---|
| Ethereum | ETH | USDC, USDT |
| Base | ETH | USDC |
| Arbitrum | ETH | USDC, USDT (USDT0) |
| Polygon | POL | USDC, USDT |
| BNB Chain | BNB | USDC, USDT (Binance-Peg, 18 decimales) |
| Bitcoin | BTC | — |

Una dirección EVM (`0x…`) sirve en todas las redes compatibles con Ethereum. Con `NETWORK_MODE=mainnet` se usan las redes reales; si no, sus redes de prueba (Sepolia, Base Sepolia, Arbitrum Sepolia, Polygon Amoy, BNB Testnet, Bitcoin testnet4; en testnet solo hay USDC de Circle).

Contratos de USDC verificados con Circle; USDT con los listados oficiales. USDT en Base no se incluye porque Tether no lo emite oficialmente ahí.

## Herramientas

| Herramienta | Qué hace |
|---|---|
| `create_address` | Crea una dirección EVM (`ethereum`) o de `bitcoin`, con etiqueta opcional |
| `list_addresses` | Lista las direcciones creadas |
| `get_balance` | Saldos de monedas nativas y estables en todas las redes, con valor y total en USD |
| `sync_accounts` | Agrega las cuentas que faltan hasta un número (Cuenta N = MetaMask Account N) |
| `prepare_transfer` | Calcula una transferencia (red, moneda, USD, comisión, saldo, límites) sin enviarla |
| `send_transfer` | Firma y envía la transferencia; requiere PIN y respeta los límites |
| `get_limits` | Muestra los límites vigentes |

Antes de enviar, el servidor verifica en la red los decimales y el símbolo del contrato del token, y que haya moneda nativa suficiente para la comisión.

## Variables de entorno (Vercel → Settings → Environments → Production)

| Variable | Valor |
|---|---|
| `NETWORK_MODE` | `mainnet` para redes reales; vacío para redes de prueba |
| `SEED_MNEMONIC` | Semilla de las redes de prueba |
| `SEED_MNEMONIC_MAINNET` | Semilla de las redes reales. Generala en una billetera y pegala solo en Vercel |
| `ACCESS_KEY` | Clave de acceso (16+ caracteres, letras y números); va en la URL del conector |
| `TRANSFER_PIN` | PIN de 6+ caracteres para enviar. Sin esta variable, las transferencias están deshabilitadas |
| `MAX_USD_PER_TX` | Límite por operación en USD (por defecto 20) |
| `MAX_USD_PER_DAY` | Límite diario en USD (por defecto 50) |
| `ALCHEMY_API_KEY` | Opcional, recomendada: acceso confiable a las redes EVM |
| `RPC_URL_<RED>` / `BTC_API_URL` | Opcionales: nodo propio por red (ej. `RPC_URL_BASE`) |
| Variables de Upstash | Se crean al conectar Upstash Redis desde Storage; se aceptan con cualquier prefijo |

Precios en USD: CoinGecko (USDC y USDT se toman a USD 1).

## URL del conector

`https://<proyecto>.vercel.app/mcp/<ACCESS_KEY>`

## Estructura

- `api/mcp.js`: punto de entrada HTTP (MCP Streamable HTTP, sin sesión)
- `lib/server.js`: herramientas
- `lib/chain.js`: derivación de direcciones y Bitcoin
- `lib/evm.js`: redes EVM, contratos de estables y conexión a nodos
- `lib/portfolio.js`: saldos multi-red con USD
- `lib/transfer.js`: armado, firma y envío de transferencias, límites
- `lib/prices.js`: precios en USD
- `lib/store.js`: guardado en Upstash Redis (o memoria temporal)
- `vercel.json`: ruta `/mcp/:key` → `api/mcp`

**Prototipo. En red real, usar solo montos chicos y fondos propios.**
