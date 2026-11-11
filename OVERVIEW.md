# kalshi-sports-api: how it works

This document explains the service for the person who runs it and the AI agents that call it. It describes what the code does today. For request and response examples, see `README.md`.

## 1. What it is

`kalshi-sports-api` is a read-only proxy over the Kalshi Trade API v2, limited to NBA and NFL markets. It reshapes Kalshi data (games, markets, quotes, live scores) so an agent can research and price parlays. It is exposed two ways: a REST API under `/v1` and an MCP server at `/mcp` (Streamable HTTP). Every route except `GET /health` requires an API key. The market data needs no Kalshi account. If you give the service Kalshi API credentials (section 13), it also signs its Kalshi requests and exposes read-only portfolio endpoints (balance, positions, fills, orders, settlements). The service never places, amends, or cancels orders.

## 2. Architecture

```mermaid
flowchart TD
	agent["AI agent<br/>REST or MCP client"] --> helmet

	subgraph express["Express app (http/app.ts)"]
		helmet["helmet"] --> anon["Anonymous IP limiter<br/>skips requests with a valid key"]
		anon --> auth["Bearer API key auth"]
		auth --> keylimit["Per-key rate limiter"]
		keylimit --> json["JSON body parser (32 kB)"]
	end

	json --> v1["/v1 router"]
	json --> mcp["/mcp handler<br/>fresh MCP server per request"]

	v1 --> games["Games service"]
	v1 --> parlay["Parlay service"]
	v1 --> cached
	v1 -->|"/v1/portfolio: 503 or 403 gate"| portfolio["Portfolio service<br/>(only with Kalshi credentials)"]
	mcp --> games
	mcp --> parlay
	mcp --> cached
	mcp -->|"portfolio tools: allowed keys only"| portfolio
	games --> cached["Cached Kalshi client<br/>TTL cache, in-flight dedupe"]
	parlay -->|"uncached: fresh quotes"| raw
	portfolio -->|"uncached: private data"| raw
	cached --> raw["Raw Kalshi client<br/>timeouts, retry/backoff,<br/>Retry-After, pagination,<br/>signs every request when keyed"]
	raw --> kalshi[("Kalshi Trade API v2")]
```

`GET /health` is handled before the limiters and auth, so it bypasses them. The parlay service is deliberately wired to the raw client so every quote is fetched fresh, and so is the portfolio service, because account data is private and must never share the TTL cache. Everything else reads through the cache. The wiring is in `src/index.ts`.

## 3. Request lifecycle and middleware order

`createApp` in `src/http/app.ts` mounts things in this order:

1. `helmet()` adds security headers.
2. `trust proxy` is set to `1`, so the client IP comes from one proxy hop (Railway).
3. `GET`/`HEAD /health` answers `{ "status": "ok", "service": "kalshi-sports-api" }` with no auth.
4. The anonymous IP limiter runs.
5. `requireApiKey` checks the bearer token.
6. The per-key limiter runs.
7. `express.json({ limit: '32kb' })` parses JSON bodies. This runs after auth, so unauthenticated callers never reach the parser and get `401` even with a malformed body. Oversized or malformed bodies from authenticated callers are rejected with their own 4xx.
8. `GET /v1/_auth-check` returns `{ "ok": true }`. It exists to test auth.
9. The `/v1/portfolio` router, then the rest of the `/v1` router, and the `/mcp` handler (`app.all`, so any method) are mounted. The portfolio router is mounted first so its gate runs before anything else under `/v1/portfolio`.
10. A JSON `404 not_found` handler catches unmatched routes.
11. The error handler maps every thrown error to a safe JSON body.

Because auth runs before the 404 handler, an unauthenticated request to an unknown path gets `401`, not `404`.

## 4. Auth and rate limits

Keys come from the `API_KEYS` environment variable: a comma-separated list. Whitespace is trimmed and empty entries are dropped. Each key must be at least 32 characters. The server refuses to start if the list is empty, any key is too short, or any key contains `replace-me` (the `.env.example` placeholder). Clients send `Authorization: Bearer <key>` (the `Bearer` word is case-insensitive).

The presented token is hashed with sha256 and compared with `timingSafeEqual` against the digest of every configured key. The loop never exits early, so the position of the matching key does not leak through timing. A match records the key's index on the request. Failures return `401` with `{ "error": "unauthorized", "message": ... }`.

There are two rate limiters, both with a window of `RATE_LIMIT_WINDOW_MS` (default 60 seconds) and both skipping `/health`:

