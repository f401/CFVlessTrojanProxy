- 线上 **7.399**（已部署、可跑）｜仓库 **7.400**（地区面板展示真实 ISO 国家码：QUALITY 独立 isoCc 表按出口 IP 批量查 ip-api，展示层优先于 CF 机场码但选路 cc 不变；共 215 个缺陷皆已修复）：两者差 1 个版本。

# AGENTS.md

Handoff notes for anyone (human or AI) changing this repo. Goal: **every change provable by a gate, revertable, and never silently wrong in production.**

> The first line above is machine-checked by `tools/doc-audit.mjs` (`headSync`): repo version must equal `VERSION` in `src/core/util.ts`, the number after `共` must equal the highest id in `docs/v8实现清单.md`, and `两者差 N 个版本` must equal the minor-version gap. Keep that Chinese line in that shape when you bump versions.

## 1. What this is

`cf-proxyx` — VLESS/Trojan over WebSocket on Cloudflare Workers, with a proxyip candidate pool, node scoring + rotation, usage metering in a Durable Object, block judgement, and a per-request scheduling budget. Runtime version lives in `src/core/util.ts` (`VERSION`), not `package.json`.

Constraints of the free plan shape most of the design: ≤6 concurrent `connect()`, ≤50 subrequests per invocation, DO CPU in the tens of milliseconds.

## 2. Hard rules (do not break)

1. **Never share statistics across isolates.** `px:seed` holds only `{k,h,p,cc}` — names and addresses. Latency, success rate and throughput stay in isolate memory. Each isolate may see a different RTT to the same node.
2. **No block without a 2xx.** Block evidence requires, inside one time window, the same site succeeding on one channel and failing on another. All-4xx / all-timeout may only `rotate` and re-sample. Business 403s pass through untouched.
3. **Never deploy an unobfuscated bundle.** `tools/check-obf.js` is a hard gate (strict keywords must be 0, `a_0x >= 100`, no plaintext `class Meter`), wired into the deploy script; it refuses on failure.
4. **Entry preference can only be measured by the client.** A Worker dialing its own hostname loops (522). Subscription emits `server: <ip>` entries plus an `🌐 入口优选` url-test group pointing at `/health`; `?e=0` disables it.
5. **Mind the three free-plan budgets.** ① concurrent `connect()` ≤ 6 (`CONNECT_MS` in `src/core/util.ts` bounds every dial); ② subrequests ≤ 50 per invocation (`SCAN_SUB = 48`, `plan.sub` budget); ③ DO CPU is tens of ms — single-shot TLS handshakes go through `tunnelfetch` only. Since 7.363 the budgets are split in two: `BudgetLedger` (`src/core/budget-ledger.ts`) only accounts (caps / used / refused / snapshot), while `BudgetedIO` (`src/core/budgeted-io.ts`) is the single place that spends them — `openSocket()` and `fetch()` are the only call sites for `connect()` and subrequest `fetch()` in the whole repo. Request and cron rounds each `new` a ledger + IO pair and pass it down as `ctx.budget` / `DialOpts.budget`; never park one in `S`. A spent budget throws `BudgetExhausted`: recognise it with `isBudgetExhausted()` and rethrow — do not treat it as a dead leg, and remember the platform limit is *concurrent* `connect()` (≤6), which `SocketDialer` and `SC.PROBE_CONC` keep, not the counter.
6. **Comments and docs are gates, not courtesy.** Every exported function/method/class needs `/** what / @param / @returns */`; non-trivial bodies explain *why*. `doc-audit`, `body-audit` and `check-arch` all fail the build.

## 3. Layout

Dependency direction is enforced by `tools/check-arch.js` (reverse and circular imports both fail):

```
core → store → nodes → px → proxy → views → edge → routes
```

