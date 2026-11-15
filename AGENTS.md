# AGENTS.md

给在这个仓库里干活的 AI/人类协作者的交接说明。目标：**任何一次改动都能被门禁证明、能被回滚、不会把线上搞挂**。

项目：`cf-proxyx`（`package.json` 名，版本号 1.0.0；实际对外版本是 `src/core/util.ts` 的 `VERSION`，线上 **7.123**、仓库 **7.147**（自举审计二十七批、共 44 个缺陷，均未部署））。
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
- **CRLF**：仓库里 CRLF/LF 混排。`test/test_score.mjs` 过去是「每行 `\r\r\n`」的畸形行尾（等于每行后面跟着一个空行），7.134 已归一成纯 CRLF；其余文件仍是混排。锚点匹配前先 `s.includes("\r\n")` 探测，写回统一 `lines.join("\r\n")`；用 `"\n"` 硬拼锚点会一直 `anchor miss`。
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

- **已核查、不是缺陷**（留档免得再查一遍）：`refillPool` 抓源用的是 `fetch`（占 50 子请求额度），`cronScan` 的探活用的是 `connect()`；两者虽共用 `SCAN_SUB` 这个数字，但线上 `/<uuid>/logs` 里从未出现 subrequest 超限（`count 24 / persisted 22` 全是 `forced _Rd` 这类中继日志），说明探活并不吃抓源那份额度 —— 把 `SCAN_SUB` 再减一个「固定开销」会让冷启动发现速度直接砍半，所以不改。三条属于「短路/顺序」类，
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
- **v8 事实层现状（7.88–7.107，均已上线或可开关）**：五类事实 `eg`/`ps`/`dead`/`blk`/`dns` + `cap` 噪声门 + `first/lat` 观测全部在仓库，
  由 `src/route/factflags.ts` 的 plain_text 绑定 `facts` 统一开关（`none`/`eg`/`eg,ps`/`all`，未配置=全开）；
  `FACTS`（`src/route/factsstore.ts`）是五张同步表唯一的上行/合并门面（v7.139 才把第五类 `dns` 的 `ack/nack/snap` 接上）；`tools/check-wire.mjs` 静态保证「有定义必有生产调用」。
  **当前线上 `facts=eg`**（只开出口族）：`eg` 已改成**从真实响应推导**（`egDerive`：整页 ⇒ v4；有对照的小页 ⇒ v6），
  不再依赖保真度存疑的 `probeEg`（它测到的是探测器自己的出口）。7.116–7.120：冷 isolate 用 `eg` 里的 v4 出口兜底、
  CF 站点按族分层（v4 1 / 未知 40 / v6 40）、订阅的中继条目改用事实层 v4 出口铺底；实测 tput 38/40 = 95%、钉 v4 18/18。
- 文档索引：`docs/ARCHITECTURE.md`（分层/类与职责/注释约定）、`docs/评分机制_final.md`（打分与抽样）、`docs/判定模块设计.md`（判定层）、`docs/本地验证.md`（能本地验 vs 必须真 CF）、`docs/LIMITS.md`（平台限制实测）。
- **S3（`ps`）评估结论（2026-11-15）**：`facts=eg,ps` 与 `?fx=eg` 交替配对 40 对 → 30/40 vs 30/40，**差 0（±7.3）**。
  原因是 7.121 之后 CF 托管站点默认直连，`ps` 没有作用面；代码保留、绑定保持 `eg`。结论是「无作用面」而非「测出变差」。
