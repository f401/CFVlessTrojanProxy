# AGENTS.md

给在这个仓库里干活的 AI/人类协作者的交接说明。目标：**任何一次改动都能被门禁证明、能被回滚、不会把线上搞挂**。

项目：`cf-proxyx`（`package.json` 名，版本号 1.0.0；实际对外版本是 `src/core/util.ts` 的 `VERSION`，线上 **7.123**、仓库 **7.163**（自举审计四十三批、共 72 个缺陷，均未部署））。
形态：Cloudflare Workers 上的 VLESS/Trojan over WebSocket，带 proxyip 候选池、节点评分与轮换、用量计量、封锁判定与调度预算。

---

## 1. 不能破的六条硬约束

1. **统计不跨 isolate 共享。** `px:seed` 里只放 `{k,h,p,cc}`（名字与地址），延迟/成功率/带宽全部留在本 isolate 内存。理由：每个 isolate 到同一节点的 RTT 可能差一倍，共用统计会让选路持续选错。
2. **没有 2xx 就不写封禁。** 封锁证据只来自「同一时间窗内，同站点有通道拿到 2xx、另一条没有」；全 4xx / 全超时只能 `rotate` 换出口重采，绝不能把站点或出口标记成 blocked。业务 403（如 `api.github.com`）必须原样透传。
3. **绝不部署明文包。** `tools/check-obf.js` 是发版硬闸（严格关键字必须 0、`a_0x >= 100`、无 `class Meter` 明文），已前置进部署脚本，失败即 `REFUSE`。用户对此有过明确指令。
4. **入口偏好只能客户端实测。** Worker 访问自家域名必然 522 自环，所以服务端探「客户端→边缘」在物理上不成立。订阅发 `server: <ip>` 条目 + `🌐 入口优选`（`url: https://<host>/health`、`expected-status: 200`）让客户端自己挑；`?e=0` 关闭、手动 `nodes` 优先。
5. **免费计划的三条额度必须留余量。** ① 同时打开的 `connect()` ≤ 6（`SC.PROBE_CONC = 6`，除非你确认改的是别的量）；② 一次调用 fetch 子请求 ≤ 50（一轮预算 `plan.cap = 48`，refill + tfb 也在里面）；③ DO CPU 只有几十毫秒 —— 单发 TLS 握手只能走 `tunnelfetch`（`src/core/tf.ts`）；vendored `subtls` 与 `core/tlsprobe.ts` 已在 7.69 整体删除（免费计划必 1102），不要再引入 userland TLS。
6. **注释与文档是门禁，不是礼貌。** 每个函数/方法上方必须有 `/** 功能 / @param / @returns */`，`node tools/doc-audit.mjs --max 0` 不过就发不了版；函数体内也要写「这步在干嘛 / 为什么」，协议偏移与边界条件必须解释。

---

## 2. 目录与分层

依赖方向（`tools/check-arch.js` 强制，反向依赖与循环依赖都报错）：

```
core  →  store  →  nodes  →  px  →  proxy  →  views  →  edge  →  routes
```

| 目录 | 职责 | 代表文件 |
|---|---|---|
| `src/core/` | 常量、状态表、工具、直方图、配额、TLS 探测封装 | `const.ts`、`state.ts`、`util.ts`、`hist.ts`、`tf.ts` |
| `src/store/` | KV 与 DO（`Meter`）读写、快照、待上报账本、密钥链 | `store.ts`、`meter.ts`、`snapshot.ts`、`pend.ts`、`factmerge.ts` |
| `src/nodes/` | 节点统计与打分、错误环、域名画像 | `stat.ts`、`score.ts`、`metrics.ts` |
| `src/px/` | 候选池、探活、选择器、单层抽样、地区分组、seed 交互 | `pool.ts`、`probe.ts`、`selector.ts`、`ts.ts` |
| `src/proxy/` | WS 入口、协议解析、拨号、连接计量、CF 托管识别 | `session.ts`、`connection.ts`、`dialer.ts`、`dial.ts` |
| `src/views/` | 订阅（clash / sing-box）与面板 HTML | `sub.ts`、`subview.ts`、`panel.ts` |
| `src/edge/` | 鉴权（`X-Admin-Key` / Bearer / sha256 摘要）、响应封装 | `auth.ts`、`respond.ts` |
| `src/route/` | 判定层：verdict / judge / policy / budget / tfb / 事实层 | `policy.ts`、`verdict.ts`、`tfb.ts` |
| `src/routes/` | HTTP 路由：health、admin、debug、logs、proxyip、cron、table | `health.ts`、`cron.ts`、`table.ts` |

`src/proxy/session.ts` **不能** import `src/route/*`（会形成 `proxy → route` 反向依赖 + 循环）。跨层通信用 `src/core/hook.ts` 的槽位：`src/route/policy.ts` 在模块顶层注册，`src/index.ts` 用 `import "./route/policy"` 做副作用装配。

其他架构门禁：单文件 ≤ 560 行、禁止 `any`、禁止顶层 `let`（可变的跨请求状态一律进 `src/core/state.ts` 的 `S`）。

---

## 3. 常用命令

```powershell
node tools/preflight.mjs            # 全量本地门禁（tsc→arch→bundle→mk_test→四段测试→golden→混淆→simrun），默认不部署
node tools/preflight.mjs --fast     # 跳过 sim_v3 / golden，约 20-25 s
node tools/preflight.mjs --deploy   # 全绿后直接部署（等价于再跑 deploy-746.mjs）

node tools/tsc.js                   # 类型检查（0 error 才允许继续）
node tools/check-arch.js            # 分层 / 循环 / 顶层状态 / 体积
node tools/bundle.js                # dist/_worker.js + dist/_test.js
node test/mk_test.mjs               # 生成 test/_bundle.mjs（simrun 与 test_score 都读它）
node test/test_v3.mjs               # 主功能（186 条）
node test/smoke_v3.mjs              # 冒烟（30 条）
node test/test_score.mjs            # 评分/选择（650+ 条）
node test/sim_v3.mjs                # 仿真回归（22 条）
node test/golden.mjs                # 订阅/面板快照（8 条）
node test/golden.mjs write          # 有意改动输出时更新快照，必须在提交信息里说明

node tools/doc-audit.mjs --max 0    # 函数级注释门禁
node tools/body-audit.mjs           # 体内步骤注释体检（≥12 行且零注释的函数）
node tools/doc-gen.mjs [--write]    # 给纯委托薄包装自动补一行式文档

node tools/sim-select.mjs 4         # 选路仿真（SEEDS=4/8；结果必须看中位数）
node tools/simrun.mjs --full        # 在本地 mock KV 上把 9 条路由跑一遍
node .tmp-sim/req.mjs "/<uuid>/debug?vt=example.com"   # 通用本地请求，打印完整 body
```

`package.json` 的脚本是上述命令的别名：`npm run check|build|test|arch|obf|all`。

---

### facts 开关的两种换法（7.107 起）