- **Anonymous IP limiter** (`RATE_LIMIT_ANON_MAX`, default 30). It sits before auth and is keyed by client IP. It runs the same constant-time key check as auth and skips any request that carries a valid bearer key, so only requests with a missing or invalid key are counted. Valid callers never use this bucket up, however many requests they have in flight, and a long-lived MCP stream cannot leak a count. An IP that has sent too many missing or bad-key requests receives `429 rate_limited` on further unauthenticated requests until the window resets, but a request with a valid key from that same IP still goes through.
- **Per-key limiter** (`RATE_LIMIT_MAX`, default 120). It is keyed by the key's index in `API_KEYS` (`key-0`, `key-1`, ...), so callers sharing an IP do not share a quota. It counts every request, successful or not.

Both limiters live in process memory and send standard `RateLimit-*` headers.

**Portfolio access.** By default every key in `API_KEYS` may read the portfolio (when Kalshi credentials are set). To narrow that, set `PORTFOLIO_API_KEYS` to a comma-separated subset of `API_KEYS`. Each entry must be at least 32 characters, must not contain `replace-me`, and must also appear in `API_KEYS`; anything else stops startup (the error never prints a key). A variable that is present but blank or contains no keys (for example a lone comma) is an error too, so a typo cannot open access. Only an unset variable means "all keys". At startup the allowed positions in `API_KEYS` are worked out once. A request is allowed when the index that the constant-time bearer check matched is in that set, so no extra secret comparison happens per request.

Generate a key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

To rotate a key without downtime:

1. Append the new key to `API_KEYS` (comma-separated) and deploy.
2. Update every agent to use the new key.
3. Remove the old key from `API_KEYS` and deploy again.

Keys are read once at startup, so any change needs a restart or redeploy. Per-key counters are keyed by position, so reordering keys moves their counters.

## 5. How Kalshi data maps to games

`src/domain/leagues.ts` defines the two leagues. Each has a ticker prefix, a set of series, and a Kalshi milestone type:

| League | Prefix | Game series | Spread | Total | Team total | Milestone type |
| --- | --- | --- | --- | --- | --- | --- |
| `nba` | `KXNBA` | `KXNBAGAME` | `KXNBASPREAD` | `KXNBATOTAL` | `KXNBATEAMTOTAL` | `basketball_game` |
| `nfl` | `KXNFL` | `KXNFLGAME` | `KXNFLSPREAD` | `KXNFLTOTAL` | `KXNFLTEAMTOTAL` | `football_game` |

NBA excludes series starting with `KXWNBA`, so WNBA never shows up. `GET /v1/leagues/:league/series` lists Kalshi's `Sports` series filtered by these prefixes. Game listing does not use that list. It queries the league's game series directly.

**Events.** In Kalshi, a game is an event whose ticker looks like `KXNBAGAME-26NOV11BOSTOR`. The moneyline markets (one per team) are nested in that event. `listGames` asks Kalshi for the open game events with nested markets and milestones.

**Milestones.** A milestone is Kalshi's record of the real-world game. It carries `primary_event_tickers`, `related_event_tickers`, a start date, a status, and `details.main_game_event_ticker`. A milestone is matched to an event when the event ticker appears in its primary or related list, or equals `main_game_event_ticker`. If several match, the one whose main game ticker equals the event wins, then the one with the league's milestone type, then the first. Rows are never paired by array index.

For each game, the spread and total lines come from the milestone's primary events, picked by series (`KXNBASPREAD`, `KXNBATOTAL`, and so on). A game with no milestone, or no primary event in that series, gets `null` for that line in the list.

**Date matching.** When you pass `date=YYYY-MM-DD`, the service converts it to Kalshi's `YYMONDD` token (`2026-11-11` becomes `26NOV11`) and compares it to the token found in the event ticker. Only if the ticker has no token does it fall back to the milestone's UTC start day. If there is also no milestone, the game is excluded. The ticker is preferred because an evening US game starts on the next UTC day: a 7:30 pm ET tip-off on Nov 11 is 00:30 UTC on Nov 12, so UTC dating would put it on the wrong slate. Invalid or impossible dates (such as `2026-02-31`) return `400`.