| Dir | Responsibility | Key files |
|---|---|---|
| `src/core/` | constants, global state table, utilities, histograms, budget, transports | `const.ts`, `state.ts`, `util.ts`, `table.ts`, `transport.ts` |
| `src/store/` | KV and DO (`Meter`) access, snapshots, pending ledger, seal/unseal | `meter.ts`, `meter-state.ts`, `pend.ts`, `snapshot.ts` |
| `src/nodes/` | node statistics, scoring, error ring, site profiles | `stat.ts`, `score.ts`, `metrics.ts` |
| `src/px/` | candidate pool, probing, selector, sampling, rotation, seed IO | `pool.ts`, `probe.ts`, `selector.ts`, `ts.ts` |
| `src/proxy/` | WS entry, protocol, dialing, connection metering, CF detection | `session.ts`, `connection.ts`, `dialer.ts` |
| `src/views/` | subscriptions (clash / sing-box / links) and panel HTML | `sub.ts`, `panel.ts` |
| `src/edge/` | auth (`X-Admin-Key` / Bearer / sha256 digest), responses | `auth.ts`, `respond.ts` |
| `src/route/` | judgement layer: verdict / judge / policy / budget / facts | `policy.ts`, `judge.ts`, `fact-table.ts` |
| `src/routes/` | HTTP routes: health, admin, debug, logs, proxyip, cron | `health.ts`, `cron.ts`, `debug.ts` |

`src/proxy/session.ts` **must not** import `src/route/*` (that creates `proxy → route` reversal plus a cycle). Cross-layer calls go through slot objects in `src/core/hook.ts`; `src/route/policy-wiring.ts` fills them and `src/index.ts` wires it with `import "./route/policy"`.

Other architectural limits: ≤560 lines per file, no `any`, no top-level `let`, and mutable cross-request state only inside the `S` table in `src/core/state.ts` (module-level mutable containers are gate-failed).

## 4. Commands

```powershell
node tools/preflight.mjs            # full local gate: tsc → arch → doc-audit → bundle → mk_test → 4 suites → golden → obf → simrun (no deploy)
node tools/preflight.mjs --fast     # skip sim_v3 / golden (~20-25 s)
node tools/preflight.mjs --deploy   # deploy only when everything is green

node tools/tsc.js                   # type check
node tools/check-arch.js            # layers, cycles, top-level state, file size, CRLF sanity
node tools/doc-audit.mjs --max 0    # JSDoc coverage, version header, table columns, living doc refs
node tools/body-audit.mjs           # step comments inside long functions
node tools/check-names.mjs          # member-name rules (ratchet in tools/naming-baseline.json)
node tools/check-dead.mjs           # exported symbols must have real references
node tools/check-wire.mjs           # DO endpoints and HOOK slots must have producers and callers
node tools/check-indent.mjs         # indentation vs brace depth
node tools/check-insertorder.mjs    # no slice-by-insertion-order bugs

node tools/bundle.js                # dist/_worker.js + dist/_test.js
node test/mk_test.mjs               # regenerate test/_bundle.mjs
node test/test_v3.mjs               # core features (186)
node test/smoke_v3.mjs              # smoke (30)
node test/test_score.mjs            # scoring/selection (3580)
node test/sim_v3.mjs                # simulation regression (22)
node test/golden.mjs                # subscription/panel snapshots (8); `write` to update on purpose

node tools/sim-select.mjs 8         # routing simulation; read medians, not single runs
node tools/simrun.mjs --full        # run all routes against a mock KV
```

`npm run check|build|test|arch|obf|all` are aliases.

## 5. Release flow

```
tsc → check-arch → doc-audit → bundle → mk_test → test_v3 / smoke / test_score / sim_v3 / golden
    → obf/pre.js → obf/obf_mid.js → check-obf → deploy → GET /health
```

- `obf/pre.js` and `obf/obf_mid.js` are **two stages**. Running only `obf_mid.js` deploys a bundle whose version number never changed — this has bitten us before.
- Deploy only when the user asks, when the change touches runtime limits, or on a version bump. Default to local gates only.
- After deploying, check `/health` for `version` and `关键字残留: 无`.

Account-level traps (all have happened):

- `PUT /scripts/{name}/schedules` needs a **top-level array** `[{"cron":"*/30 * * * *"}]`; other shapes return `10026`.
- `GET /scripts/{name}/settings` returns `secret_text.text` as an empty string. Writing it back **wipes** `uuid`/`pwd`/`kek` — always re-supply the three secrets. Switching only the `facts` binding requires a multipart `PATCH` with **all** bindings.
- `DELETE /scripts/{name}?force=true` also deletes that script's sqlite DO namespace. Recreating requires `migrations: { new_tag, new_sqlite_classes: ["Meter"] }` and **no** `namespace_id` (reusing it fails with `10061`).
- Non-sqlite → sqlite migration of an existing DO class deadlocks (`10074`/`10061`/`10064`); the only exit is delete-and-recreate, then rebind the custom domain.