- **只改绑定**（不重新部署，秒级生效）：`PATCH /accounts/{ACC}/workers/scripts/proxyx/settings`，**必须 multipart/form-data**（JSON 会报 `10001 Content-Type must be one of: multipart/form-data`），且要带**全部 18 个绑定**（含三个 secret 的明文值），否则 secret 会被清空；`settings` 字段 = `{ bindings: [...] }`，`facts` 取 `none` / `eg` / `eg,ps` / `all`。脚本 `.tmp-sim/flip2.mjs <值>`，跑完看 `/health` 的 `facts`。
- **随代码发**：`.tmp-sim/deploy-7107.mjs`（`FACTS=<值>`）上传时确保 `facts` 绑定存在。

## 4. 发版流程（顺序不能错）

```
tsc → check-arch → bundle → mk_test → test_v3 / smoke / test_score / sim_v3 / golden
    → obf/pre.js → obf/obf_mid.js → check-obf → .tmp-sim/deploy-746.mjs → GET /health
```

必须记住的细节：

- **`obf/pre.js` 与 `obf/obf_mid.js` 是两个阶段**。只跑 `obf_mid.js` 会部署成功但版本号不变（它吃的是 `pre.js` 的产物）—— 曾因此线上挂着旧版还以为发了新版。
- `deploy-746.mjs` 只在 `VERSION` 变更后才有意义；它**不带 migrations**（`v1` 已应用，重复提交会报 tag 已存在）。
- 只有「用户明确要求 / 改动落在运行时限制 / 发版本号」才部署；日常改动默认只跑本地门禁（用户明确要求少推 CF）。
- 发完必须 `GET https://<host>/health` 核对 `version` 与 `关键字残留: 无`。

### 账号级坑（都踩过）

- `PUT /scripts/{name}/schedules` 的 body 必须是**顶层数组** `[{"cron":"*/30 * * * *"}]`，其他形状报 `10026`。
- `GET /scripts/{name}/settings` 里 `secret_text` 的 `text` 返回空串，直接回写会**清空 `uuid/pwd/kek`**；重建 metadata 时必须显式写回这三个 secret。
- `DELETE /scripts/{name}?force=true` 会**连带删掉该脚本的 sqlite DO 命名空间**；重建必须带 `migrations: { new_tag, new_sqlite_classes: ["Meter"] }` 且**不写 namespace_id**（复用它必报 `10061`）。
- 免费计划里「非 sqlite 类迁移到 sqlite」会形成 `10074/10061/10064` 的互锁，唯一出路是删脚本重建；此时自定义域要重新绑定 `PUT /accounts/{acc}/workers/domains`。

---

## 5. 测试规范

- `test/test_score.mjs` 的断言签名是 **`eq(label, got, want)`**（顺序反了会全部静默失败）。
- `eq` 内部是 `JSON.stringify` 比较，**函数与 `undefined` 都会序列化成 `undefined`** ⇒ 想证明「某个函数已删除」的断言在本轮之前全是空断言（7.150 起 want 为 `undefined`/函数时改走 `Object.is`）。写这类锁用 `eq(label, W.x, undefined)` 现在有效，但更稳的是 `ok(label, W.x === undefined)`。
- 新断言组必须插在文件末尾 `process.exit()` **之前**，否则静默不执行、总数也不变。
- `test/_bundle.mjs` 只有一份，`simrun`/`sim_v3`/`test_score` 都读它；改完源码不 `mk_test` 就跑测试等于测旧代码。
- `tools/check-wire.mjs` 除了「事实必须有生产调用点」，还检查「`cnt("x")` 的字面量必须在 `src/core/state.ts` 的 `cntKeys` 里登记」——漏登记时只打一行 `[cnt] unknown key` 就静默丢计数，面板会显示「这功能从没触发过」。
- `src/test-surface.ts` 是对外暴露给测试的「窗口」：新增/改名导出时必须同步，否则测试拿到 `undefined`。
- 仿真数字有噪声：同代码重跑 20 节点能在 1.28–1.54 之间跳。**只认 SEEDS=8 的中位数**，并且用 `git stash push -- src/` 做配对基线，不要拿不同时间点的两次跑分对比。

---

## 6. 编码与补丁约定

- **注释**：函数级写「功能 / 参数 / 返回」；体内只写「这步在干嘛 / 为什么」，协议字段偏移、边界条件、临时绕过的原因必须写。不复述代码，HTML 模板（`views/` 里的模板字符串）不写体内注释——里面的 `//` 会发给浏览器。
- **类**：只有**独占跨请求可变状态**的模块才配类（`VerdictTable`、`Pool`、`Scorer`、`Store`、`RelayHealth`…）。纯计算/纯渲染保持自由函数，不要为了「OOP」把 `util.ts` 变成类。
- **批量改代码**：不要按行号定位。用**整行 `trim()` 锚点 + 命中数必须为 1** 的脚本，命中数不对就 `process.exit(1)`；重复锚点用「连续多行」组合。写得好的范本：`.tmp-sim/steps*.mjs`。
- **CRLF**：仓库里 CRLF/LF 混排。`test/test_score.mjs` 过去是「每行 `\r\r\n`」的畸形行尾（等于每行后面跟着一个空行），
  7.134 已归一成纯 CRLF；其余文件仍是混排。锚点匹配前先 `s.includes("\r\n")` 探测（用 `"\n"` 硬拼锚点会一直 `anchor miss`）；
  **改写时按行保留各自的结尾**（由 `line.endsWith("\r")` 决定，新行沿用邻行）—— 写回时统一 `lines.join("\r\n")` 会把纯 LF 文件整体翻成 CRLF，
  7.163 的文档脚本就是这样在 `AGENTS.md` 与 `src/core/util.ts` 上造了 1200 行纯行尾 diff（内容一字未改）。
- **提交**：PowerShell 5.1 不支持 heredoc 管道进 `git commit -F -`；把提交信息写到 `.tmp-sim/msg*.txt`，再 `git -c i18n.commitEncoding=UTF-8 commit -F .tmp-sim/msg*.txt`。

---

## 7. 环境坑

- 依赖安装要用 `npm install --cache .npm-cache`（系统 npm 缓存会 EPERM）；`esbuild` 需 `npm install esbuild --ignore-scripts`，跑 `bundle.js` 时给足文件权限。
- PowerShell 5.1 里 `R`/`r` 是 `Invoke-History` 的别名，别拿它当函数名；`curl.exe` 会因为 `*` 和空格拆参，改用 `Invoke-RestMethod` 或 Node 的 `fetch`。
- `?tfb=` `?tlsnow=` 这类调试端点在 `/<uuid>/debug` 下，不在根路径。
- 请求头名小写化时只小写 key，**不要小写 value**（`X-Admin-Key` 的值会被打乱，管理端点一律 403）。

---

## 8. 凭据政策

- 仓库里**不放** CF API token、account id、zone id、`adminKey`、`uuid`、`pwd`、`kek`、KV namespace id。
- 需要发版时从 `.tmp-sim/deploy-746.mjs` 读取（该目录已在 `.gitignore` 里）；新写的临时脚本一律放 `.tmp-sim/`。
- 泄露过的凭据必须轮换，不要「反正是私库」就复用。

---

## 9. 当前状态与未完成