**One game.** `GET /v1/games/:eventKey` accepts a game event ticker (or any event ticker of the game) or a milestone UUID. A UUID is resolved through the milestone to its main game ticker, or failing that the first moneyline-series ticker. If neither exists, the result is a `404`. The service then loads the event, finds its milestone, loads the primary events followed by the related ones with nested markets, classifies every market (section 6), and fetches live data. Only a failure on the root event fails the request. A related event that returns a 404, times out, or fails upstream is skipped and sets `truncated: true`. If the live data lookup fails, the game is still returned with `live: null` and the milestone's status.

**Live data.** Live scores are keyed by milestone ID. `GameLive` exposes status, home and away points, clock, period, winner, a delayed flag, and a `raw` copy of the details with `*_mapping` objects removed. The clock is the first present of `clock`, `period_remaining_time`, `game_clock`. The period is the first present of `quarter`, `period`, `half`. `listGames` does not fetch live data, so its `gameStatus` is the milestone's status. `getGame` prefers the live status and returns `live: null` when live data is unavailable.

**Truncation signal.** `GET /v1/leagues/:league/games` returns `{ league, games, truncated }`, and the MCP `list_games` tool returns the same object. `truncated` is `true` when games may be missing: Kalshi still had a cursor after the page bound (3 pages for `status=all`, 50 otherwise), or more than 100 games matched `status=all` and the extra rows were cut. Kalshi's events endpoint has no date filter in the client's parameters, so `date` is still applied locally after the fetch. `GET /v1/games/:eventKey` sets `truncated: true` when events were skipped (over the 100-event cap, or failed to load).

## 6. Market classification buckets

`src/domain/market-classify.ts` classifies each market by its series ticker. The prefix (`KXNBA`, `KXNFL`, `KXWNBA`) is stripped, and the rest of the name (the body) is tested in this order. The first match wins.

| Bucket | Rule | Examples |
| --- | --- | --- |
| `period` | Body is a period code (`1H`, `2H`, `1Q`-`4Q`, `OT`), alone or followed by `TOTAL`, `SPREAD`, `GAME`, `TEAMTOTAL`, or `FT` | `KXNFL1HTOTAL`, `KXNBA1QSPREAD` |
| `team_total` | Body ends with `TEAMTOTAL` | `KXNBATEAMTOTAL`, `KXNFLTEAMTOTAL` |
| `total` | Body starts or ends with `TOTAL` | `KXNBATOTAL`, `KXNFLTOTAL` |
| `spread` | Body ends with `SPREAD` | `KXNBASPREAD`, `KXNFLSPREAD` |
| `moneyline` | Body is exactly `GAME` | `KXNBAGAME`, `KXNFLGAME` |
| `prop` | Body starts or ends with a known prop token, or is a short token (`FG`, `TO`, `PA`, `PR`, `RA`) on its own | `KXNBAPTS`, `KXNFLPASSYDS`, `KXNFLANYTD` |
| `other` | Anything else | `KXNBAMVP` |

The prop tokens include `PTS`, `REB`, `3PT`, `PRA`, `STOCK`, `FIRSTBASKET`, `YDS`, `PASSYDS`, `ANYTD`, `FIRSTTD`, `TD`, `SACK`, and others listed in the source. `AST`, `REC`, and `INT` count only as a whole body (optionally followed by `PROT`), and stacked box-score stats such as `PTSREBAST` also count, so `KXNBAEAST`, `KXNFLRECORD`, and `KXNBAINTL` are `other`. The period check runs first, which is why `KXNFL1HTOTAL` is a period market and not a total.

In `GET /v1/games/:eventKey`, these buckets appear as `moneyline`, `spread`, `total`, `teamTotal`, `period`, `props`, and `other`.

## 7. Prices and parlay math

Kalshi quotes prices as dollar strings such as `"0.5600"`, for a contract that pays $1 if it wins. The service parses them into numbers and builds a normalized quote with `yesBid`, `yesAsk`, `noBid`, `noAsk`, sizes, `mid`, and `spread`.

**No liquidity.** Kalshi never omits a price. An empty ask appears as `1.0000` and an empty bid as `0.0000`. The service turns these into `null`:

- An ask is `null` if it is `<= 0` or `>= 1`, or if its size is exactly `0`.
- A bid is `null` if it is `<= 0`, or if its size is exactly `0`.
- `mid` and `spread` exist only when both a real YES bid and a real YES ask exist, and are rounded to 4 decimals.

**Buying a side.** Buying YES costs `yesAsk`. Buying NO costs `noAsk`, which is `no_ask_dollars` or, when that field is missing, `1 - yes_bid` rounded to 4 decimals. NO sizes mirror YES sizes: the NO ask size is the YES bid size.