## 6. Coding style

- **Classes own state; functions compute.** Give a class to a module only when it exclusively owns mutable cross-request state (`VerdictTable`, `Selector`, `MeterState`, `FactTable` subclasses, static-only holders such as `NodeStatsTable`…). Pure computation and rendering stay free functions (`src/core/util.ts` must not become a class).
- **No thin-wrapper facades.** A class whose every method is one-line delegation, or a module-level instance with no fields and a single consumer, is a defect: hold the object where it is used instead. Enforced socially plus `check-dead`; `Store`/`STORE`, `SUBVIEW`, `ALIVE`, `REGION`, `ATTACHER`, `SETTLE`, `FAILS`, `ROTATION`, `WIRING` were removed this way, and 7.360 turned the eight field-less holders (`STATS`/`SEEDS`/`PREFS`/`PROBE_COOL`/`FACTS`/`ROUTES`/`CRONLOCK`/`POOL`) into static-method classes — then deleted `Pool` outright once its nine static methods were found to have zero production callers.
- **Module-level instances must fit one of three buckets** (see `docs/命名约定.md`): owns cross-request state, a typed view over `S` with no fields, or a constant/encoder. Anything else belongs to an object. Current count: 46 names / 47 declarations (`DNS` exists in two layers; the list is ratcheted by `tools/check-singletons.mjs`).
- **Names must say what they hold.** No 1–2 character member names unless listed in the ALLOW table of `docs/命名约定.md`; units go in the name (`Ms`, `At`, `Bps`, `Count`, `Bytes`); closed sets use `St` / `Mode` from `src/core/enums.ts`; bounded tables use `BoundedMap` / `TimedMarks` from `src/core/table.ts`.
- **No hardcoded transport.** Probing goes through the `ProbeTransport` interface and `TRANSPORTS` registry (`src/core/transport.ts`), which carries three implementations: `TunnelFetchTransport` (userland TLS over a relay), `GatewayFetchTransport` (runtime fetch, direct only) and `Http80Transport` (plaintext HTTP/80 — cheapest real status-code evidence). Exactly one file may import `tunnelfetch`.
- **Comments** are Chinese (matching the codebase); this file and `docs/` are English-optional but currently Chinese in places. JSDoc says what/params/returns; body comments say what a step does and *why* (protocol offsets, bounds, temporary workarounds). Never put `//` inside HTML template strings in `src/views/` — it ships to browsers.
- **Bounded collections**: cap on insert, evict the least valuable entry, and never clear the whole table (that resets counters an attacker just tripped).

## 7. Testing

- Assertion helpers: `eq(label, got, want)` compares; `ok(label, cond, info)` — the third argument is **failure info**, not an expected value. `eq` order matters.
- New assertion groups go **before** the trailing `process.exit()` in `test/test_score.mjs`, otherwise they never run and the total does not move.
- `test/_bundle.mjs` is shared by `simrun`, `sim_v3` and `test_score`. After changing `src/`, run `bundle` **then** `mk_test` — skipping `bundle` means you tested the old code.
- `src/test-surface.ts` is the test window. New or renamed exports must be added there, or tests receive `undefined`.
- A/B proof: `git stash push -- <only the files you changed>` (never the whole `src/`, it swallows new exports), rebuild both sides, and confirm the new assertions **fail** on the old code. After `stash pop`, rebuild again.
- Simulation numbers are noisy: the same code reruns 1.28–1.54 on a 20-node case. Trust only medians at `SEEDS=8`, and compare against a paired baseline taken the same way.

## 8. Patch and script conventions