- 线上 **7.123**（`facts=eg`，仓库同版）。7.122 把 `dns` 事实接到跨 isolate（`FactsStore` + `mergeFacts`），7.123 修掉「`HOOK.facts` 从未注册 → `facts=none` 不影响选路」这个洞，并加 `?fx=` 单请求开关与「HOOK 槽位必须有人注册」的接线门禁。7.80–7.85 修的是「中继那一跳到底值不值」：
- **7.138 自举审计（第 28–31 条，同一张事实表族）**：`psfacts`/`dnsfacts` 的 `sent` 表只写不读（ack 里 set、`clear` 里 clear，没有任何读端；`relay-health.ts` 的同名表有读端，所以这不是统一模式）⇒ 长跑只增不减，删掉；康复通道闸门用会衰减的 `psOk` 判「历史上有过整页」⇒ 成过一次、连败十条的通道永远进不了康复名单（v8 §3.2 D12 的死锁仍在）⇒ `PsRow.top` 记历史最好 + `psBest`；`BlkFacts.batch/mute` 无上限无过期 ⇒ 新增 `trim()`；`blkfacts` 换批分支的 `if (b.n < BLK_MIN)` 恒真（死分支）。
- **7.124–7.140 自举审计**（`tools/exp-v8proof.mjs` 挂进 preflight，N=400 闭环证明）：共修 36 个缺陷 —— `cf-ok-relay` 短路、`nack` 丢待发（pending 语义）、事实读失败后永久关闭（改 60 秒冷却重试）、cron 恢复用量不限量扇出（改 `restorePick` 每轮 ≤12）、`backpressure` 把客户端主动断开记成节点头上的 `cut`（改 `ccut`）、`cnt` 字面量漏登记会静默丢计数（补静态门禁）、`Pool` 门面的 9 条自指文档且错报返回类型（重写 + 修 `doc-gen` 根因）、
  未知族 ×40 死锁（改 ×2）、`direct-ok` 不可达、`egDerive` 跨站点污染（加 `cf` 门）、`ps` 负样本从未写入（S3 零边际的结构性原因）、
  `eg-pin` 挑已判死的中继、`clientV6 && cfHost` 分支回退到含死通道的 `usable` 且排在 `direct-ok` 之前、
  只写不读的 `sent` 表（`ps`/`dns`）、康复闸门用会衰减的当前均值判「历史上有过整页」（改 `psBest` 看 `PsRow.top`）、
  无界批表/静默表（补 `trim`）、恒真死分支（`b.n = 1` 后判 `< BLK_MIN`）、
  **`FACTS.ack()` 漏了第五类 `dns`（pending 只进不出，每轮重发同一批）**、`v4List` 上方叠着属于 `snap` 的孤儿文档、
  `egQuota()` 零生产调用点且前提不成立（探测看不出出口族）、
  **`Policy.pin` / `Policy.seq` 两张「按站点」的表只增不减**（站点名来自客户端 ClientHello，不是有限集合；补 `trim` 与 `HOST_MEM_MAX = 512`）、
  `cfHost` 分支里叠着一段讲「直连成功证据」的注释，而那个分支早在函数上半部（`direct-ok`），注释下方没有任何代码、
  门面枚举式写法本身（六个方法各写五段并列调用）→ 改成表驱动 `TABLES`，少写一个方法就是编译错误、
  握手分片实验的 `src/store/chan.ts` 与 `/meter/ch*` 端点残留（持有一套无 TTL 的 socket 表，且是第二份 userland TLS）、
  `commitPool` 用本地代际号 +1（落后半小时时会覆盖别人更新的那一代，缩水判断也拿本地过期的池子大小比）——改成写前严格读 KV 锚点、取三者最大 +1、锚点写失败重试并留证据、
  `src/edge/auth.ts` 剥 Bearer 前缀的正则写成 `/^Bearers+/i`（`\s` 掉了反斜杠）——文档宣称支持的 Bearer 鉴权从来没生效，带 `Authorization: Bearer <key>` 一律 403、
  **入口偏好整条服务端链路是僵尸**：`EdgePrefs.add` 没有任何生产调用点（只有死包装 `edgeAdd` 调它），`scan` 恒返回 0（Worker 探自家域名必 522 自环），KV `edge:pref` 既无写者也无读者，可是 `/health` 的 `edge.seen/ranked`、`?edge=1` 的空表、订阅里「有实测排名就用」的分支都在暗示「这张表在测量」——已整条删除（`src/route/edge.ts` 240 行、`S.edge` 四件套、`SC.EDGE_AUTO`、cron 与预算里的入口份额），订阅只用 `X_EDGE_IPS` 种子（golden 零变化）；同时删掉 6 个零调用点的导出（`p90Local`/`relayChans`/`edgeAdd`/`markProbeOk`/`relAgg`/`vGet`），其中 `markProbeOk` 会写 `*|` 通配行，是 7.57 事故的同款地雷、
  **判定表的通配（`*`）与入口（`e:<ip>`）两个通道概念都是僵尸**：`*|通道` 的读端还在四处（`VerdictTable.ok/bad` 的通配回落、`Policy.chanOk`、`policy.ts` 的 `okOnes`、`Prefs.chan`），写端从 7.57 起一个都没有；`ChanKind` 里的 `"e"` 更是全仓没有构造点，`parseChan` 零调用点。危害是「看起来有通配兜底」：任何人想接一条 IP 级封锁，照抄现成的读取端就能一步复现 97% → 2/20。修法是**把不变量放进写入端**（`VerdictTable.blockWild` 直接拒绝 `*` 并计 `vwild`，`import` 也过同一道闸），再删掉所有读端回落与 `"e"` 类型、`parseChan`，顺手修掉 `verdictsync.ts` 里两段叠在一起的孤儿文档、
  **统计读缓存被自己的失效点架死**：`readStatsCached` 的 60 秒 `S.statCache` 在 `pendFlush`/`statBump`/`writeSnap` 三条写路径上都不失效，而 `src/index.ts` 的**两段**前置块每次统计类请求都先把它删掉 ⇒ 命中分支在 DO 后端永不成立，`pend.ts` 里「刚推过增量，缓存立即失效」被上层动作架空；同一处硬编码子路径列表与路由表的 `stats` 标志是两份真源——已删缓存与副本，只留路由表驱动的单段前置块，路由表成为唯一真源（`ROUTES.needsStats`）、
  **`doc-gen` 对没有显式返回类型的薄包装一律写「@returns 无」**：`Store` 的 `snap`/`usageSnap`/`usageSnapWrite`/`restore`/`nodeSnap` 被错报「无返回值」，实际都转发返回值——根因改成看函数体（`return` 打头就写「转发目标返回值」），并给这 5 个方法补上显式返回类型。
  **四个调试端点指向已被删除的 DO 路由**（`?dbt`/`?draw`/`?hold`/`?cont` → `/meter/{dbt,raw,hold,cont}`，7.69 删 subtls 与握手分片实验时移除）：`Meter.fetch` 的兜底是 `return this.json()`（200 + 整份计量表），所以它们一直「返回成功」，看起来还能用；`?hold`/`?cont` 与已删的 `chan.ts` 是同一路线下的探索残留。已删这四处分支，并在 `tools/check-wire.mjs` 加静态比对「`https://meter/<x>` 的调用方必须有实现方」（`/get` 走兜底是登记过的契约）。