**Parlay math** (`src/domain/parlay-service.ts`):

1. For each leg, load the market and take the ask of the chosen side. That ask is the leg's probability.
2. `combinedProbability` is the product of the leg asks. It is `null` if any leg is missing, has no buyable ask, or has an ask outside `(0, 1)`.
3. `decimalOdds = 1 / combinedProbability`. `payoutPerDollar` equals `decimalOdds` (return including stake). `profitPerDollar = decimalOdds - 1`.
4. `americanOdds` is an integer: `round((decimal - 1) * 100)` when decimal is at least 2, `round(-100 / (decimal - 1))` when it is between 1 and 2, and `null` otherwise.
5. Outputs are rounded: `combinedProbability` to 6 decimals, and `decimalOdds`, `payoutPerDollar` and `profitPerDollar` to 4.

**Worked example.** Leg A is YES at an ask of 0.72. Leg B is YES at an ask of 0.57.

- Combined probability: 0.72 x 0.57 = 0.4104
- Decimal odds: 1 / 0.4104 = 2.437
- American odds: round((2.437 - 1) x 100) = +144
- Per $1 staked: $2.437 returned, $1.437 profit

**What the numbers mean.** The odds are the price to buy: they are built from asks, so they include the bid-ask spread, and they are not vig-free fair odds. The product assumes the legs are independent. Correlated legs get warnings but the math is never adjusted. This is also not a Kalshi combo contract.

**Warnings** (the `warnings` array, exact text):

| Warning | When |
| --- | --- |
| `Parlay needs at least two legs` | Fewer than two legs priced, and fewer than two legs requested |
| `Duplicate ticker {ticker}` | The same ticker appears more than once |
| `Leg {ticker} is {status}` | Market status is not `active` or `open` |
| `Leg {ticker} has no liquidity on {side}` | The chosen side has no buyable ask |
| `Correlated legs share event {eventTicker}` | Two legs on one event ticker |
| `Correlated legs share game {gameKey}` | Two legs on one game, such as moneyline plus spread. The game key is the second hyphen segment of the event ticker (for example `26NOV12WASNYG`) |
| `Leg {ticker} was not found` | Kalshi returned 404 for that ticker. The leg is omitted from `legs` and the combined price is `null` |
| `Parlay not priced: no buyable ask for {ticker side, ...}` | At least one leg cannot be bought, so the price is `null` |

A closed or settled leg that still shows a valid ask is priced and only warned about.

## 8. Caching

The cache (`src/kalshi/ttl-cache.ts` and `cached-client.ts`) is in memory and sits in front of the raw Kalshi client. Each key is the method name plus a stable JSON form of its arguments.

| Data | TTL | Env var |
| --- | --- | --- |
| Series list and single series | 1 hour | `CACHE_TTL_SERIES_MS` |
| Markets, events (including paged `getAll*`), candlesticks | 15 seconds | `CACHE_TTL_MARKETS_MS` |
| Orderbook | 5 seconds | `CACHE_TTL_ORDERBOOK_MS` |
| Live data, live batch, milestones | 5 seconds | `CACHE_TTL_LIVE_MS` |
| Trades (only when no `cursor` is given) | 10 seconds | `CACHE_TTL_TRADES_MS` |
| Exchange status | 10 seconds | not configurable |

Other rules:

- A TTL of `0` disables caching for that group.
- Failures are never cached.
- Concurrent requests for the same key share one in-flight upstream call (when the TTL is above 0).
- The store holds at most `CACHE_MAX_ENTRIES` entries (default 5000). When full, expired entries are dropped first, then the oldest-written ones.
- Portfolio reads (`getBalance`, `getPositions`, `getFills`, `getOrders`, `getSettlements`) bypass the cache entirely: the cached client passes them straight to the raw client, and the portfolio service is built on the raw client. Portfolio responses also carry `Cache-Control: no-store`.
- Parlay pricing bypasses the cache entirely. Game lists and game details can therefore show quotes up to 15 seconds old, while `price_parlay` and `POST /v1/parlays/price` always fetch fresh markets.

## 9. Resilience

**Timeouts and deadline.** Each Kalshi attempt is aborted after `KALSHI_TIMEOUT_MS` (default 8000, allowed 1000 to 60000). The timeout covers headers and body. A whole call, across every attempt and backoff sleep, is also bounded by `KALSHI_DEADLINE_MS` (default 20000, allowed 2000 to 120000). A retry that would finish past the deadline is not started and the backoff never sleeps past it; the call fails with the same 504 `upstream_timeout` as a timeout.