- Locate code by **whole-line `trim()` anchors with an exact hit count**; if the count is wrong, `process.exit(1)`. Never target line numbers.
- For multi-line edits, write the replacement to `.tmp-sim/*.txt` and splice by content, asserting the surrounding lines.
- The repo mixes CRLF and LF. Detect with `s.includes("\r\n")` and write back with the file's own ending; multi-line anchors must be joined with that ending.
- An `one()` helper that exits on the first miss also skips later steps — re-run the whole script rather than assuming partial application.
- Chinese text in `.mjs` scripts: only the write/edit tools or `fs.writeFileSync`. `Get-Content | Set-Content` mangles UTF-8 into `SyntaxError`.
- PowerShell 5.1: no heredoc into `git commit -F -`; write `.tmp-sim/msgNNN.txt` and use `git -c i18n.commitEncoding=UTF-8 commit -F`. `curl.exe` splits on `*` and spaces — use `Invoke-RestMethod` or Node `fetch`. `node -e` with quotes/backticks gets re-split; put anything non-trivial in a `.mjs` file.
- Installs: `npm install --cache .npm-cache` (the system npm cache hits EPERM); `esbuild` needs `npm install esbuild --ignore-scripts`.
- Lowercase only header **names** when normalizing, never values — `X-Admin-Key` values break the admin gate otherwise.

## 9. Current state

- Repo **7.400**; **live 7.399** (both runnable; 7.395 fixed Firefox NetworkError via CSP `connect-src 'self'`; 7.396 shows exit-country codes in region-panel probe results and keeps known nodes grouped by country first; 7.398 loads alive/seed on POST probe so relay rows get `[CC]`; 7.399 adds a per-row country column and uses `example.com` as the check-site placeholder so the obfuscator does not mangle `x.com` into `__K(...)`; 7.400 shows real ISO country codes via a display-only `QUALITY.isoCc` table queried by exit IP, leaving routing `cc` untouched). Baseline is **7.270** — an audit against it found and fixed three byte/semantic regressions: 7.375 WS `earlyData` and 7.376 ws2 message frames both used `TextEncoder` on an `atob()` Latin-1 string (double-encoding every byte >127, corrupting VLESS UUIDs); 7.376 also fixed `PendingLedger.flush` single-flight swallowing a forced flush. 7.377 added the self-service region panel; 7.378 fixed three O(N²) panel/subscription hot spots behind the CPU-limit incident; 7.379 expands the node panel with fact columns and throttled probes; 7.380 makes `/regions` lazily load seed/alive on a cold isolate so the panel is never falsely empty.
- The panel lists all alive ∪ seed nodes, groups by country, and shows quality badge / IP kind / family / proxy-VPN flags / eg-ps-dead-blk-dns facts / optional per-site RTT (`?site=`). `?format=json` keeps the old JSON contract. POST writes the user's own `regions` / `regionTopN` / `targetHost` through the shared `regionConfigList()` helper in `src/proxy/protocol.ts` (also used by admin `op=config`); GET is read-only over in-memory tables. Specified-site probes and per-node quality rechecks are available by POST and each has a 60 s cooldown. Template lives in `src/views/html/regions.html` (esbuild text loader).
- Architecture phase is closed: 115 source files, 110 exported classes, 46 module-level singleton names / 47 declarations (`DNS` exists in two layers; `FAM` added in 7.389). `docs/ARCHITECTURE.md` lists every class and who owns it; `docs/命名约定.md` holds the naming rules and the ratcheted singleton admission test (`tools/check-singletons.mjs`).
- Deliberately not done: merging the six fact tables (`VT`/`PS`/`EG`/`DNS`/`DEAD`/`BLK`) behind one root object. They appear ~540 times in `tests/` and `tools/`; the only gain is one less global. Rationale is recorded in `docs/命名约定.md`.
- Open boundaries that only real traffic can answer: long-term benefit of relaying, subrequest / `connect()` exhaustion under load, and the paired `facts=eg` vs `none` gain (+6 ± 10.4 — not significant).
- Historical audit ledger (defects 1–215 with root causes) lives in `docs/v8实现清单.md` (table H6), not here.

## 10. Credentials

Never commit a CF API token, account/zone id, `adminKey`, `uuid`, `pwd`, `kek` or KV namespace id. Release scripts read them from `.tmp-sim/` (gitignored); put any new throwaway script there too. Leaked credentials must be rotated rather than reused.