第 24–27 条（v7.137，同一处代码）：`WRITE_GAP` 节流从未生效（`ctx.lastWrite` 没有生产者）⇒ 一次突发把 `ps` 压到下界；批次时钟被每条 tiny 推进 ⇒ 两批确认不可达；「影子先算、生产再算」读到的时钟不同 ⇒ 同一观测两侧结论不同（`cfDiff` 记的是分叉而不是「有人绕过裁决」）；`commitFact` 第 5 条的「两批 → 写 `blk`」在生产路径上不可达（120 秒对照窗口与 3 分钟矛盾窗口互相排除）⇒ 删分支、理由码改名 `R_TINY_PEER`，封锁的唯一写者就是 `BLK.note`。
- **7.141 自举审计（第 37–38 条）**：`Store.usageSnapWrite(env)` 是门面里唯一**永远不写**的方法——模块函数要用户表（`usageSnapWrite(env, users)`），门面只给 `env` ⇒ `list = []` ⇒ `if (!Object.keys(out.users).length) return;`，却返回一个 resolved 的 Promise（调用方无从察觉），已删掉该门面方法并写明原因；管理面板 `await eachLimit(users.list, 8, …)` 每个用户一次 DO 往返，而并发限制不限制**总量** ⇒ 用户数超过免费计划 50 子请求预算时，后半截用户的 `readStats` 全失败、`catch` 只有一句注释 ⇒ 面板静默显示 0（看着像「这用户没流量」）；改成 `SC.ADMIN_STATS_MAX = 32` 截断并计 `admStatsSkip`。
- **7.142 自举审计（第 39 条）**：`POST /meter/add` 里 `vt`、五类事实（`mergeFacts`）、`hl`、`blk` 四段**被整块嵌在 `if (Array.isArray(d.cl) && d.cl.length)` 里** —— 同一批没带连接观测（`cl`）时 DO 把这些字段静默丢掉，而发送侧不看返回值就 `syncAck` ⇒ 这批事实增量永久蒸发（静默丢数据，没有任何报错）。修法：把 `cl` 的块就地收口，四段提到 `/add` 顶层；`test/test_score.mjs` 第 105 组用「只带事实、不带 `cl` 的批次」锁住（旧代码上 6 条断言全红）。
- **7.143 自举审计（第 40 条）**：五张事实表的 `delta()` 都有行数上限（`eg` 16、`ps`/`dns`/`dead`/`blk` 各 60），而 `ack()` 一律 `this.pend.clear()` —— **超出上限的行既没发出去、也不会再重发**，每次 flush 都在丢证据，且没有任何计数；典型场景是大池 + 多站点时一次 30 秒窗口攒下上百个 `host|ip`。修法：每张表加 `private sent = new Map<string, number>()`（键 → 发出时的 `at`），`delta()` 记账、`ack()` 只清「发过且值没变新」的行，`nack()`/`clear()` 一并清空；`test/test_score.mjs` 第 106 组按表锁住「一批 60/16 行 → ack 后剩下的仍在待发 → 再 ack 才清空」，并多加一条「值在 delta 与 ack 之间变新时不能被清」（旧代码 8 条断言全红）。注意这与 7.138 删掉的 `sent` 表不是同一件事：那一张只写不读，这一张的唯一读者就是 `ack()`。
- **7.144 自举审计（第 41 条）**：`Policy.decide` 把**已经过判定表过滤的 `usable`** 传给 `BLK.sweep`，而 `sweep` 的判据是「该站点 ≥75% 的**候选**都写过封锁行」（`docs/v8.md` §15.6 写的就是「候选数」）。两者口径不一致的后果是这条站点级自愈**永不触发**：一条中继被判封锁的同一刻就离开 `usable`，而它的 `blk2` 封锁行要三批（≥3 分钟）才写成 ⇒ 分母与分子被同一个事件同时剔除，覆盖率恒接近 0，`bizSweeps` 成为「看起来在测量」的第二个僵尸计数器。修法：分母改成整池 `c.relays`；`test/test_score.mjs` 第 107 组锁住「6/8 触发自愈、5/8 不触发」（旧代码上 2 条断言红）。
- **7.145 自举审计（第 42 条）**：差分复核队列是**整条死链** —— `SC.PROBE_REQ` / `SC.PROBE_RND` 在 7.69 删 subtls 后就恒为 `0`，于是 `connection.ts` 的入队闸门 `SC.PROBE_REQ > 0` 恒假、预算里 `vtOn` 恒假（`plan.vt` 恒 0）、`runRound` 立即返回，而 `Judge` 每遇一次可疑小响应仍往 `S.vtQ` 里塞一条（上限 64）⇒ 队列**只进不出**，`?vtq=1` 永远回一份没人处理的积压，`S.vtLast` 更是从来没有写者（永远 `null`）。这不是「功能降级」而是「假仪表」：`bizSweeps`/`cfDiff`/`vtq` 三个计数器都在暗示「有人在复核」。
  修法：删掉 `src/route/verify.ts`（183 行，含 `VerifyQueue`、`judge` 差分规则、`runVerify` 空实现）、`S.vtQ`/`S.vtLast`、`HOOK.verify` 槽位与 `policy.ts` 的注册、`connection.ts` 的入队闸门、`judge.ts` 的 `queueVerify` 调用、`/<uuid>/debug?vtq=1`、`test-surface.ts` 的 5 个导出；单测第 41 组改成锁「这条链路已不存在」。封锁判定的唯一证据链仍是 `tfb`（两批共识由 7.147 的 `tfBlockOk` + `S.tfbV` 承担，125 种采样组合的单测覆盖）。
- **7.146 自举审计（第 43 条）**：`/meter/add` 落盘失败时只回滚了 `c`/`g`/`s`/`e` 四个结构，而**连接观测 `cl` 是加法合并**
  （同一个键 `old.n += x.n`，不像事实表那样按 `at` 幂等）⇒ `save()` 抛错后 `pendFlush` 会原样回放这一批（`S.cagg` 只在成功后清），
  于是 `cl` 的 `n`/`ok`/`dn` 被加两遍，面板上的连接数与可用率偏高。修法：`oldCl = this.cl.map((r) => ({ ...r }))` 并在 `catch` 里还原；
  `test/test_score.mjs` 第 108 组用「put 失败一次 → 500 → 重发同一批」锁住（旧代码上 2 条断言红）。

- **7.147 自举审计（第 44 条）**：`src/routes/cron.ts` 的 `TFB_V`（站点→判定）**只有 `delete`，没有任何 `set`/`get`**，
  它的块注释其实是 `tfbRound` 的说明（文档落错声明），所以没人发现「两批共识」从来没有实现：
  `src/route/tfb.ts` 的 `runTfb` 在**单批** `chan` 上就写判定表（`vSetState(…, 2, 1)`），一次限流/页面差异就能让一条中继 30 分钟不可用；
  而 AGENTS 与旧文档都宣称封锁要两批。同一处还有三张顶层可变 Map（`TFB_AT`/`TFB_N`/`TFB_V` + `lastV`）住在 `S` 之外、无上限，
  键还是客户端 ClientHello 带来的站点名。修法：`S.tfbV` 收编（256 条上限 + 从头部淘汰），新增 `tfBlockOk(prevTag, verdict)`
  （只有上一批也是 `chan` 才落封锁）与 `tfRemember(host, tag)`；`runTfb` 同时用 `S.tfbV` 做日志去重；锁：第 109 组（单批不落封锁 + 灌 300 个站点只剩 256 条）。