**Signing and retries.** When Kalshi credentials are set, every attempt of every request (market data included) is signed with a fresh timestamp, so a retry never reuses an old signature. The signed path is the URL pathname including `/trade-api/v2`, without the query string.

**Retries.** The client makes up to 4 extra attempts (5 in total) on HTTP `429`, `500`, `502`, `503`, `504`, on timeouts, and on network failures such as a reset or refused connection. The delay is `200ms * 2^attempt` plus up to 100ms of jitter. A numeric `Retry-After` header on a `429` or `503` replaces that delay, capped at 5 seconds. Other `4xx` responses are not retried. If the last attempt is still a network failure, the client throws a status-0 error whose message never includes the underlying cause. The retry count is not configurable by environment variable. A single call can lower its own budget: related events in `getGame` are fetched with at most 1 retry because they are optional data. On the server log, a network error records only the system code (for example `ECONNREFUSED`), never the full error text.

**Pagination.** The `getAll*` methods follow Kalshi cursors. They stop when the cursor is empty, when a cursor repeats, or after `maxPages` pages (default and maximum 50). Page sizes are 200 events, 1000 markets, and 500 milestones, and any `limit` is clamped to Kalshi's caps. `getAllEvents` accepts a `maxPages` option, and `listGames` with `status=all` uses `maxPages: 3` (up to 600 events at 200 per page). When a capped fetch leaves a cursor behind, `listGames` reports it as `truncated: true` instead of dropping the remainder silently.

**Error mapping** (`src/http/error-handler.ts`). Every error body is `{ "error": "<code>", "message": "<text>" }`. Stacks, Kalshi paths, and Kalshi response bodies are never returned. They are logged on the server (Kalshi errors log only status and path).

| Status | `error` code | Cause |
| --- | --- | --- |
| 400 | `bad_request` | Invalid query or body (zod), bad date, unknown league, Kalshi `400`, malformed JSON |
| 401 | `unauthorized` | Missing or invalid bearer token |
| 404 | `not_found` | Unknown route, Kalshi `404`, or a milestone with no game event |
| 403 | `forbidden` | `PORTFOLIO_API_KEYS` is set and the caller's key is not in it (portfolio routes only) |
| 413 | `bad_request` | Body larger than 32 kB |
| 429 | `rate_limited` | Our own anonymous or per-key limiter |
| 500 | `internal_error` | Any unexpected error. Message is always `Internal server error` |
| 502 | `upstream_error` | Kalshi failed after retries, was unreachable (network error), or returned another non-OK status or unparseable body |
| 502 | `upstream_rate_limited` | Kalshi kept returning `429` (kept distinct from our own `429`) |
| 502 | `upstream_auth_failed` | Kalshi answered `401` or `403` to a signed request: wrong key id or private key, key lacks access, or the server clock is off. The message is fixed (`Kalshi rejected the API credentials`) and the Kalshi body is never shown or logged |
| 503 | `portfolio_not_configured` | A portfolio route was called but no Kalshi credentials are set |
| 504 | `upstream_timeout` | Every attempt timed out |

Candle range failures are the one validation case whose message is shown: `end_ts must be after start_ts` and `range spans more than 5000 candles`.

**MCP errors** are returned as tool results with `isError: true` and a short text message. Only our own domain messages (`date must be YYYY-MM-DD`, `Unknown league ...`, `Milestone ... has no game event`) and the candle-range messages are passed through; any other error becomes `Internal server error`, so raw exception text is never exposed. Typical messages are `Not found`, `Upstream request failed` (also used for network errors), `Upstream request timed out`, `Kalshi rate limited the request`, `Kalshi rejected the API credentials`, and `Portfolio access is not configured`.

**Fan-out and size caps:**

| Operation | Cap |
| --- | --- |
| `getGame` | At most 100 events (the root plus 99 more), 4 fetched at a time. `truncated: true` is set when events were skipped or a related event failed to load (404, timeout, upstream error). Primary events load before related ones. A failed live lookup gives `live: null` |
| `listGames` | `status=all` reads at most 3 event pages and keeps at most 100 games (after the date filter). It fetches each game's spread and total events, 4 at a time. `status=open` has no game-count cap but still stops at 50 pages. `truncated: true` is returned whenever a cap dropped data |
| Candlesticks | `end_ts > start_ts` and at most 5000 candles, where candles = `(end_ts - start_ts) / (interval x 60)` |
| Trades | `limit` 1 to 1000 |
| Live batch | 1 to 100 milestone IDs per request |
| Parlay | 1 to 12 legs, 5 markets fetched at a time |

