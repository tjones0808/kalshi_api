# kalshi-sports-api

Read-only NBA and NFL market data from Kalshi, shaped for
parlay research. Agents call it over REST or MCP. Every
route except `GET /health` requires a bearer API key.

This service does **not** place, amend or cancel Kalshi
orders, and it does not create Kalshi combo markets. It
reads public market data. With optional Kalshi API
credentials it also signs its Kalshi requests and exposes
**read-only** portfolio endpoints (balance, positions,
fills, orders, settlements).

## Local run

```bash
cp .env.example .env
# Put at least one 32+ character key in API_KEYS
npm install
npm run dev
```

```bash
curl -s http://127.0.0.1:3000/health
curl -s http://127.0.0.1:3000/v1/leagues/nba/games \
  -H "Authorization: Bearer YOUR_KEY"
```

Required: Node 22+. `API_KEYS` is a comma-separated list.
Each key must be at least 32 characters. Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Configuration

All variables are optional except `API_KEYS`.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | Listen port |
| `API_KEYS` | required | Comma-separated, 32+ chars each. The `.env.example` placeholder (contains `replace-me`) is rejected |
| `KALSHI_BASE_URL` | Kalshi prod | Trade API v2 origin. The default serves public and signed calls |
| `KALSHI_API_KEY_ID` | unset | Kalshi API key id. Set with a private key, or not at all (setting only one is an error) |
| `KALSHI_PRIVATE_KEY` | unset | Kalshi private key (RSA or Ed25519): multiline PEM, PEM with literal `\n` escapes, or base64 of the PEM. Not with `KALSHI_PRIVATE_KEY_PATH` |
| `KALSHI_PRIVATE_KEY_PATH` | unset | Path to a PEM file, read at startup. Alternative to `KALSHI_PRIVATE_KEY` |
| `PORTFOLIO_API_KEYS` | unset | Comma-separated subset of `API_KEYS` (32+ chars each) allowed to read the portfolio. Unset means every API key may |
| `KALSHI_TIMEOUT_MS` | `8000` | Per-attempt Kalshi timeout, 1000-60000. Timed-out attempts retry; if all fail, the API returns `504 upstream_timeout` |
| `KALSHI_DEADLINE_MS` | `20000` | Overall budget for one Kalshi call across all retries, 2000-120000. Exceeding it returns `504 upstream_timeout` |
| `CACHE_MAX_ENTRIES` | `5000` | Max cached responses, 100-100000. Expired entries drop first, then the oldest |
| `CACHE_TTL_SERIES_MS` | `3600000` | Series cache TTL |
| `CACHE_TTL_MARKETS_MS` | `15000` | Markets cache TTL |
| `CACHE_TTL_ORDERBOOK_MS` | `5000` | Orderbook cache TTL |
| `CACHE_TTL_LIVE_MS` | `5000` | Live data cache TTL |
| `CACHE_TTL_TRADES_MS` | `10000` | Trades cache TTL |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window |
| `RATE_LIMIT_MAX` | `120` | Requests per key per window |
| `RATE_LIMIT_ANON_MAX` | `30` | Failed-auth requests per IP per window |

Parlay pricing bypasses the cache so quotes are fresh.
Portfolio reads are never cached.
Candlestick requests need `end_ts > start_ts` and at most
5000 candles (`(end_ts - start_ts) / (interval * 60)`).

## Auth

Send `Authorization: Bearer <key>` on every request other
than `GET`/`HEAD /health`. Missing or wrong keys return
`401`. Requests without a valid key are limited by IP
(`RATE_LIMIT_ANON_MAX`, default 30 per window); requests with
a valid key never count against that bucket. Valid keys are
limited per key (`RATE_LIMIT_MAX`, default 120).

Rotate a key by changing `API_KEYS` and restarting (or
redeploying on Railway).

## REST

Base path `/v1`. JSON in, JSON out.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness, no auth |
| GET | `/v1/exchange/status` | Kalshi exchange up/down |
| GET | `/v1/leagues/:league/series` | NBA/NFL series list |
| GET | `/v1/leagues/:league/games` | Games + moneyline/spread/total |
| GET | `/v1/games/:eventKey` | One game, including props |
| GET | `/v1/markets/:ticker` | One market + normalized quote |
| GET | `/v1/markets/:ticker/orderbook` | Book + best bids |
| GET | `/v1/markets/:ticker/trades` | Recent prints |
| GET | `/v1/markets/:ticker/candlesticks` | `interval=1\|60\|1440` |
| GET | `/v1/live/:milestoneId` | Live scoreboard |
| POST | `/v1/live/batch` | `{ "milestoneIds": [...] }` |
| POST | `/v1/parlays/price` | Parlay price from live asks |
| GET | `/v1/portfolio/balance` | Cash and portfolio value (dollars) |
| GET | `/v1/portfolio/positions` | Positions by market and event |
| GET | `/v1/portfolio/fills` | Fills |
| GET | `/v1/portfolio/orders` | Orders (`status=resting\|canceled\|executed`) |
| GET | `/v1/portfolio/settlements` | Settled markets and payouts |

`:league` is `nba` or `nfl`.

List games query: `date=YYYY-MM-DD` (optional),
`status=open|all` (default `open`).
The response is `{ league, games, truncated }`. `truncated` is
`true` when the list may be incomplete: Kalshi had more event
pages than the service reads (3 pages for `status=all`), or
more than 100 games matched `status=all`. Use `date` to narrow
the list. Date matching uses the
Kalshi ticker token (`26NOV11`), not the UTC start time, so
a late-night tip-off stays on the local slate date.