- **7.148 自举审计（第 45 条）**：`src/route/relperf.ts` 的 EWMA 把 `kbs = 0` 当测量值参与加权，
  而 `Connection` 只在真正传了 ≥1MB 时才给出速率（其余一律记 0，含义是「这次没量到」）——
  于是「一次大下载 + 几个普通页面」这种最常见的序列会把吞吐记忆一路拽到 32KB/s 的下限：
  800 → 520 → 338 → 220（三次小响应），八次之后贴着下限，`relCostOf` 算出 `ttfb + 16000` 而不是 `ttfb + 640`，
  `tput` 模式的「按吞吐排序」退化成「只看首字节」，而 `relCostOf` 里 `kbs <= 0` 那条「只罚 2000ms」的兜底也随之失效。
  修法：新增 `RelPerfTable.mixKbs(oldK, k)`——这次没量到就沿用旧值、旧值是 0 就直接采用这次，两张表（站点×中继、跨站点聚合）共用；
  顺带删掉零调用点的 `healthyRelays`（`policy.ts` 里两处早就在内联同样的 `HEALTH.rank(...).slice(...)`）；锁：第 110 组（大小样本交替后仍是 740 / 940）。

- **7.149 自举审计（第 46 条）**：判定扫描的编排链只剩空壳 —— `pickHosts` **没有任何生产调用点**
  （只有 `test-surface.ts` 与单测在用），`SWEEP_COST` 的注释自己写着「sweepHost 已随 subtls 删除，保留导出避免下游 import 断裂」，
  而 `runRound` 从 7.69 起就是 `void plan; return { hosts: [], swept: 0 };`、`cron.ts` 连它的返回值都不看；
  `budget.ts` 里那套「覆盖缺口 × 陈旧度」加权只在 `vtOn` 为真时有意义，而 `PROBE_RND/PROBE_REQ` 恒为 0 ⇒
  `plan.vt` 恒 0、加权结果恒等于 `cap`，`?vt=` 里那份「判定扫描额度」与 `staleR` 就成了两个永远不动的假仪表。
  修法：删 `src/route/round.ts`（`pickHosts`/`SWEEP_COST`/`runRound`/`RoundOut`）、`Plan.vt`、`budget.ts` 的 `vtOn/vtMin/wVt/staleR` 加权、
  `cron.ts` 的 `runRound(plan)` 调用、`test-surface.ts` 的两个导出；`planRound` 收成「准入拿满、不超过 `SCAN_MAX`」，
  并显式写明两个参数只剩保留签名的作用。锁：第 37 组改成「这三样已删除」，第 67 组改成「预算里不再有判定额度这一项」（旧代码上 6 条断言红）。
- **第 47 条（7.150）两条证据入口都是死路**：`src/route/observe.ts` 的 `recordProbe`（探测链 7.69 整体删除后就没有入口）与 `recordClient`（订阅只有客户端 `url-test`，客户端从不回传状态码）在生产代码里**零调用点**，却仍被 `test-surface.ts` 导出、8 条单测在用，头注释还写着「一次写两处（判定表 + 池子基础质量）」「blocked/dead 只能由 probe 或 client 产生」——三句都不成立。删两个函数与两个事件类型，注释改成「只剩三条真实入口：`recordTraffic` / `recordBlock` / `recordPass`」。
- **第 49 条（v7.151）** `S.tsMem` 是死字段：`src/core/state.ts` 里 88 个字段中唯一「0 读 0 写」的一个（注释还写着「Thompson 采样的成员表缓存」——v6.42 删采样器时留下的）。已删。
- **第 50 条（v7.151）** `src/px/selector.ts` 有两段相邻且互相重复的「非 CF 出口优先」注释（一段说「判定依据是出口 IP」，一段说「出口 IP 族」），保留措辞更准的那段。
- **第 51 条（v7.151）** 十段孤儿文档：`src/views/panel.ts` 七段（cookie/sha256/sessionToken/adminAuthed/loginAllowed/clearLogin/newNonce——辅助函数早已搬到 `src/edge/auth.ts` 与 `src/views/panel-admin.ts`）、`src/proxy/session.ts` 的下行转发（实现在 `src/proxy/tunnel.ts`）、`src/px/selector.ts` 的扫描方法（已不存在）、`src/views/panel-admin.ts` 的配额翻倍与订阅响应头（分别在 `sub-common.ts` 与 `routes/subscription.ts`）。它们让读代码的人以为这些能力还在本文件里。全部删除，并把「文档块结束后紧跟 `}` 或文件结束」做成 `tools/doc-audit.mjs` 的门禁（当前能抓 3 处，另外 7 处是「一段文档叠在另一段文档前面」，只能靠人读——门禁不假装覆盖）。

- **第 52 条（v7.152）** 设计稿 `docs/判定模块设计.md` 的分层清单仍在描述三个已删模块（`route/probe.ts` 与 `route/sweep.ts` 7.69 删除、`route/edge.ts` 7.133 删除）与三个预算维度（判定 7.149 删、入口 7.133 删，只剩准入），退场对照表与结尾原则还把内存判定表叫 `ChanTable`（那个类在 `src/store/chan.ts`，7.130 就删了，真实类名是 `VerdictTable`），并把 `facts` 的同步表数写成「六种 kind」（实际五张：`eg`/`ps`/`dead`/`blk`/`dns`）。逐行改正，表头加一条「下表是 7.69 之前的分层」的现状说明。

- **第 53 条（v7.153）** 17 个 `SC` 常量零读取点：`PROBE_REQ`/`PROBE_RND`（7.145 删复核链后就没有闸门读它们）、`VT_TTL`、`MIN_BYTES`、`TRIAL_LAT`/`TRIAL_TPUT`/`ROUTE_T_LAT`/`ROUTE_T_TPUT`/`ROUTE_K`（v6.42 删抽签器）、`WATCH_N`/`WATCH_BONUS`/`REHAB_N`/`REHAB_MS`（删 watchlist）、`LAT_TS`、`FAIL_GATE`、`TS_ALL`、`SEED_CONF`。它们是「关着的旋钮」：改值不会有任何行为变化，注释与历史条目却都在拿它们解释决策（`budget.ts` 甚至写「`PROBE_RND/PROBE_REQ > 0` 时有意义」）。已全删，并改掉引用它们的注释与两条断言（第 41/67 组改成锁「这两个开关不存在」）。
- **第 54 条（v7.154）** `/<uuid>/debug?vt=` 里 `ips`/`nodes`/`rows` 三个字段恒为空数组（扫描器 7.69 就删了），
  于是「扫了、什么也没扫到」与「根本没有扫描能力」在响应里长得一模一样 —— 删掉三个字段，只留 `table`/`pol`/`plan`/`counters`。
- **第 55 条（v7.154）** 同一处 `left`（这条封锁还剩几秒）自己抄了一份 `1800000` 裸魔数，而 7.153 刚把 `SC.VT_TTL` 删掉；
  判定表的真实 TTL 在 `VerdictTable` 里 ⇒ 导出 `VT_TTL_MS` 两处共用（改表就改一处）。