## 10. REST endpoints and MCP tools

REST, all under `/v1` unless noted. `:league` is `nba` or `nfl` (case-insensitive). See `README.md` for query parameters and examples.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness check, no auth |
| GET | `/v1/exchange/status` | Whether Kalshi's exchange is up |
| GET | `/v1/leagues/:league/series` | Sports series that belong to the league |
| GET | `/v1/leagues/:league/games` | Games with moneyline, spread, and total (`date`, `status`) |
| GET | `/v1/games/:eventKey` | One game with all markets bucketed, plus live data |
| GET | `/v1/markets/:ticker` | One market with a normalized quote |
| GET | `/v1/markets/:ticker/orderbook` | Fixed-point book plus best YES and NO bids |
| GET | `/v1/markets/:ticker/trades` | Recent trades (`limit`, `cursor`, `min_ts`, `max_ts`) |
| GET | `/v1/markets/:ticker/candlesticks` | Candles (`interval` 1, 60, or 1440; `start_ts`; `end_ts`) |
| GET | `/v1/live/:milestoneId` | Live snapshot for one milestone |
| POST | `/v1/live/batch` | Live snapshots for up to 100 milestones |
| POST | `/v1/parlays/price` | Ask-based parlay price for 1 to 12 legs |
| GET | `/v1/portfolio/balance` | Cash balance and portfolio value in dollars. Needs Kalshi credentials |
| GET | `/v1/portfolio/positions` | Positions by market and event (`settlement_status`, `count_filter`, `ticker`, `event_ticker`, `limit`, `cursor`) |
| GET | `/v1/portfolio/fills` | Fills (`ticker`, `order_id`, `min_ts`, `max_ts`, `limit`, `cursor`) |
| GET | `/v1/portfolio/orders` | Orders (`status`, `ticker`, `event_ticker`, `min_ts`, `max_ts`, `limit`, `cursor`) |
| GET | `/v1/portfolio/settlements` | Settled markets (`ticker`, `event_ticker`, `min_ts`, `max_ts`, `limit`, `cursor`) |

The portfolio routes are the only ones that read an account. Without Kalshi credentials they answer `503 portfolio_not_configured`; with `PORTFOLIO_API_KEYS` set they answer `403 forbidden` to other keys. All portfolio responses, errors included, carry `Cache-Control: no-store`. Every portfolio route also takes `subaccount` (and, except settlements, `exchange_index`). `limit` is 1 to 1000. Pass the returned `cursor` back to get the next page. There are no routes that place, amend, or cancel orders: any other method or path under `/v1/portfolio` is a `404`.

