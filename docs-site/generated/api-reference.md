---
title: API reference
description: Generated from the committed OpenAPI contract and api-index.
generated: true
contract_version: 2026-07-01.1
openapi_url: https://api.metagraph.sh/metagraph/openapi.json
playground_base: https://api.metagraph.sh
---

# API reference

Every route below is generated from `public/metagraph/api-index.json` and `public/metagraph/openapi.json` (contract `2026-07-01.1`). Responses use the standard envelope `{ ok, data, meta, error }` — see [Auth & rate limits](../guides/auth-and-rate-limits.md).

Download the machine contract: [openapi.json](https://api.metagraph.sh/metagraph/openapi.json) · typed clients: [@jsonbored/metagraphed](https://www.npmjs.com/package/@jsonbored/metagraphed) · [metagraphed on PyPI](https://pypi.org/project/metagraphed/)

## accounts

### `GET /api/v1/accounts/{ss58}`

Fetch a cross-subnet activity summary for one account (hotkey or coldkey): chain-event aggregates joined to its current subnet registrations + stake. Computed live from the account_events + neurons D1 tiers.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/accounts/5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM'
```

<!-- playground:
{"id":"account-summary","method":"GET","path":"/api/v1/accounts/{ss58}"}
-->

### `GET /api/v1/accounts/{ss58}/balance`

Fetch the live TAO balance (free + reserved, in TAO) for one account, queried from the finney RPC at request time with 60s KV cache. Returns 400 on invalid ss58; balance_tao is null on RPC failure (200, consistent with blocks/extrinsics null-on-miss).

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/accounts/5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM/balance'
```

<!-- playground:
{"id":"account-balance","method":"GET","path":"/api/v1/accounts/{ss58}/balance"}
-->

### `GET /api/v1/accounts/{ss58}/counterparties`

Fetch the per-counterparty fund-flow rollup for one account — or, with ?counterparty=<ss58>, pair-level native-TAO transfer evidence for one relationship — computed live from the account_events D1 tier. ?counterparty switches the route from ranked list mode into relationship drilldown mode; ?limit is 1-100, default 20 in list mode, and default 50 when ?counterparty is present.

**Query parameters**

- `counterparty` (string)
- `limit` (integer)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/accounts/5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM/counterparties'
```

<!-- playground:
{"id":"account-counterparties","method":"GET","path":"/api/v1/accounts/{ss58}/counterparties"}
-->

### `GET /api/v1/accounts/{ss58}/events`

Fetch the paginated first-party chain-event history for one account (hotkey or coldkey), newest first. Optional ?kind= filter and ?block_start/?block_end (block-height range); ?limit (<=1000) / ?offset, or ?cursor= for stable keyset paging (#1851).

**Query parameters**

- `kind` (string)
- `block_start` (integer)
- `block_end` (integer)
- `limit` (integer)
- `offset` (integer)
- `cursor` (string)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/accounts/5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM/events'
```

<!-- playground:
{"id":"account-events","method":"GET","path":"/api/v1/accounts/{ss58}/events"}
-->

### `GET /api/v1/accounts/{ss58}/extrinsics`

Fetch the extrinsics this account signed (matched by signer), newest first, computed live from the extrinsics D1 tier. Optional ?block_start/?block_end (block-height range); ?limit (<=1000) / ?offset, or ?cursor= for stable keyset paging.

**Query parameters**

- `block_start` (integer)
- `block_end` (integer)
- `limit` (integer)
- `offset` (integer)
- `cursor` (string)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/accounts/5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM/extrinsics'
```

<!-- playground:
{"id":"account-extrinsics","method":"GET","path":"/api/v1/accounts/{ss58}/extrinsics"}
-->

### `GET /api/v1/accounts/{ss58}/history`

Fetch the durable per-day activity series for one account, newest day first, from the hotkey-keyed account_events_daily rollup (#1854). An ss58 with no hotkey activity returns zero days, since the rollup is hotkey-attributed (unlike /events, which matches the hotkey or coldkey). ?netuid filters to one subnet; ?from / ?to are YYYY-MM-DD bounds; ?limit (<=1000) / ?offset.

**Query parameters**

- `netuid` (integer)
- `from` (string)
- `to` (string)
- `limit` (integer)
- `offset` (integer)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/accounts/5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM/history'
```

<!-- playground:
{"id":"account-history","method":"GET","path":"/api/v1/accounts/{ss58}/history"}
-->

### `GET /api/v1/accounts/{ss58}/stake-flow`

Fetch one account's StakeAdded vs StakeRemoved flow per subnet over a recent window (7d/30d/90d): per-subnet net and gross flow with a direction label (accumulating/exiting/churning/idle), plus account totals, an HHI concentration of where the flow is focused, and the dominant subnet — summed live from the account_events D1 tier.

**Query parameters**

- `window` (enum)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/accounts/5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM/stake-flow'
```

<!-- playground:
{"id":"account-stake-flow","method":"GET","path":"/api/v1/accounts/{ss58}/stake-flow"}
-->

### `GET /api/v1/accounts/{ss58}/subnets`

Fetch the subnets where an account's hotkey is currently registered (its cross-subnet footprint), computed live from the neurons D1 tier.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/accounts/5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM/subnets'
```

<!-- playground:
{"id":"account-subnets","method":"GET","path":"/api/v1/accounts/{ss58}/subnets"}
-->

### `GET /api/v1/accounts/{ss58}/transfers`

Fetch the native-TAO Balances.Transfer feed for one account, newest first, computed live from the account_events D1 tier. ?direction=all|sent|received; optional ?block_start/?block_end (block-height range); ?limit (<=1000) / ?offset, or ?cursor= for stable keyset paging.

**Query parameters**

- `direction` (enum)
- `block_start` (integer)
- `block_end` (integer)
- `limit` (integer)
- `offset` (integer)
- `cursor` (string)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/accounts/5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM/transfers'
```

<!-- playground:
{"id":"account-transfers","method":"GET","path":"/api/v1/accounts/{ss58}/transfers"}
-->

## adapters

### `GET /api/v1/adapters/{slug}`

Fetch adapter-backed public metrics.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/adapters/allways'
```

<!-- playground:
{"id":"adapter","method":"GET","path":"/api/v1/adapters/{slug}"}
-->

## agent-catalog

### `GET /api/v1/agent-catalog`

List subnets exposing callable services for AI agents (compact capability index).

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/agent-catalog'
```

<!-- playground:
{"id":"agent-catalog","method":"GET","path":"/api/v1/agent-catalog"}
-->

### `GET /api/v1/agent-catalog/{netuid}`

Fetch the callable-services catalog for one subnet (each service with its schema + health).

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/agent-catalog/7'
```

<!-- playground:
{"id":"agent-catalog-subnet","method":"GET","path":"/api/v1/agent-catalog/{netuid}"}
-->

## agent-resources

### `GET /api/v1/agent-resources`

Fetch the AI-resources index: the copyable agent (/agent.md), the MCP server + its tools, the skill, llms.txt, OpenAPI, and the agent-facing APIs.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/agent-resources'
```

<!-- playground:
{"id":"agent-resources","method":"GET","path":"/api/v1/agent-resources"}
-->

## blocks

### `GET /api/v1/blocks`

Fetch the recent-block feed (newest first) for the block explorer; ?limit (<=100) / ?offset, or ?cursor= for stable keyset paging under head-of-chain inserts (#1851). A conjunctive (AND-ed) filter set (#1991) narrows the feed: ?author=<ss58>, ?spec_version=<n>, ?from / ?to (observed_at epoch-ms), ?block_start / ?block_end (height range), ?min_extrinsics / ?min_events (non-empty blocks). Computed live from the first-party blocks D1 tier (#1345).

**Query parameters**

- `limit` (integer)
- `offset` (integer)
- `cursor` (string)
- `author` (string)
- `spec_version` (integer)
- `from` (integer)
- `to` (integer)
- `block_start` (integer)
- `block_end` (integer)
- `min_extrinsics` (integer)
- `min_events` (integer)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/blocks'
```

<!-- playground:
{"id":"blocks-feed","method":"GET","path":"/api/v1/blocks"}
-->

### `GET /api/v1/blocks/{ref}`

Fetch per-block detail by numeric block_number or 0x block_hash. Computed live from the first-party blocks D1 tier (#1345); 200 with block:null when cold/unknown.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/blocks/0'
```

<!-- playground:
{"id":"block-detail","method":"GET","path":"/api/v1/blocks/{ref}"}
-->

### `GET /api/v1/blocks/{ref}/chain-events`

Fetch every raw pallet-level event in one block (by numeric block_number; event_index ascending) from the Postgres-backed all-events tier (ADR 0013). Distinct from /api/v1/blocks/{ref}/events (the curated account-attributed D1 stream). Served live (no static file); empty (count:0, events:[]) when the block is unknown or before the all-events backfill runs.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/blocks/0/chain-events'
```

<!-- playground:
{"id":"block-chain-events","method":"GET","path":"/api/v1/blocks/{ref}/chain-events"}
-->

### `GET /api/v1/blocks/{ref}/events`

Fetch the decoded chain events in one block (by numeric block_number or 0x block_hash), in natural order; ?limit (<=1000) / ?offset. Computed live from the first-party account_events D1 tier filtered by block_number (#1852); 200 with events:[] when cold/unknown.

**Query parameters**

- `limit` (integer)
- `offset` (integer)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/blocks/0/events'
```

<!-- playground:
{"id":"block-events","method":"GET","path":"/api/v1/blocks/{ref}/events"}
-->

### `GET /api/v1/blocks/{ref}/extrinsics`

Fetch the extrinsics in one block (by numeric block_number or 0x block_hash), in natural order; ?limit (<=100) / ?offset. Computed live from the first-party extrinsics D1 tier (#1845); 200 with extrinsics:[] when cold/unknown.

**Query parameters**

- `limit` (integer)
- `offset` (integer)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/blocks/0/extrinsics'
```

<!-- playground:
{"id":"block-extrinsics","method":"GET","path":"/api/v1/blocks/{ref}/extrinsics"}
-->

## build

### `GET /api/v1/build`

Fetch generated build summary.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/build'
```

<!-- playground:
{"id":"build","method":"GET","path":"/api/v1/build"}
-->

## candidates

### `GET /api/v1/candidates`

List unpromoted candidate surfaces.

**Query parameters**

- `netuid` (integer)
- `kind` (enum)
- `provider` (string)
- `state` (enum)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/candidates?limit=3'
```

<!-- playground:
{"id":"candidates","method":"GET","path":"/api/v1/candidates"}
-->

## chain

### `GET /api/v1/chain/activity`

Fetch daily network-activity aggregates (extrinsic/event/block counts, success rate, unique signers) over a 7d or 30d window, newest day first. Computed live from the first-party chain D1 tiers (#1987); schema-stable day_count:0/days:[] when the store is cold.

**Query parameters**

- `window` (enum)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/chain/activity'
```

<!-- playground:
{"id":"chain-activity","method":"GET","path":"/api/v1/chain/activity"}
-->

### `GET /api/v1/chain/calls`

Fetch the extrinsic call-mix breakdown (count + share per call_module, or call_module/call_function with group_by=module_function) over a 7d or 30d window, optionally scoped to one pallet with ?call_module=. When scoped, total_extrinsics and share use the scoped module denominator. Computed live from the first-party extrinsics D1 tier (#1989); schema-stable call_count:0/calls:[] when cold.

**Query parameters**

- `window` (enum)
- `group_by` (enum)
- `limit` (integer)
- `call_module` (string)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/chain/calls'
```

<!-- playground:
{"id":"chain-calls","method":"GET","path":"/api/v1/chain/calls"}
-->

### `GET /api/v1/chain/concentration`

Fetch network-wide stake and emission concentration metrics (Gini, HHI, Nakamoto coefficient, top-percentile shares, entropy) aggregated across all subnets' neurons over three lenses (per-UID, per-entity with coldkeys collapsed across subnets into the network control distribution, and validator-only consensus power), computed live from the neurons D1 tier; schema-stable nulls when cold.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/chain/concentration'
```

<!-- playground:
{"id":"chain-concentration","method":"GET","path":"/api/v1/chain/concentration"}
-->

### `GET /api/v1/chain/fees`

Fetch fee/tip market analytics — a per-UTC-day fee series (totals, averages, and exact ordered-offset medians) plus a windowed top-fee-payer list — over a 7d or 30d window, optionally scoped to one pallet with ?call_module=. Computed live from the first-party extrinsics D1 tier (#1988); schema-stable day_count:0 + empty lists when cold.

**Query parameters**

- `window` (enum)
- `limit` (integer)
- `call_module` (string)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/chain/fees'
```

<!-- playground:
{"id":"chain-fees","method":"GET","path":"/api/v1/chain/fees"}
-->

### `GET /api/v1/chain/signers`

Fetch the windowed most-active-account leaderboard (signers ranked by ?sort=tx_count or ?sort=total_fee_tao, with total fees/tips + newest signed block) over a 7d or 30d window, optionally scoped to one pallet with ?call_module=. Computed live from the first-party extrinsics D1 tier (#1990); schema-stable signer_count:0/signers:[] when cold.

**Query parameters**

- `window` (enum)
- `sort` (enum)
- `limit` (integer)
- `call_module` (string)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/chain/signers'
```

<!-- playground:
{"id":"chain-signers","method":"GET","path":"/api/v1/chain/signers"}
-->

### `GET /api/v1/chain/transfers`

Fetch network-wide native-TAO transfer analytics over a 7d or 30d window: total Balances.Transfer volume + count, distinct senders/receivers, the top senders and receivers ranked by volume (?limit, <=100), and the top senders' share of total volume. Computed live from the account_events Transfer feed; schema-stable zeros + empty leaderboards when cold.

**Query parameters**

- `window` (enum)
- `limit` (integer)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/chain/transfers'
```

<!-- playground:
{"id":"chain-transfers","method":"GET","path":"/api/v1/chain/transfers"}
-->

## chain-events

### `GET /api/v1/chain-events`

Fetch the recent all-events feed (newest first) from the Postgres-backed all-events tier (ADR 0013) — every raw pallet.method event, distinct from the curated account-attributed stream. ?pallet / ?method narrow by event id (1-64 ASCII identifier chars; ?method requires ?pallet unless ?block is set); ?block (+ optional ?extrinsic) scopes to one block or extrinsic; ?cursor is the lossless block_number.event_index keyset cursor and ?before is the legacy block_number-only cursor; ?limit caps the page (<=200, default 50). Served live (no static file); empty (count:0, events:[]) before the all-events backfill runs.

**Query parameters**

- `pallet` (string)
- `method` (string)
- `block` (integer)
- `extrinsic` (integer)
- `cursor` (string)
- `before` (integer)
- `limit` (integer)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/chain-events'
```

<!-- playground:
{"id":"chain-events-feed","method":"GET","path":"/api/v1/chain-events"}
-->

### `GET /api/v1/chain-events/stats`

Fetch the chain-activity aggregate — the pallet.method event distribution over the most recent N blocks — from the Postgres-backed all-events tier (ADR 0013). ?blocks sets the window (default 1000, capped 5000); activity is ordered by count descending (top 100). Backs the get_chain_activity MCP tool. Served live (no static file); empty (groups:0, activity:[]) before the all-events backfill runs.

**Query parameters**

- `blocks` (integer)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/chain-events/stats'
```

<!-- playground:
{"id":"chain-events-stats","method":"GET","path":"/api/v1/chain-events/stats"}
-->

## changelog

### `GET /api/v1/changelog`

Fetch latest generated change summary.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/changelog'
```

<!-- playground:
{"id":"changelog","method":"GET","path":"/api/v1/changelog"}
-->

## compare

### `GET /api/v1/compare`

Compare several subnets side by side across the registry structure (completeness + surface counts), the live economics tier, and the live per-subnet health rollup — one call, requested order. `netuids` is a required comma-separated list of 1-128 subnet ids; `dimensions` selects a subset of structure,economics,health (default all). Composed live (no static file); for choosing between subnets without N separate detail/economics/health fetches.

**Query parameters**

- `netuids` (string)
- `dimensions` (string)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/compare?netuids=7%2C8'
```

<!-- playground:
{"id":"compare","method":"GET","path":"/api/v1/compare"}
-->

## contracts

### `GET /api/v1/contracts`

Fetch artifact contract metadata.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/contracts'
```

<!-- playground:
{"id":"contracts","method":"GET","path":"/api/v1/contracts"}
-->

## coverage

### `GET /api/v1/coverage`

Fetch registry coverage summary.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/coverage'
```

<!-- playground:
{"id":"coverage","method":"GET","path":"/api/v1/coverage"}
-->

## coverage-depth

### `GET /api/v1/coverage-depth`

Fetch the machine-usable coverage depth scorecard and ranked enrichment queue.

**Query parameters**

- `netuid` (integer)
- `tier` (enum)
- `agent_status` (enum)
- `blocker_level` (enum)
- `q` (string)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/coverage-depth'
```

<!-- playground:
{"id":"coverage-depth","method":"GET","path":"/api/v1/coverage-depth"}
-->

## curation

### `GET /api/v1/curation`

Fetch curation states by subnet.

**Query parameters**

- `netuid` (integer)
- `coverage_level` (enum)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/curation'
```

<!-- playground:
{"id":"curation","method":"GET","path":"/api/v1/curation"}
-->

## economics

### `GET /api/v1/economics`

List per-subnet validator and economic metrics (counts, stake, registration cost, alpha price, alpha market-cap proxy, emission share, and registration block height). Default order is emission share descending. Filter by netuid/registration_allowed, search by name/slug, and sort with `sort=<field>&order=asc|desc` — the two are separate parameters (e.g. `?sort=alpha_market_cap_tao&order=desc` or `?sort=block&order=asc`), NOT a combined `field:desc` token.

**Query parameters**

- `netuid` (integer)
- `registration_allowed` (enum)
- `q` (string)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/economics'
```

<!-- playground:
{"id":"economics","method":"GET","path":"/api/v1/economics"}
-->

### `GET /api/v1/economics/trends`

Fetch the network-wide economics time series (#1307): per UTC day across all subnets — total stake, stake-weighted + median alpha price, total validator/miner counts, and mean emission share — aggregated live from the daily subnet_snapshots D1 rollup (the same source the per-subnet /trajectory reads). ?window=7d|30d|90d|1y|all (default 30d). Served live (no static file); day_count:0 / days:[] when the rollup is cold.

**Query parameters**

- `window` (enum)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/economics/trends'
```

<!-- playground:
{"id":"economics-trends","method":"GET","path":"/api/v1/economics/trends"}
-->

## endpoint-incidents

### `GET /api/v1/endpoint-incidents`

Fetch probe-derived endpoint incidents.

**Query parameters**

- `netuid` (integer)
- `kind` (enum)
- `provider` (string)
- `status` (enum)
- `severity` (enum)
- `state` (enum)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/endpoint-incidents'
```

<!-- playground:
{"id":"endpoint-incidents","method":"GET","path":"/api/v1/endpoint-incidents"}
-->

## endpoint-pools

### `GET /api/v1/endpoint-pools`

Fetch generalized endpoint pool scores.

**Query parameters**

- `id` (string)
- `kind` (enum)
- `min_eligible_count` (number)
- `max_eligible_count` (number)
- `min_endpoint_count` (number)
- `max_endpoint_count` (number)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/endpoint-pools'
```

<!-- playground:
{"id":"endpoint-pools","method":"GET","path":"/api/v1/endpoint-pools"}
-->

## endpoints

### `GET /api/v1/endpoints`

List generalized endpoint resources and monitored public surfaces.

**Query parameters**

- `kind` (enum)
- `layer` (enum)
- `netuid` (integer)
- `pool_eligible` (enum)
- `provider` (string)
- `publication_state` (enum)
- `status` (enum)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/endpoints?limit=3'
```

<!-- playground:
{"id":"endpoints","method":"GET","path":"/api/v1/endpoints"}
-->

## evidence

### `GET /api/v1/evidence`

Fetch public evidence ledger.

**Query parameters**

- `q` (string)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/evidence'
```

<!-- playground:
{"id":"evidence","method":"GET","path":"/api/v1/evidence"}
-->

## extrinsics

### `GET /api/v1/extrinsics`

Fetch the recent-extrinsic feed (newest first) for the block explorer; ?limit (<=100) / ?offset (or ?cursor= for stable keyset paging, #1851) and a conjunctive filter set (#1846): ?block=<n>, ?signer=, ?call_module=, ?call_function=, ?success=true|false, ?block_start/?block_end (block range), ?from/?to (observed_at epoch-ms range). Computed live from the first-party extrinsics D1 tier (#1345).

**Query parameters**

- `limit` (integer)
- `offset` (integer)
- `cursor` (string)
- `block` (integer)
- `signer` (string)
- `call_module` (string)
- `call_function` (string)
- `success` (enum)
- `block_start` (integer)
- `block_end` (integer)
- `from` (integer)
- `to` (integer)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/extrinsics'
```

<!-- playground:
{"id":"extrinsics-feed","method":"GET","path":"/api/v1/extrinsics"}
-->

### `GET /api/v1/extrinsics/{hash}`

Fetch per-extrinsic detail by 0x extrinsic_hash OR the composite <block_number>-<extrinsic_index> id (the guaranteed-present identifier, since the hash is best-effort/nullable). Computed live from the first-party extrinsics D1 tier (#1345/#1848); 200 with extrinsic:null when cold/unknown/malformed.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/extrinsics/0x0000000000000000000000000000000000000000000000000000000000000000'
```

<!-- playground:
{"id":"extrinsic-detail","method":"GET","path":"/api/v1/extrinsics/{hash}"}
-->

## fixtures

### `GET /api/v1/fixtures`

Fetch the index of captured live request/response fixtures (which surfaces carry a sanitized sample). Fetch one with get_fixture / GET /metagraph/fixtures/{surface_id}.json.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/fixtures'
```

<!-- playground:
{"id":"fixtures","method":"GET","path":"/api/v1/fixtures"}
-->

## freshness

### `GET /api/v1/freshness`

Fetch freshness and staleness state.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/freshness'
```

<!-- playground:
{"id":"freshness","method":"GET","path":"/api/v1/freshness"}
-->

## gaps

### `GET /api/v1/gaps`

Fetch interface gap report.

**Query parameters**

- `netuid` (integer)
- `coverage_level` (enum)
- `curation_level` (enum)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/gaps'
```

<!-- playground:
{"id":"gaps","method":"GET","path":"/api/v1/gaps"}
-->

## health

### `GET /api/v1/health`

Fetch global health summary.

**Query parameters**

- `netuid` (integer)
- `status` (enum)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/health'
```

<!-- playground:
{"id":"health","method":"GET","path":"/api/v1/health"}
-->

### `GET /api/v1/health/history/{date}`

Fetch compact daily health history.

**Query parameters**

- `netuid` (integer)
- `kind` (enum)
- `provider` (string)
- `status` (enum)
- `classification` (enum)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/health/history/2026-06-01'
```

<!-- playground:
{"id":"health-history","method":"GET","path":"/api/v1/health/history/{date}"}
-->

### `GET /api/v1/health/trends`

Fetch compact 7d/30d daily uptime and latency trends for all subnets (computed live from D1).

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/health/trends'
```

<!-- playground:
{"id":"health-trends-bulk","method":"GET","path":"/api/v1/health/trends"}
-->

## incidents

### `GET /api/v1/incidents`

Fetch recent cross-subnet downtime incidents reconstructed from probe history over a 7d or 30d window (computed live from D1). Pair with /api/v1/health for the overall status summary.

**Query parameters**

- `window` (enum)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/incidents'
```

<!-- playground:
{"id":"incidents","method":"GET","path":"/api/v1/incidents"}
-->

## lineage

### `GET /api/v1/lineage`

Fetch maintainer-approved cross-network subnet lineage (graduated subnets + the deploying-soon testnet pipeline).

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/lineage'
```

<!-- playground:
{"id":"lineage","method":"GET","path":"/api/v1/lineage"}
-->

## meta

### `GET /api/v1`

List backend API routes and response envelope metadata.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1'
```

<!-- playground:
{"id":"api-index","method":"GET","path":"/api/v1"}
-->

## openapi.json

### `GET /api/v1/openapi.json`

Fetch OpenAPI 3.1 contract.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/openapi.json'
```

<!-- playground:
{"id":"openapi","method":"GET","path":"/api/v1/openapi.json"}
-->

## profiles

### `GET /api/v1/profiles`

List public-safe subnet profiles and completeness scores.

**Query parameters**

- `netuid` (integer)
- `subnet_type` (enum)
- `curation_level` (enum)
- `review_state` (string)
- `confidence` (enum)
- `profile_level` (enum)
- `q` (string)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/profiles'
```

<!-- playground:
{"id":"profiles","method":"GET","path":"/api/v1/profiles"}
-->

## providers

### `GET /api/v1/providers`

List providers and sources.

**Query parameters**

- `id` (string)
- `kind` (enum)
- `authority` (enum)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/providers'
```

<!-- playground:
{"id":"providers","method":"GET","path":"/api/v1/providers"}
-->

### `GET /api/v1/providers/{slug}`

Fetch per-provider detail.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/providers/allways'
```

<!-- playground:
{"id":"provider-detail","method":"GET","path":"/api/v1/providers/{slug}"}
-->

### `GET /api/v1/providers/{slug}/endpoints`

List endpoint resources for one provider or operator.

**Query parameters**

- `kind` (enum)
- `layer` (enum)
- `netuid` (integer)
- `pool_eligible` (enum)
- `publication_state` (enum)
- `status` (enum)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/providers/allways/endpoints'
```

<!-- playground:
{"id":"provider-endpoints","method":"GET","path":"/api/v1/providers/{slug}/endpoints"}
-->

## registry

### `GET /api/v1/registry/leaderboards`

Fetch registry leaderboards computed live from D1 + registry projections + the economics tier. Operational boards: healthiest, fastest-rpc, most-complete, most-enriched, fastest-growing, most-reliable. Economic opportunity boards (for miners/validators): open-slots, cheapest-registration, highest-emission, validator-headroom. Omit `board` for all boards.

**Query parameters**

- `board` (enum)
- `limit` (integer)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/registry/leaderboards'
```

<!-- playground:
{"id":"registry-leaderboards","method":"GET","path":"/api/v1/registry/leaderboards"}
-->

### `GET /api/v1/registry/summary`

Fetch the registry-wide summary (completeness, top subnets, level counts, latest changes).

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/registry/summary'
```

<!-- playground:
{"id":"registry-summary","method":"GET","path":"/api/v1/registry/summary"}
-->

## review

### `GET /api/v1/review/adapter-candidates`

Fetch subnets worth deeper adapter work.

**Query parameters**

- `netuid` (integer)
- `curation_level` (enum)
- `candidate_api_kinds` (enum)
- `operational_kinds` (enum)
- `reason_codes` (string)
- `recommended_adapter_kind` (enum)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/review/adapter-candidates'
```

<!-- playground:
{"id":"review-adapter-candidates","method":"GET","path":"/api/v1/review/adapter-candidates"}
-->

### `GET /api/v1/review/enrichment-evidence`

Fetch detailed candidate evidence behind the enrichment queue.

**Query parameters**

- `direct_submission_kinds` (enum)
- `evidence_action` (enum)
- `lane` (enum)
- `missing_kinds` (enum)
- `netuid` (integer)
- `q` (string)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/review/enrichment-evidence'
```

<!-- playground:
{"id":"review-enrichment-evidence","method":"GET","path":"/api/v1/review/enrichment-evidence"}
-->

### `GET /api/v1/review/enrichment-queue`

Fetch the prioritized all-subnet enrichment queue.

**Query parameters**

- `curation_level` (enum)
- `direct_submission_kinds` (enum)
- `evidence_action` (enum)
- `identity_level` (enum)
- `lane` (enum)
- `missing_kinds` (enum)
- `netuid` (integer)
- `profile_level` (enum)
- `reason_codes` (string)
- `review_state` (string)
- `manual_review_required` (enum)
- `q` (string)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/review/enrichment-queue'
```

<!-- playground:
{"id":"review-enrichment-queue","method":"GET","path":"/api/v1/review/enrichment-queue"}
-->

### `GET /api/v1/review/enrichment-targets`

Fetch contributor-ready enrichment targets grouped by missing surface kind and review route.

**Query parameters**

- `auto_review_candidate` (enum)
- `evidence_action` (enum)
- `identity_level` (enum)
- `kind` (enum)
- `lane` (enum)
- `manual_review_required` (enum)
- `missing_kinds` (enum)
- `netuid` (integer)
- `profile_level` (enum)
- `reason_codes` (string)
- `submission_route` (enum)
- `target_action` (enum)
- `target_type` (enum)
- `q` (string)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/review/enrichment-targets'
```

<!-- playground:
{"id":"review-enrichment-targets","method":"GET","path":"/api/v1/review/enrichment-targets"}
-->

### `GET /api/v1/review/gaps`

Fetch contributor-targeted subnet gap priorities.

**Query parameters**

- `netuid` (integer)
- `curation_level` (enum)
- `review_state` (string)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/review/gaps'
```

<!-- playground:
{"id":"review-gaps","method":"GET","path":"/api/v1/review/gaps"}
-->

### `GET /api/v1/review/profile-completeness`

Fetch profile completeness gaps for contributor targeting.

**Query parameters**

- `netuid` (integer)
- `profile_level` (enum)
- `confidence` (enum)
- `identity_level` (enum)
- `identity_promotion_kinds` (enum)
- `native_name_quality` (enum)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/review/profile-completeness'
```

<!-- playground:
{"id":"review-profile-completeness","method":"GET","path":"/api/v1/review/profile-completeness"}
-->

## rpc

### `GET /api/v1/rpc/endpoints`

Fetch Bittensor RPC endpoint status.

**Query parameters**

- `kind` (enum)
- `layer` (enum)
- `netuid` (integer)
- `pool_eligible` (enum)
- `provider` (string)
- `publication_state` (enum)
- `status` (enum)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/rpc/endpoints'
```

<!-- playground:
{"id":"rpc-endpoints","method":"GET","path":"/api/v1/rpc/endpoints"}
-->

### `GET /api/v1/rpc/pools`

Fetch endpoint pool scores.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/rpc/pools'
```

<!-- playground:
{"id":"rpc-pools","method":"GET","path":"/api/v1/rpc/pools"}
-->

### `GET /api/v1/rpc/usage`

Fetch RPC reverse-proxy usage analytics — request volume, latency p50/p95, failover + error rate, cache-hit rate, per-endpoint distribution, and bounded time buckets for heatmaps — over a 7d or 30d window (computed live from D1 telemetry).

**Query parameters**

- `window` (enum)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/rpc/usage'
```

<!-- playground:
{"id":"rpc-usage","method":"GET","path":"/api/v1/rpc/usage"}
-->

## schemas

### `GET /api/v1/schemas`

Fetch captured schema index.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/schemas'
```

<!-- playground:
{"id":"schemas","method":"GET","path":"/api/v1/schemas"}
-->

## search

### `GET /api/v1/search`

Fetch compact search index.

**Query parameters**

- `q` (string)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/search?limit=3'
```

<!-- playground:
{"id":"search","method":"GET","path":"/api/v1/search"}
-->

## search-index

### `GET /api/v1/search-index`

Fetch the slim search index — the same documents as /search without the per-document token blobs, for fast browser typeahead and listing.

**Query parameters**

- `q` (string)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/search-index'
```

<!-- playground:
{"id":"search-index","method":"GET","path":"/api/v1/search-index"}
-->

## source-health

### `GET /api/v1/source-health`

Fetch upstream source health.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/source-health'
```

<!-- playground:
{"id":"source-health","method":"GET","path":"/api/v1/source-health"}
-->

## source-snapshots

### `GET /api/v1/source-snapshots`

Fetch source input hashes and counts.

**Query parameters**

- `q` (string)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/source-snapshots'
```

<!-- playground:
{"id":"source-snapshots","method":"GET","path":"/api/v1/source-snapshots"}
-->

## subnets

### `GET /api/v1/subnets`

List active Finney subnets.

**Query parameters**

- `netuid` (integer)
- `netuids` (string)
- `coverage_level` (enum)
- `curation_level` (enum)
- `domain` (enum)
- `status` (enum)
- `subnet_type` (enum)
- `q` (string)
- `min_block` (number)
- `max_block` (number)
- `min_candidate_count` (number)
- `max_candidate_count` (number)
- `min_integration_readiness` (number)
- `max_integration_readiness` (number)
- `min_mechanism_count` (number)
- `max_mechanism_count` (number)
- `min_participant_count` (number)
- `max_participant_count` (number)
- `min_probed_surface_count` (number)
- `max_probed_surface_count` (number)
- `min_surface_count` (number)
- `max_surface_count` (number)
- `min_tempo` (number)
- `max_tempo` (number)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/subnets?limit=3&sort=netuid'
```

<!-- playground:
{"id":"subnets","method":"GET","path":"/api/v1/subnets"}
-->

### `GET /api/v1/subnets/{netuid}`

Fetch per-subnet detail.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/subnets/7'
```

<!-- playground:
{"id":"subnet-detail","method":"GET","path":"/api/v1/subnets/{netuid}"}
-->

### `GET /api/v1/subnets/{netuid}/candidates`

List unpromoted candidate surfaces for one subnet.

**Query parameters**

- `kind` (enum)
- `provider` (string)
- `state` (enum)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/subnets/7/candidates'
```

<!-- playground:
{"id":"subnet-candidates","method":"GET","path":"/api/v1/subnets/{netuid}/candidates"}
-->

### `GET /api/v1/subnets/{netuid}/concentration`

Fetch stake & emission concentration metrics (Gini, HHI, Nakamoto coefficient, top-percentile shares, entropy) for one subnet across per-UID, per-entity (coldkeys collapsed), and validator-only consensus-power lenses (computed live from the neurons D1 tier).

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/subnets/7/concentration'
```

<!-- playground:
{"id":"subnet-concentration","method":"GET","path":"/api/v1/subnets/{netuid}/concentration"}
-->

### `GET /api/v1/subnets/{netuid}/concentration/history`

Fetch the per-day stake & emission concentration trend (Gini, Nakamoto coefficient, top-10% share) for one subnet over a 7d/30d/90d window (computed live from the neuron_daily D1 rollup).

**Query parameters**

- `window` (enum)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/subnets/7/concentration/history'
```

<!-- playground:
{"id":"subnet-concentration-history","method":"GET","path":"/api/v1/subnets/{netuid}/concentration/history"}
-->

### `GET /api/v1/subnets/{netuid}/endpoints`

List generalized endpoint resources for one subnet.

**Query parameters**

- `kind` (enum)
- `layer` (enum)
- `pool_eligible` (enum)
- `provider` (string)
- `publication_state` (enum)
- `status` (enum)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/subnets/7/endpoints'
```

<!-- playground:
{"id":"subnet-endpoints","method":"GET","path":"/api/v1/subnets/{netuid}/endpoints"}
-->

### `GET /api/v1/subnets/{netuid}/events`

Fetch the first-party chain-event stream for one subnet (registrations, stake, weights, axon, delegation, lifecycle, transfers), newest first, from the account_events D1 tier filtered by netuid. Optional ?kind= filter and ?block_start/?block_end (block-height range); ?limit (<=1000) / ?offset.

**Query parameters**

- `kind` (string)
- `block_start` (integer)
- `block_end` (integer)
- `limit` (integer)
- `offset` (integer)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/subnets/7/events'
```

<!-- playground:
{"id":"subnet-events","method":"GET","path":"/api/v1/subnets/{netuid}/events"}
-->

### `GET /api/v1/subnets/{netuid}/evidence`

Fetch public evidence ledger claims for one subnet.

**Query parameters**

- `q` (string)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/subnets/7/evidence'
```

<!-- playground:
{"id":"subnet-evidence","method":"GET","path":"/api/v1/subnets/{netuid}/evidence"}
-->

### `GET /api/v1/subnets/{netuid}/gaps`

Fetch interface gap priorities and enrichment queue for one subnet.

**Query parameters**

- `curation_level` (enum)
- `review_state` (string)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/subnets/7/gaps'
```

<!-- playground:
{"id":"subnet-gaps","method":"GET","path":"/api/v1/subnets/{netuid}/gaps"}
-->

### `GET /api/v1/subnets/{netuid}/health`

Fetch health detail for one subnet.

**Query parameters**

- `kind` (enum)
- `provider` (string)
- `status` (enum)
- `classification` (enum)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/subnets/7/health'
```

<!-- playground:
{"id":"subnet-health","method":"GET","path":"/api/v1/subnets/{netuid}/health"}
-->

### `GET /api/v1/subnets/{netuid}/health/incidents`

Fetch SLA (uptime ratio) and reconstructed downtime incidents per operational surface for one subnet over a 7d or 30d window (computed live from D1).

**Query parameters**

- `window` (enum)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/subnets/7/health/incidents'
```

<!-- playground:
{"id":"subnet-health-incidents","method":"GET","path":"/api/v1/subnets/{netuid}/health/incidents"}
-->

### `GET /api/v1/subnets/{netuid}/health/percentiles`

Fetch latency percentiles (p50/p95/p99) per operational surface for one subnet over a 7d or 30d window (computed live from D1).

**Query parameters**

- `window` (enum)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/subnets/7/health/percentiles'
```

<!-- playground:
{"id":"subnet-health-percentiles","method":"GET","path":"/api/v1/subnets/{netuid}/health/percentiles"}
-->

### `GET /api/v1/subnets/{netuid}/health/trends`

Fetch 7d/30d uptime and success-only latency trends (mean + p50/p95/p99 tail + healthy-sample count) per operational surface for one subnet (computed live from D1).

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/subnets/7/health/trends'
```

<!-- playground:
{"id":"subnet-health-trends","method":"GET","path":"/api/v1/subnets/{netuid}/health/trends"}
-->

### `GET /api/v1/subnets/{netuid}/history`

Fetch a subnet's per-day aggregate history (neuron/validator counts + stake/emission totals) for sparklines, computed live from the neuron_daily D1 rollup tier. ?window=7d|30d|90d|1y|all.

**Query parameters**

- `window` (enum)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/subnets/7/history'
```

<!-- playground:
{"id":"subnet-history","method":"GET","path":"/api/v1/subnets/{netuid}/history"}
-->

### `GET /api/v1/subnets/{netuid}/identity-history`

Fetch the append-only on-chain identity timeline for one subnet (#1647): each entry is a SubnetIdentitiesV3 snapshot recorded when any tracked field changed. Newest first; ?limit (<=1000) / ?offset, or ?cursor= for stable keyset paging.

**Query parameters**

- `limit` (integer)
- `offset` (integer)
- `cursor` (string)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/subnets/7/identity-history'
```

<!-- playground:
{"id":"subnet-identity-history","method":"GET","path":"/api/v1/subnets/{netuid}/identity-history"}
-->

### `GET /api/v1/subnets/{netuid}/metagraph`

Fetch the per-UID metagraph (stake, trust, consensus, incentive, dividends, emission, validator_permit, rank, axon) for one subnet, computed live from the neurons D1 tier. Add ?validator_permit=true for validators only.

**Query parameters**

- `validator_permit` (enum)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/subnets/7/metagraph'
```

<!-- playground:
{"id":"subnet-metagraph","method":"GET","path":"/api/v1/subnets/{netuid}/metagraph"}
-->

### `GET /api/v1/subnets/{netuid}/neurons/{uid}`

Fetch a single neuron's metagraph state by UID, computed live from the neurons D1 tier.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/subnets/7/neurons/0'
```

<!-- playground:
{"id":"subnet-neuron","method":"GET","path":"/api/v1/subnets/{netuid}/neurons/{uid}"}
-->

### `GET /api/v1/subnets/{netuid}/neurons/{uid}/history`

Fetch a UID's per-day metagraph history (stake, trust, consensus, incentive, dividends, emission, rank over time), computed live from the neuron_daily D1 rollup tier. ?window=7d|30d|90d|1y|all.

**Query parameters**

- `window` (enum)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/subnets/7/neurons/0/history'
```

<!-- playground:
{"id":"subnet-neuron-history","method":"GET","path":"/api/v1/subnets/{netuid}/neurons/{uid}/history"}
-->

### `GET /api/v1/subnets/{netuid}/overview`

Fetch a composed overview (profile + health + curation + gaps + counts) for one subnet.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/subnets/7/overview'
```

<!-- playground:
{"id":"subnet-overview","method":"GET","path":"/api/v1/subnets/{netuid}/overview"}
-->

### `GET /api/v1/subnets/{netuid}/profile`

Fetch public-safe profile detail for one subnet.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/subnets/7/profile'
```

<!-- playground:
{"id":"subnet-profile","method":"GET","path":"/api/v1/subnets/{netuid}/profile"}
-->

### `GET /api/v1/subnets/{netuid}/stake-flow`

Fetch net stake flow for one subnet over a recent window: total TAO staked (StakeAdded) vs unstaked (StakeRemoved), the net flow, and the stake/unstake event counts, summed live from the account_events stream. ?direction=all|in|out filters to inflow (StakeAdded) or outflow (StakeRemoved) only; omitted defaults to all. Windows (7d/30d/90d) are bounded by the account_events retention.

**Query parameters**

- `window` (enum)
- `direction` (enum)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/subnets/7/stake-flow'
```

<!-- playground:
{"id":"subnet-stake-flow","method":"GET","path":"/api/v1/subnets/{netuid}/stake-flow"}
-->

### `GET /api/v1/subnets/{netuid}/surfaces`

List curated public surfaces for one subnet.

**Query parameters**

- `kind` (enum)
- `provider` (string)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/subnets/7/surfaces'
```

<!-- playground:
{"id":"subnet-surfaces","method":"GET","path":"/api/v1/subnets/{netuid}/surfaces"}
-->

### `GET /api/v1/subnets/{netuid}/trajectory`

Fetch the week-over-week structural trajectory (completeness + surface/endpoint counts) for one subnet from daily snapshots (computed live from D1).

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/subnets/7/trajectory'
```

<!-- playground:
{"id":"subnet-trajectory","method":"GET","path":"/api/v1/subnets/{netuid}/trajectory"}
-->

### `GET /api/v1/subnets/{netuid}/turnover`

Fetch validator-set & registration turnover (churn) for one subnet between a window's start and end snapshots — validators entered/exited + retention, UID deregistrations, and a 0-100 stability score. Add ?changes=true to include the entered/exited validator hotkeys and UID reassignment detail (computed live from the neuron_daily D1 rollup).

**Query parameters**

- `window` (enum)
- `changes` (enum)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/subnets/7/turnover'
```

<!-- playground:
{"id":"subnet-turnover","method":"GET","path":"/api/v1/subnets/{netuid}/turnover"}
-->

### `GET /api/v1/subnets/{netuid}/uptime`

Fetch long-term daily uptime history per operational surface for one subnet over a 90d or 1y window (computed live from the surface_uptime_daily D1 rollup). Pass `min_samples` to drop low-sample day rows (daily probe count below the threshold, including zero-sample 'unknown' days) from the history.

**Query parameters**

- `window` (enum)
- `min_samples` (integer)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/subnets/7/uptime'
```

<!-- playground:
{"id":"subnet-uptime","method":"GET","path":"/api/v1/subnets/{netuid}/uptime"}
-->

### `GET /api/v1/subnets/{netuid}/validators`

Fetch the validators (validator_permit) of one subnet ranked by stake, computed live from the neurons D1 tier.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/subnets/7/validators'
```

<!-- playground:
{"id":"subnet-validators","method":"GET","path":"/api/v1/subnets/{netuid}/validators"}
-->

### `GET /api/v1/subnets/{netuid}/yield`

Fetch the per-UID emission yield (emission/stake return rate) for one subnet over the current metagraph snapshot, ranked high to low with a distribution summary (subnet aggregate yield, mean, p25/median/p75/p90 percentiles), a validator/miner split, and a per-UID above/below-median label, computed live from the neurons D1 tier.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/subnets/7/yield'
```

<!-- playground:
{"id":"subnet-yield","method":"GET","path":"/api/v1/subnets/{netuid}/yield"}
-->

### `GET /api/v1/subnets/movers`

Fetch the cross-subnet momentum leaderboard: every subnet ranked by its change in stake, emission, and validator count between the window's start and end neuron_daily snapshots, with start/end values, deltas, and percentage changes. Sort by stake (default), emission, or validators; limit caps the list (default 20, max 100). Computed live from the neuron_daily D1 rollup.

**Query parameters**

- `window` (enum)
- `sort` (enum)
- `limit` (integer)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/subnets/movers'
```

<!-- playground:
{"id":"subnet-movers","method":"GET","path":"/api/v1/subnets/movers"}
-->

## surfaces

### `GET /api/v1/surfaces`

List curated public surfaces.

**Query parameters**

- `netuid` (integer)
- `kind` (enum)
- `provider` (string)
- `fields` (string)
- `limit` (integer)
- `cursor` (integer)
- `sort` (enum) — Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.
- `order` (enum) — Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/surfaces?limit=3'
```

<!-- playground:
{"id":"surfaces","method":"GET","path":"/api/v1/surfaces"}
-->

## validators

### `GET /api/v1/validators`

Fetch the network-wide validator/operator leaderboard: validator-permit identities grouped across all current subnet memberships, with trust metrics, cross-subnet stake/emission totals, stake dominance, and top membership rows. Sort by subnet_count (default), uid_count, avg_validator_trust, max_validator_trust, total_stake, total_emission, or stake_dominance; limit caps the list (default 20, max 100). Computed live from the neurons D1 tier.

**Query parameters**

- `sort` (enum)
- `limit` (integer)

**Try it**

```bash
curl -s 'https://api.metagraph.sh/api/v1/validators'
```

<!-- playground:
{"id":"global-validators","method":"GET","path":"/api/v1/validators"}
-->

<sub>Auto-generated by `scripts/generate-docs-site.mjs`. Do not edit — run `npm run docs-site:generate` after contract changes.</sub>