- **第 56 条（v7.154）** `src/test-surface.ts` 首行注释是双重编码的乱码（`娴嬭瘯涓撶敤…`）—— 文件头一句话，读的人只能猜；已改回中文。
- **第 57 条（v7.154）** 站点级自愈 `BLK.sweep` 排在「5% 复检」「直连被判死」两条早返回**之后** ⇒ 每次请求有 5% 概率跳过自愈；
  单测因此偶发失败（同一份代码 4 次跑 1 次红）——把 sweep 上移到所有早返回之前，并用 `Math.random = () => 0` 锁住「早返回时自愈仍发生」。

- **第 48 条（7.150）`eq` 对函数是空断言**：`eq` 用 `JSON.stringify(a) === JSON.stringify(b)` 比较，而 `JSON.stringify(函数)` 与 `JSON.stringify(undefined)` 都返回 `undefined` ⇒ 历史上所有「某函数已删除」的锁（7.133 的 `edgeAdd`/`p90Local`/`relAgg`/`vGet`、7.141 的 `STORE.usageSnapWrite`、7.145 的 `judge`/`queueLen`/`HOOK.verify`、7.149 的 `pickHosts`/`SWEEP_COST`/`runRound`）都是**永远为真**的空断言 —— 这次是 A/B 在旧代码上仍然 0 失败才暴露。修法：`const strict = b === undefined || typeof a === "function" || typeof b === "function";` 后走 `Object.is`。
### 7.156 自举审计（第 60 条：活文档在给不存在的类作证）

- **判据**：文档在描述「当前系统」时，它提到的文件、常量、函数、类必须真的存在于 src。
- **现场**：`docs/ARCHITECTURE.md` 类表有三行指向 src 里不存在的类 —— `Snapshot`（snapshot.ts 只有自由函数）、
  `StatsTable`（用量读缓存 7.135 已删）、`Budget`（budget.ts 只有 `planRound`）。
  `docs/v8.md` 的落地映射表「v8」列写着 factsAck / factsNack / readFacts，代码里从来没有这些符号
  （真名是 `FACTS.ack()` / `FACTS.nack()` / `vtLoad()`，设计名与落地名混在一列里，读者会去找不存在的函数）。
- **修法**：三行改成「自由函数 + 为什么没有类」的描述；映射表换成落地名，并加一句设计名 → 落地名的更正。
  `tools/doc-audit.mjs` 新增 `livingRefs()`：只对 `docs/ARCHITECTURE.md` 与 `docs/v8.md`（这两份描述当前系统）查四件事 ——
  ① 反引号里的 `src/…ts` 路径必须存在；② `SC.常量` 必须有定义；③ 裸 `name()` 必须在 src 里出现过；
  ④ 类表首列的类必须真有 `class X`。
- **为什么只查这两份**：`docs/评分机制_final.md`、`docs/判定模块设计.md`、`docs/节点选择仿真.md` 是历史稿，
  提到已删模块本身是记录；全量查会制造噪音，历史稿靠「本节描述的是 X 之前的设计」这类标注区分。
- **证据**：新门禁对 7.155 的两份文档报 6 处（exit=1），修完 0 处；单测第 145 组 6 条锁住（旧文档上 1020 通过 6 失败）。
- **教训**：JSDoc 里写通配路径会把注释块提前结束（`*/` 出现在注释中间），node 报 `Unexpected token '*'` ——
  这是 7.151 那条坑的第二次踩中，这次是「注释里写路径通配」。

### 7.155 自举审计（第 58–59 条）

- **58 三条「Worker 看不到 HTTP 状态码」是过期说法**：`src/routes/debug.ts` 里「只验 SNI，看不到 HTTP 状态」、
  「Worker 里唯一能看见 403 的办法」、「note: Worker 看不到 HTTP 状态码（TLS 端到端）」——7.24 起 `cfHttpCode`/`tfb`
  就能拿到真状态码，而同一个 `?diag` 响应里 `cfVerdict.code/cached` 就是状态码，自相矛盾。改成：probeSni 不完成握手所以
  拿不到应用层字节；隧道腿是端到端 TLS，要看状态码用 `cached` 或 `?tfb=`。
- **59 十四处「叠文档」**：一段文档后面紧跟另一段文档（前一段没有任何声明可挂），读起来像「文件里有这个函数」。
  来源都是历次删常量/删字段/改参数名：`const.ts` 三行（7.153 删的 PROBE_REQ/PROBE_RND/通道策略）、`hook.ts` 两行
  （7.145 的 verify、7.88 的 eg 单槽）、`state.ts` 两行（7.145 的 vtQ/vtLast）、`cfverdict.ts`、`pxhook.ts`、
  `commitfact.ts` 三行（7.137 的 CONFIRM_GAP/prevBatch/lastBigAt）、`tfb.ts`（tfVerdict 两段）、`score.ts` 两个方法各叠三段、
  `connection.ts` 的类文档被 `TICK_BYTES` 挤开、`probe.ts`/`ts.ts`/`panel.ts`/`sub.ts` 各一处。
  `tools/doc-audit.mjs` 新增「叠文档」规则（文件头注释豁免）；对旧 `src/` 报 **22 处**，修完 0 处。