Portfolio routes (read-only) need Kalshi credentials; see
[Kalshi credentials](#kalshi-credentials). Without them they
return `503 portfolio_not_configured`. If `PORTFOLIO_API_KEYS`
is set, other bearer keys get `403 forbidden`. Responses carry
`Cache-Control: no-store`. Query parameters:

| Route | Query |
| --- | --- |
| `balance` | `subaccount`, `exchange_index` |
| `positions` | `settlement_status=unsettled\|settled\|all`, `count_filter=position,total_traded`, `ticker`, `event_ticker`, `limit`, `cursor`, `subaccount`, `exchange_index` |
| `fills` | `ticker` (comma list), `order_id`, `min_ts`, `max_ts`, `limit`, `cursor`, `subaccount`, `exchange_index` |
| `orders` | `status`, `ticker`, `event_ticker` (comma list), `min_ts`, `max_ts`, `limit`, `cursor`, `subaccount`, `exchange_index` |
| `settlements` | `ticker`, `event_ticker`, `min_ts`, `max_ts`, `limit`, `cursor`, `subaccount` |

`limit` is 1-1000. `min_ts` and `max_ts` are unix seconds.
Pass the returned `cursor` back for the next page. Money is
in dollars and counts are numbers, both as numbers; for
example `GET /v1/portfolio/balance` returns:

```json
{
  "balance": 12.34,
  "portfolioValue": 5.05,
  "updatedTs": 1731000000,
  "byExchangeIndex": [{ "exchangeIndex": 0, "balance": 12.34 }]
}
```

Game key is a GAME event ticker such as
`KXNBAGAME-26NOV11BOSTOR` or a milestone UUID. Related events
that fail to load (404, timeout) are skipped and set
`truncated: true`; if live data fails, `live` is `null`. Only
a failure on the root event fails the request.

Parlay body:

```json
{
  "legs": [
    { "ticker": "KXNBAGAME-26NOV11BOSTOR-BOS", "side": "yes" },
    { "ticker": "KXNFLGAME-26NOV16LACBAL-LAC", "side": "yes" }
  ]
}
```

The price is the product of each leg's **ask** (what you
pay to buy that side). `decimalOdds` and `americanOdds` are
that ask-based price to buy, not vig-free fair odds, and not
a Kalshi combo contract. A leg that cannot be bought (no real
ask) clears the combined price and odds to `null` with a
warning. Warnings also flag closed legs, missing liquidity,
and same-game correlation.

## MCP

Streamable HTTP at `/mcp`, same bearer key. Cursor / Claude
example:

```json
{
  "mcpServers": {
    "kalshi-sports": {
      "url": "https://YOUR_HOST/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_KEY"
      }
    }
  }
}
```

Tools: `exchange_status`, `list_games`, `get_game_markets`,
`get_market`, `get_orderbook`, `get_candlesticks`,
`get_trades`, `get_live_game`, `price_parlay`.

With Kalshi credentials, callers whose key may read the
portfolio also get `get_balance`, `get_positions`,
`get_fills`, `get_orders`, `get_settlements`. They are not
listed without credentials or for a key outside
`PORTFOLIO_API_KEYS`. There are no order-writing tools.

Local stdio is not used. Point the agent at the HTTP URL.

## Kalshi credentials

Optional. Create a key at kalshi.com (account settings, API
Keys, Create New API Key). Kalshi shows the key id and the
private key once; save both. Then set:

```bash
KALSHI_API_KEY_ID=your-key-id
KALSHI_PRIVATE_KEY_PATH=./kalshi.pem   # or KALSHI_PRIVATE_KEY
```

`KALSHI_PRIVATE_KEY` takes a multiline PEM, a one-line PEM
with literal `\n` escapes, or base64 of the PEM. Both RSA and
Ed25519 keys work. With a key, every Kalshi request is signed
(`KALSHI-ACCESS-KEY`, `KALSHI-ACCESS-TIMESTAMP`,
`KALSHI-ACCESS-SIGNATURE`; a fresh signature per attempt) and
the portfolio endpoints and tools turn on. The server prints
`kalshi auth: enabled (key abcd…)` or
`kalshi auth: disabled (public data only)` at startup. The key
is checked at startup; errors never print key text. A Kalshi
`401`/`403` becomes `502 upstream_auth_failed`.

## Railway

The image is built from `Dockerfile`. `railway.json` sets
the health check to `/health`.

1. Create a project from this directory (`railway up` or
   the dashboard).
2. Set `API_KEYS` in the service variables to one or more
   long random keys. Do not commit them.
3. `PORT` is provided by Railway. Other variables in
   `.env.example` are optional. For portfolio access add
   `KALSHI_API_KEY_ID` and `KALSHI_PRIVATE_KEY`: paste the
   PEM into a multiline variable, or base64 it on one line
   with `base64 -w0 kalshi.pem`.
4. Generate a public domain. Agents use
   `https://<domain>/v1/...` and `https://<domain>/mcp`.

The process binds `0.0.0.0` and trusts one proxy hop.

## Scripts

```bash
npm test          # vitest
npm run typecheck
npm run build     # tsc → dist/
npm start         # node dist/index.js
```

## Out of scope

Order placement, amending or cancelling orders, WebSocket
streaming, and creating multivariate combo markets are not in
this service. Account access is read-only.