Money fields are numbers in dollars (Kalshi's integer cents are divided by 100) and contract counts are numbers, matching the quote conventions in section 7. The field names are camelCase, for example `marketPositions[].marketExposure` and `settlements[].revenue`. A value Kalshi did not send is `null`. Raw Kalshi rows, including deprecated fields and user ids, are not passed through.

MCP tools at `/mcp`:

| Tool | Purpose |
| --- | --- |
| `exchange_status` | Whether Kalshi is accepting trades |
| `list_games` | List NBA or NFL games (`league`, `date`, `status`). Returns `{ league, games, truncated }` |
| `get_game_markets` | One game by GAME ticker or milestone UUID, markets bucketed |
| `get_market` | Compact quote for one market |
| `get_orderbook` | Fixed-point order book for one market |
| `get_candlesticks` | Candles for one market (`interval` as a number: 1, 60, 1440) |
| `get_trades` | Trades for one market |
| `get_live_game` | Live snapshot for one milestone |
| `price_parlay` | Price to buy a parlay from current asks, 1 to 12 legs. Includes the spread and assumes the legs are independent |

When Kalshi credentials are set, five more read-only tools exist for callers allowed to read the portfolio:

| Tool | Purpose |
| --- | --- |
| `get_balance` | Cash balance and portfolio value in dollars |
| `get_positions` | Positions by market and event |
| `get_fills` | Fills |
| `get_orders` | Orders (`status` is `resting`, `canceled`, or `executed`) |
| `get_settlements` | Settled markets and payouts |

They are registered per request: the MCP handler picks a server with or without them by the caller's API key index, so without credentials, or for a key outside `PORTFOLIO_API_KEYS`, the tools are not listed and cannot be called. Their errors use the same safe message path as the other tools.

The MCP side has no tools for the series list or batch live data, and `get_orderbook` returns only the raw book without the `best_yes_bid` and `best_no_bid` helpers that REST adds.

## 11. Configuration

Set through environment variables. A `.env` file is loaded if present. Blank values fall back to the default.

| Variable | Default | Rules |
| --- | --- | --- |
| `API_KEYS` | none, required | Comma-separated, each at least 32 characters. Any key containing `replace-me` is rejected |
| `PORT` | `3000` | Integer, 0 or more |
| `KALSHI_BASE_URL` | `https://external-api.kalshi.com/trade-api/v2` | Must be a valid URL. This production host serves both public and signed calls |
| `KALSHI_API_KEY_ID` | none | Kalshi API key id. Set together with a private key, or not at all |
| `KALSHI_PRIVATE_KEY` | none | Kalshi private key as a multiline PEM, a PEM with literal `\n` escapes, or base64 of the PEM. RSA or Ed25519, no passphrase. Not allowed together with `KALSHI_PRIVATE_KEY_PATH` |
| `KALSHI_PRIVATE_KEY_PATH` | none | Path to a PEM file, read once at startup. Alternative to `KALSHI_PRIVATE_KEY` |
| `PORTFOLIO_API_KEYS` | none (all `API_KEYS`) | Comma-separated subset of `API_KEYS` allowed to read the portfolio, each at least 32 characters |
| `KALSHI_TIMEOUT_MS` | `8000` | 1000 to 60000 |
| `KALSHI_DEADLINE_MS` | `20000` | 2000 to 120000 |
| `CACHE_MAX_ENTRIES` | `5000` | 100 to 100000 |
| `CACHE_TTL_SERIES_MS` | `3600000` | 0 or more (0 disables) |
| `CACHE_TTL_MARKETS_MS` | `15000` | 0 or more |
| `CACHE_TTL_ORDERBOOK_MS` | `5000` | 0 or more |
| `CACHE_TTL_LIVE_MS` | `5000` | 0 or more |
| `CACHE_TTL_TRADES_MS` | `10000` | 0 or more |
| `RATE_LIMIT_WINDOW_MS` | `60000` | 1 or more |
| `RATE_LIMIT_MAX` | `120` | 1 or more, requests per key per window |
| `RATE_LIMIT_ANON_MAX` | `30` | 1 or more, requests without a valid key per IP per window |

The placeholder `API_KEYS` value in `.env.example` is rejected at startup (any key containing `replace-me` fails with a message telling you to generate a real one), so copying the file unchanged will not boot the server. Replace it with a generated key first.

## 12. Deployment on Railway

The `Dockerfile` is a two-stage build on `node:22-alpine`. The build stage runs `npm ci` and `npm run build`, then prunes dev dependencies. The runtime stage copies `node_modules` and `dist`, runs as the unprivileged `node` user, and starts with `node dist/index.js`. `railway.json` selects the Dockerfile builder, sets the health check to `/health` with a 30-second timeout, restarts on failure up to 10 times, and sets `drainingSeconds` to 10 (the gap between SIGTERM and SIGKILL, matching the app's own 10-second forced exit).

To deploy:

1. Create the Railway project from this directory.
2. Set `API_KEYS` in the service variables. Never commit keys. Other variables are optional. For portfolio access also set the Kalshi variables (section 13).
3. Railway provides `PORT`. The server binds `0.0.0.0`.
4. Generate a public domain. REST lives at `https://<domain>/v1/...` and MCP at `https://<domain>/mcp`.

On `SIGTERM` or `SIGINT` the server stops accepting connections and exits once they close, forcing exit after 10 seconds.

To connect an MCP client, configure the URL `https://<domain>/mcp` and an HTTP header `Authorization: Bearer <key>`. The JSON snippet is in `README.md`. The transport is HTTP only. There is no stdio mode.

## 13. Kalshi credentials

Credentials are optional. Without them the service behaves as before: public market data only, unsigned requests, and the portfolio routes and tools are off. With them, two things change: every Kalshi request is signed (which ties the traffic to your account's rate limits instead of the anonymous ones), and the read-only portfolio endpoints and MCP tools turn on.

**How signing works** (`src/kalshi/kalshi-signer.ts`). Each request carries three headers:

| Header | Value |
| --- | --- |
| `KALSHI-ACCESS-KEY` | The key id |
| `KALSHI-ACCESS-TIMESTAMP` | Current time in milliseconds |
| `KALSHI-ACCESS-SIGNATURE` | Base64 signature of `timestamp + METHOD + path` |

The path is the full URL pathname including the `/trade-api/v2` prefix and excluding the query string, for example `/trade-api/v2/portfolio/orders` even when the request is `...orders?limit=5`. RSA keys sign with RSA-PSS (SHA-256, MGF1-SHA256, salt length equal to the digest length). Ed25519 keys sign the text directly. The key type is detected from the parsed key, not the PEM header, because PKCS#8 RSA keys and Ed25519 keys both start with `-----BEGIN PRIVATE KEY-----`. Kalshi recommends Ed25519 and generates it by default; RSA keys also work. A new timestamp and signature are made for every attempt, including retries.

**Creating a key.** Sign in at kalshi.com, open Account settings (profile) and go to API Keys, then choose Create New API Key. Kalshi shows the key id and the private key once; the private key cannot be retrieved later, so copy it before closing the page. You can instead register your own public key (`openssl genpkey -algorithm ed25519 -out kalshi.key`, then paste the public key) and keep the private key yourself.

**Setting it locally.** Put the key id in `KALSHI_API_KEY_ID`, and the private key in one of:

- `KALSHI_PRIVATE_KEY_PATH=/path/to/kalshi.pem` (file read at startup), or
- `KALSHI_PRIVATE_KEY` as a multiline PEM, a single line with literal `\n` escapes, or base64 of the PEM (any value without `-----BEGIN` is treated as base64).

Setting both `KALSHI_PRIVATE_KEY` and `KALSHI_PRIVATE_KEY_PATH` is an error, and so is setting the key id without a key or a key without the key id.

**Setting it on Railway.** Add `KALSHI_API_KEY_ID` and `KALSHI_PRIVATE_KEY` as service variables. For the key, either paste the whole PEM, line breaks included, into the variable's multiline field, or avoid newline handling entirely by base64-encoding it and pasting the single line:

```bash
base64 -w0 kalshi.pem
```

On macOS use `base64 -i kalshi.pem | tr -d '\n'`. Redeploy after changing variables. Optionally set `PORTFOLIO_API_KEYS` so only some bearer keys can read the account.

**Startup checks.** The key is parsed once with `crypto.createPrivateKey`. A bad or unreadable key stops startup with a message that names the variable and the problem but never contains the key text or the parser's own message. The server then logs one line: `kalshi auth: enabled (key abcd…)` (the first four characters of the key id, or `****` when the id is 8 characters or fewer) or `kalshi auth: disabled (public data only)`. The private key and full key id are never logged.

**Failures at runtime.** If Kalshi answers `401` or `403`, the client does not retry and the API returns `502 upstream_auth_failed` with a fixed message. Check the key id, the private key, that the key still exists in Kalshi, and the server clock (the timestamp must be close to real time). Kalshi's balance endpoint has its own tight limit (about one call per second on lower tiers), so polling it can return `502 upstream_rate_limited`.

**What it does not do.** There are no order placement, amend, or cancel endpoints or tools, and none are planned here. A Kalshi API key that has write access can still place orders from elsewhere, so keep the private key in Railway variables and never commit it. `.env.example` lists the variables as commented placeholders.

## 14. Limitations and out of scope

- No trading or order placement. Account access is read-only and only when Kalshi credentials are set.
- Portfolio data covers what Kalshi keeps in its live data set. Older fills, orders, and settled positions are in Kalshi's historical endpoints, which this service does not call.
- No Kalshi native combos (multivariate collections). A parlay here is a calculation, not a contract you can buy as one.
- The cache and both rate limiters are in memory in a single process. Running several replicas gives each its own cache and its own counters, so limits are not shared.
- Parlay math assumes the legs are independent. Correlated legs are flagged, not corrected. Odds include the spread and are not vig-free.
- Classification is heuristic and based on series names. A new or oddly named series may land in `other`.
- A capped list fetch (`maxPages` or the 100-game cap) can omit games. The response says so with `truncated: true`, but the missing games are not retrievable except by narrowing the query. Game lists can be up to 15 seconds stale.
- Only NBA and NFL are supported, and there is no WebSocket streaming.