- **7.157 自举审计（第 61 条）**：`PendingLedger.flush()` 挂上 `clSnap(40)` 之后，成功后调 `S.cagg.clear()` —— 整表清空会连带抹掉两种**还没发出去**的观测：① 被 40 行上限挤掉的键（`src/proxy/connection.ts` 允许 `S.cagg` 涨到 400 条聚合键），② `await stub.fetch()` 在途期间新结束的连接（生产者照常往 `S.cagg` 里加）。行语义是「自上次确认以来的增量」、DO 侧按加法合并，所以修法不是抄 7.143 的 `sent` 表（那套是「值没变才清」），而是**按已发数量相减**：新增 `PendingLedger.clAck(sent)` 逐行 `g.n -= s.n; g.ok -= s.ok; g.dn -= s.dn;`，减到 0 才删键；失败时什么都不做（这批没进 DO，行原样留到下一轮重发）。`test/test_score.mjs` 第 146 组锁住「45 个键只发 40 行、剩 5 个原样留着」与「在途期间新增的 2 条不会被抹掉」。顺带确认 `?ed=2560` **不是**死参数：它只写给客户端（把首包塞进 WS 握手），服务端解的是 `Sec-WebSocket-Protocol`（`src/proxy/session.ts` → `src/proxy/ws-in.ts` 的 `wsToStream`）。
- **7.158 自举审计（第 62 条）**：四张按站点记账的内存表**没有任何裁剪** —— `S.bigByHost`/`S.bigChan`（`judge.ts` 每见到一次整页就写）、`S.cfHost`（`dialer.ts` 写 30 分钟缓存）、`S.vtSent`（`verdictsync.ts` 的 `vtAck` 只增不删）。键全是客户端请求里的目标站点名（`CONNECT`/ClientHello 带来的），不是有限集合：一个长期存活的 isolate 见够几万个站点就一直涨，而且没有任何读路径会因此报错。实测（600 个不同站点各打一次整页）旧代码 `bigByHost`/`bigChan` 都是 600 行、上限是 0；`S.cfHost` 与 `S.vtSent` 同理，过期行也不会被清（`vtSent` 的值是过期时刻，读端只做数值比较）。修法：新增 `src/core/hostmem.ts` 的 `trimAged()`（值=最早使用时间，按升序删到上限）与 `dropExpired()`（值=过期时刻，删 `<= now`），上限收进 `SC.HOST_MEM_MAX = 512`（`policy.ts` 原来的私有常量改成引用它，避免第二份真源）；`judge` 裁剪时同步删 `bigChan` 里落单的键（`bigDiff` 同时读两张表，落单会让判定读到别站点的通道）；`cfHost`/`vtSent` 先过期再压上限。顺带把 `verdictsync` 里自己抄的 `v.at + 1800000` 改成 `VT_TTL_MS`（7.154 删 `SC.VT_TTL` 之后这就是第二份 TTL）。锁：第 147 组 12 条（600→512、最旧被删、`bigChan` 与 `bigByHost` 同尺寸、`vtAck` 清过期、三处调用点的源码断言）。
- **已核查、不是缺陷**（留档免得再查一遍）：`refillPool` 抓源用的是 `fetch`（占 50 子请求额度），`cronScan` 的探活用的是 `connect()`；两者虽共用 `SCAN_SUB` 这个数字，但线上 `/<uuid>/logs` 里从未出现 subrequest 超限（`count 24 / persisted 22` 全是 `forced _Rd` 这类中继日志），说明探活并不吃抓源那份额度 —— 把 `SCAN_SUB` 再减一个「固定开销」会让冷启动发现速度直接砍半，所以不改。三条属于「短路/顺序」类，
- **7.159 自举审计（第 63–64 条）**：`S.smCnt`（`站点|通道` → 小响应次数，nginx 默认页判死要看 `n>=3`）的键是
  「客户端带来的站点名 × 池子里的中继」，两个维度都会涨，却只在整页/判死时才删那一行 —— 长命 isolate 里只增不减。
  修法是在写入后就地 `trimAged(S.smCnt, SC.SM_CNT_MAX = 512)`，且**留大删小**（这张表的值是次数不是时间戳，
  正刷垃圾页的通道计数会涨上去，删掉计数最小的那些反而是想要的语义）。
  同一批还修掉 `src/core/const.ts` 里「连续探活失败几次就不再占探测名额」那句：它落在 `PROBE_CONC` 头顶，
  读起来像在解释并发上限，实际说的是上面两个 `SCAN_BAD_MAX`/`PROBE_BAD_TTL` —— 已并进 `PROBE_BAD_TTL` 的行内注释。
  锁：第 148 组 6 条（700 个「站点|通道」后仍 ≤512、`trimAged` 留大删小、judge 源码里那句裁剪还在）。
  按函数行为写的单测永远测不到（分支没被执行）——这类缺陷只能靠端到端闭环证明或真实流量发现。
  · 7.81 `src/px/selector.ts` 冷 isolate 拉池子封顶 700ms（`ensurePool` 能拖 2–4 秒，那是用户等首字节的时间）；
  · 7.83 `src/route/relperf.ts` 代价函数纠偏：只有 ≥1MB 的传输才记吞吐，小样本按 `ttfb + 2000ms` 计
    （否则 45KB 正常页 18KB/s 比 4 字节 403 页 46KB/s 还「贵」，排序反向，实测 tput 4/24）；
  · 7.84 `src/proxy/dialer.ts` 拨号加 2500ms 超时 + 最多试两条中继（`connect()` 自身没有超时，挂死的中继会拖到客户端放弃）；
  · 7.85 `wantPx` 把「CF 托管目标」那一项收窄成 `cfHost && clientV6 && ...`：实测同时段 v4 客户端
    「直连 6/8、中继 5/8」，12 连打默认 10/12（p50 1516ms）vs 强制中继 3/12（p50 2836ms）——中继只对 v6 客户端值得。
- 选路现状（7.76–7.79 建立）：`src/route/relperf.ts` 的 `RelPerfTable` 记「站点 × 中继」首字节与下行 KB/s（EWMA 0.5/0.35、TTL 10 分钟、上限 512），
  排序链 `negOf → posOf → scoreOf → vAt`；`scoreOf` 有本站点样本按样本、没有用跨站点聚合 +200ms 兜底；
  代价按模式取（吞吐 `ttfb + 512KB/kbs`，延迟只看 `ttfb`）；吞吐模式冷启动给「本站点没量过」的中继采样机会（`rel-rot`），延迟模式走 `cold-pin`。
  `/<uuid>/debug?rt=<host>` 可看某站点已量过的中继，`?rx=<ip>&px=1` 可钉住一条中继做对比。
  · `?rx=<ip>`（7.74）：把一条连接钉到指定中继上（配 `px=1`），只给诊断脚本用；`.tmp-sim/rbench.mjs` 靠它逐条量中继容量（实测 275 – 1642 KB/s，差 6 倍；另有两条握手必失败）。
  · 订阅新增 `🔁 中继优选`（7.75）：成员 `r-<ip>-<VL|TJ><T|L>`，路径带 `px=1&rx=<ip>`，用 url-test 打 `/health`，让**客户端**用自己到每条中继的真实路径逐条实测并选最快——服务端记不住这个排名（不跨 isolate 共享），客户端实测是唯一不破约束的做法。`?e=0` 时不发这些条目。
  · `/<uuid>/debug?bench=<url>&bytes=<n>`（7.73）：量**Worker 出口到源站**的吞吐（20 秒封顶）。实测 `speed.cloudflare.com` 8MB / 53ms ≈ **147 MB/s** ⇒ 源站那一腿不是瓶颈；客户端→边缘是**双峰**（~360 KB/s 与 ~2.1 MB/s），对应不同中继/边缘路径。
  · `src/proxy/connection.ts` 的带宽结算间隔 15s → **5s**（`now - this.lastEmit >= 5000`），否则一次十几秒的大下载只够采一个样本。
  · **量之前先比直连基线**（`.tmp-sim/netbase.mjs`）：链路拥塞时本机直连也只有 280–465 KB/s，别把 ISP 拥塞算到中继头上。
- 选路现状：`SC.POLICY = 2`（判定层全生效）；冷 isolate 由 `src/px/warm.ts` 的 `seedAlive` 起搏（不 await）。判定表从 7.134 起**不允许目标 `*` 落表**：写入端 `VerdictTable.blockWild` 直接拒绝并计 `vwild`，`ok/bad` 不再有通配回落，通道类型只有 `d` 与 `r:<ip>`（`e:` 随入口偏好表一起删除）。
- 正在攻的问题：CF 托管站点（如 x.com）经中继仍会有 ~20–30% 的 4 字节 `IPv6` 403 —— 根因是中继出口地址族，服务端只能「学」（`CF_NEG` 软降权 + 站点级硬封锁）不能改。7.71 起加了「正记忆」（`JUDGE.markPos/posOn`，10 分钟、仅本 isolate）：某条中继刚给该站出过整页就排到队首，突发并发成功率从 ~70% 提到 ~90%（20 并发 × 4 轮 73/80）。注意：**不要在连接内重放 ClientHello 重试**——Worker 只看得见 TLS 密文，首块永远是 ServerHello，识别不了 4xx 页（该实验已回退）。也不要「先缓冲首块、发现是小响应再换中继」：https 里看不到方法，重放会重复投递 POST。7.72 起 `stick` 排序多一层 `HEALTH.rank` 健康度（站点无关），并加了 `smN`/`smD` 归因计数——但**计数器是每 isolate 一份**，跨 isolate 归因只能看 `/<uuid>/stats`（不含 cnt），不要拿单个 `/health` 的数字当全局结论。
- OOP 收类已完成到「有模块级可变状态就有类」：`Pool`、`Scorer`、`Store`、`SeedStore`、`VerdictTable`、`Judge`、`Policy`、`RelayHealth`、`SourceHealth`、`PendingLedger`、`HostProfile`、`ErrRing`、`RouteTable`……（清单见 `docs/ARCHITECTURE.md` 的「类与职责」表）。剩下的是纯计算/纯渲染模块，按约定**不**改成类。
- `subtls` 已删除（7.69）：`src/vendor/{subtls.js,subtls.d.ts,roots.js}`、`src/core/tlsprobe.ts`、`src/route/{probe,sweep}.ts` 及其端点（`?tls=`/`?raw=`/`?tlsnow=`/`DO /meter/{probe,raw,dbt}`）全部移除，包体回到 1.4MB 级。
- **第 65 条（v7.160）中继存活度的证据没有时间戳**：`RelayHealth.delta()` 把 `{ i, o, b, d }` 送上 DO，
  `HlRow` 本身也没有时间字段，于是冷启动 `merge()` 只能把别处的证据一律当成「刚刚观测」——
  而 `score()` 的 30 分钟半衰期正是按 `at` 算的，对最容易过期的那批数据（别的 isolate 几小时前记的「存活/死亡」）完全失效。
  修法：`HlRow` 加可选 `t`（缺省时按「刚刚」算，兼容老 DO 行）、`delta()` 带上 `s.at`、`merge()` 用 `Math.max(本地, min(别处, now))` 取较新的那个、
  `Meter` 的 `hl` 记录与 `/hl`、`/vt` 一并带时间；锁：第 150 组 5 条（三小时前 → 回落中性、刚发生 → 照旧、增量行带 `t`、DO 存下 `t`、冷启动合并后仍按证据时间衰减）。

- **第 66–69 条（v7.161，都是中继健康表 `src/route/relay-health.ts` 的边界）**：
  · 66：`needLoad()` / `markLoaded()` / `loaded` 三个成员**零调用点** —— 冷启动加载实际由
    `vtLoad()` 的 single-flight + `HEALTH.merge()` 负责，这三人组只会让人以为「忘了标记已加载」。已删。
  · 67：`merge()` 逐字段取 `Math.max`、时间却单独取「较新的那个」⇒ 两边的观测被拼成一条从未存在过的证据。
    本地 3 小时前的 8 次成功会顶着「刚刚」的时间戳算分（半衰期等于失效）。改成**一条证据整体胜出**：
    条数多的胜出，条数相同用较新的时间；计数与时间永远来自同一次观测。
  · 68：`drop()` 只清 `m`/`sent`，不清 `pending`；`ack()` 又会把 `pending` 里的行写进 `sent` ——
    表外键因此在 `sent` 里永久驻留（`size()` 只看 `m`，泄漏不可见）。补 `pending.delete(k)` 与
    `ack()` 的「只登记表内键」。
  · 69：`delta()` 的上限判断写在 `push` 之后 ⇒ `pending` 已满 40 行时返回 41 行，突破「每批 ≤40 行」契约。判断前移。
- **第 70–71 条（v7.162，判定表的增量上报）**：
  · 70：`S.vtPend` 只存到期时间，重发时硬写 `s: 2` ⇒ 一条 `state=3`（dead，硬排除）的证据只要
    在「已交出、未 ack」期间被再要一次，就会降级成 `blocked`（软降权），硬排除消失。
    改成待发项记 `{ s, t }`，状态与时间同源；`vtAck` 用 `p.t` 记账。
  · 71：`vtDelta()` 的上限判断写在 `push` 之后 ⇒ `pending` 已满 60 行时返回 61 行，突破「每批 ≤60 行」
    （与 7.161 修的 `PendingLedger.delta()` 是同一个 shape）。判断前移。
- **第 72 条（v7.163）`ps` 的「历史最好」没有上线**：`PsRow.top`（只升不降）是 7.138 为康复通道加的证据，
  但线格式 `PsWire` 只有 `q`/`n`/`at`，`load()` 又写死 `top = q` —— 跨 isolate 冷启动后「曾经行过」退化成「现在还行」，
  D29 的死锁在每个新 isolate 里复发（那段代码的注释还写着「宁可低估」，把缺陷说成了取舍）。
  修法：`PsWire` 加 `top?`、`delta()` 带上 `top: r.top ?? r.q`、DO 侧 `mergeFacts` 按「远端 / 当前均值 / 已有」取最大、
  `/vt` 也发 `top`；旧行仍按当前均值起算（不能假装曾经行过）。锁：第 153 组 6 条（远端 top 不被均值覆盖、旧格式行不能把已知最好改小、增量带 top、DO 两次写入取最大、源码里有 `top: r.top ?? r.q`）。
- **v8 事实层现状（7.88–7.107，均已上线或可开关）**：五类事实 `eg`/`ps`/`dead`/`blk`/`dns` + `cap` 噪声门 + `first/lat` 观测全部在仓库，
  由 `src/route/factflags.ts` 的 plain_text 绑定 `facts` 统一开关（`none`/`eg`/`eg,ps`/`all`，未配置=全开）；
  `FACTS`（`src/route/factsstore.ts`）是五张同步表唯一的上行/合并门面（v7.139 才把第五类 `dns` 的 `ack/nack/snap` 接上）；`tools/check-wire.mjs` 静态保证「有定义必有生产调用」。
  **当前线上 `facts=eg`**（只开出口族）：`eg` 已改成**从真实响应推导**（`egDerive`：整页 ⇒ v4；有对照的小页 ⇒ v6），
  不再依赖保真度存疑的 `probeEg`（它测到的是探测器自己的出口）。7.116–7.120：冷 isolate 用 `eg` 里的 v4 出口兜底、
  CF 站点按族分层（v4 1 / 未知 40 / v6 40）、订阅的中继条目改用事实层 v4 出口铺底；实测 tput 38/40 = 95%、钉 v4 18/18。
- 文档索引：`docs/ARCHITECTURE.md`（分层/类与职责/注释约定）、`docs/评分机制_final.md`（打分与抽样）、`docs/判定模块设计.md`（判定层）、`docs/本地验证.md`（能本地验 vs 必须真 CF）、`docs/LIMITS.md`（平台限制实测）。
- **S3（`ps`）评估结论（2026-11-15）**：`facts=eg,ps` 与 `?fx=eg` 交替配对 40 对 → 30/40 vs 30/40，**差 0（±7.3）**。
  原因是 7.121 之后 CF 托管站点默认直连，`ps` 没有作用面；代码保留、绑定保持 `eg`。结论是「无作用面」而非「测出变差」。
