# AGENTS.md

给在这个仓库里干活的 AI/人类协作者的交接说明。目标：**任何一次改动都能被门禁证明、能被回滚、不会把线上搞挂**。

- 线上 **7.270**（已部署、可跑）｜仓库 **7.350**（存活表的读写器由收尾执行器自己持有：模块级 `ALIVE` 退场，`PoolScan` 不再转出它，共 215 个缺陷皆已修复）：两者差 80 个版本。
形态：Cloudflare Workers 上的 VLESS/Trojan over WebSocket，带 proxyip 候选池、节点评分与轮换、用量计量、封锁判定与调度预算。

---

## 1. 不能破的六条硬约束

1. **统计不跨 isolate 共享。** `px:seed` 里只放 `{k,h,p,cc}`（名字与地址），延迟/成功率/带宽全部留在本 isolate 内存。理由：每个 isolate 到同一节点的 RTT 可能差一倍，共用统计会让选路持续选错。
2. **没有 2xx 就不写封禁。** 封锁证据只来自「同一时间窗内，同站点有通道拿到 2xx、另一条没有」；全 4xx / 全超时只能 `rotate` 换出口重采，绝不能把站点或出口标记成 blocked。业务 403（如 `api.github.com`）必须原样透传。
3. **绝不部署明文包。** `tools/check-obf.js` 是发版硬闸（严格关键字必须 0、`a_0x >= 100`、无 `class Meter` 明文），已前置进部署脚本，失败即 `REFUSE`。用户对此有过明确指令。
4. **入口偏好只能客户端实测。** Worker 访问自家域名必然 522 自环，所以服务端探「客户端→边缘」在物理上不成立。订阅发 `server: <ip>` 条目 + `🌐 入口优选`（`url: https://<host>/health`、`expected-status: 200`）让客户端自己挑；`?e=0` 关闭、手动 `nodes` 优先。
5. **免费计划的三条额度必须留余量。** ① 同时打开的 `connect()` ≤ 6（`SC.PROBE_CONC = 6`，除非你确认改的是别的量）；② 一次调用 fetch 子请求 ≤ 50（硬上限 `SC.SCAN_SUB = 48`；固定支出见 `src/route/budget.ts` 的 `SUB_FIXED`：固定支出 14（源 6 / 判定批 2 = 直连探针 + 中继批 / DoH 6 = 2 个站点 × 3 个解析服务），剩下的 `plan.sub = 34` 由 `planRound` 分成三批「每人一次 DO 往返」：上报 17 / 快照 10 / 回填 7（7.242 之前把上报与快照按调用点数记成 1 和 4，真实最坏 32 + 24，一轮能到 85 次））；③ DO CPU 只有几十毫秒 —— 单发 TLS 握手只能走 `tunnelfetch`（`src/core/tf.ts`）；vendored `subtls` 与 `core/tlsprobe.ts` 已在 7.69 整体删除（免费计划必 1102），不要再引入 userland TLS。
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
  7.163 的文档脚本就是这样在 `AGENTS.md` 与 `src/core/util.ts` 上造了 1200 行纯行尾 diff（内容一字未改），而且留下的是**多 CR 行尾**
  （`\r\r\n` / `\r\r\r\n`，7.165 实测 AGENTS.md 309 处、util.ts 299 处）。`tools/check-arch.js` 现在把「`\r+\n` 只能是单个 `\r\n`」做成门禁 ——
  只数 `\r\n` 的检查抓不到它（多 CR 里本来就含一个 `\r\n`）。
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
- **7.138–7.159 的 34 条缺陷（第 28–64 条）**：逐条证据、修法与锁都在 `docs/v8实现清单.md` 的 H6 表（行 28–64），
  这里只留反复出现的六种形状 ——
  ① 「读端有、写端没有」：通配判定 `*|通道`、入口偏好 `edge:pref`、差分复核队列 `S.vtQ`（三条都是「看着有兜底，其实没人写」）；
  ② 「写端有、读端没有」：`ps`/`dns` 的 `sent` 表、`S.tsMem`、`RelayHealth.needLoad/loaded`（长跑只增不减）；
  ③ 两边都在但问的不是同一个问题：康复通道用会衰减的 `psOk` 判「历史上拿到过整页」，而它回答的是「现在行吗」；
  ④ **跨界传值时丢掉一个维度**：`HlRow` 丢时间戳（半衰期失效）、`vtPend`/`Meter.vt` 丢状态（`dead` 降级成 `blocked`）、
     `PsWire` 丢 `top`（康复证据每个新 isolate 都要重新攒）——同一形状在同一条链路的四个不同层各犯一次；
  ⑤ 「上限判断写在 `push` 之后」：`delta()` 在待发已满时返回 41/61 行，突破「每批 ≤40/≤60」契约；
  ⑥ 「语义与注释不符」：`eq` 用 `JSON.stringify` 比较使「函数已删除」成为空断言、注释落在错误的分支上方、
     文档宣称的能力（`Bearer` 鉴权、`Store.usageSnapWrite`、`pickHosts`）从来没有真正生效。
  共同结论：**行为测试全绿时缺陷仍在**，它们只藏在跨模块组合、失败路径与状态表边界里；
  能抓住它们的只有闭环证明（`tools/exp-v8proof.mjs`）、真实流量，以及「按字段/按端点做读写点对照」的机械扫描。
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
- **第 73 条（v7.164）DO 把判定表的状态丢了**：`Meter.vt` 只存到期时间（`vt[k] = r.t`），`/vt` 又硬写 `s: 2`，
  而 v7.162 刚在发送侧修掉同一个形状（`vtPend` 只存到期时间 ⇒ 重发把 `dead` 降级成 `blocked`）。
  存储层这一跳漏得更彻底：`state=3`（dead，硬排除）只要被任何冷 isolate 读回去就变 `state=2`（blocked，×6 降权），
  一条连不上的中继会继续留在候选链里占 `connect()` 名额（免费计划全局 6 个）。
  修法：`vt` 存 `{ s, t }`，合并口径「更晚到期的胜、同一时刻取更严格的状态」，老数据（裸数字）按 `blocked` 读；
  `/vt` 发真实状态。锁：第 154 组 6 条（dead 往返仍是 dead、更晚的观测决定状态、同刻取更严、老格式读成 2、源码断言）。
- **第 74 条（v7.165）空关闭的门槛每一跳都清缓存**：`src/nodes/stat.ts` 的 `nsEmptyClose` 在客户端连上又立刻断开时，
  把「节点可能有问题」记进 `eCloseP/eCloseD` 并清 `S.hostRankCache`，但门槛写成「累计计数 ≥ 5」；
  而 `eCloseP` 是按 6 小时半衰期衰减的累计值，一旦跨过 5 就长期 > 5 ⇒ **之后每一条空关闭都清一次站点排行缓存**，
  等于把这个缓存永久关掉（每次请求都重排几百个候选）。改成「跨过门槛的那一条」才清：
  `if (before < EMPTY_CLOSE_BAD && before + 1 >= EMPTY_CLOSE_BAD) S.hostRankCache.clear();`。
- **第 75 条（v7.165）探活的 `ms` 参数是死的，注释却说它会进首字节统计**：`nsProbe(key, ms, tcp, tls)` 里 `ms` 从未被使用
  （探活只累加 `pN` 与 `tcp/tls` 的 EWMA），而它的文档与 `nsLatency` 的注释都写着「真实首字节」「probe 的 p 统计」——
  读的人会以为探活样本也在给首字节的均值/方差供数。已把 `ms` 改名 `_ms`，并在两个函数的文档里写明「探活只给样本数与 tcp/tls，
  首字节的矩只由真实连接写」。
- **第 76 条（v7.165）`AGENTS.md` 与 `src/core/util.ts` 的每一行都是多 CR 行尾**：7.163 的文档脚本按行 `join("\r\n")` 写回，
  把两个纯 LF 文件翻成多 CR 行尾（util.ts 299 行全是三 CR、AGENTS.md 309 行四 CR + 15 行两 CR）—— 不报错、tsc 也不管，
  但 git 把每一行都算成改动，而「数 `\r\n`」的检查抓不到（多 CR 里本来就含一个）。已归一成单一 CRLF，
  并把「`\r+\n` 只能是 `\r\n`」做成 `tools/check-arch.js` 的门禁（命中即 exit=1，含 `docs/*.md` 与 `AGENTS.md`）。
- **v8 事实层现状（7.88–7.107，均已上线或可开关）**：五类事实 `eg`/`ps`/`dead`/`blk`/`dns` + `cap` 噪声门 + `first/lat` 观测全部在仓库，
  由 `src/route/factflags.ts` 的 plain_text 绑定 `facts` 统一开关（`none`/`eg`/`eg,ps`/`all`，未配置=全开）；
  `FACTS`（`src/route/factsstore.ts`）是五张同步表唯一的上行/合并门面（v7.139 才把第五类 `dns` 的 `ack/nack/snap` 接上）；`tools/check-wire.mjs` 静态保证「有定义必有生产调用」。
  **当前线上 `facts=eg`**（只开出口族）：`eg` 已改成**从真实响应推导**（`egDerive`：整页 ⇒ v4；有对照的小页 ⇒ v6），
  不再依赖保真度存疑的 `probeEg`（它测到的是探测器自己的出口）。7.116–7.120：冷 isolate 用 `eg` 里的 v4 出口兜底、
  CF 站点按族分层（v4 1 / 未知 40 / v6 40）、订阅的中继条目改用事实层 v4 出口铺底；实测 tput 38/40 = 95%、钉 v4 18/18。
- **7.166 自举审计（第 77 条）**：拨号重试的「第二条」会和第一条选到同一条中继 ——
  `Dialer.open` 的 `for (let tries = 0; tries < 2 && !sock; tries++)` 每圈都调 `SEL.current(...)`，
  而选择器的确定性路径（站点偏好 `HOOK.prefer` / 非 CF 优先带 `HOOK.nonCfFirst`）在同一秒内两次返回**同一条**：
  `nsFail` 的惩罚不足以让它掉出第一，`isFrozen` 要连续多轮失败才触发 ⇒ 「最多试两条」退化成「同一条试两次」，
  白等第二个 2500ms，而 CF 托管目标退回直连大概率 4 字节 403。修法：`current(..., exclude)` 三处路径都跳过已试过的键、
  随机路径抽到已试过的就按通用分数重扫一遍（全被排除则回空），`Dialer.open` 用一个 `tried: Set<string>` 串起来；
  `?rx=` 钉住时只试一次（诊断语义就是「我就要这一条」）。锁：第 156 组 7 条（两次调用同一条、排除后换一条、全排除回空、三条源码断言）。
  **同批还发现一条门禁自己会假红**：`tools/exp-v8chain.mjs` 的第 5 步断言「被判封锁的更快中继排到后面」，
  而 `Policy.decide` 有一条「5% 概率挑一条被判封锁的中继去复检」的探索早返回 —— 20 次跑挂 1 次（5.0%），
  与探索概率完全吻合。这在 preflight 里表现为「随机档期随机失败」，最容易被当成噪声重跑掉。
  修法：断言前把 `Math.random` 钉成 0.99（不进探索），另加一条锁住探索语义（`Math.random = () => 0` ⇒ `why === "explore"` 且返回被封锁的那条）。
### 7.167 自举审计（第 79 条）

- **链接订阅是三种格式里唯一没把入口钉成 IPv4 的**：Clash 用 `server: <边缘 IPv4>` + `servername: <域名>` + `ip-version: ipv4`，sing-box 用 `domain_strategy: "ipv4_only"`，而 `src/views/sub-links.ts` 的 `vless://<uuid>@<域名>:<port>` 两样都没有 ⇒ 双栈网络上客户端把域名解析成 AAAA，CF→CF 把 v6 出口原样透传给目标，正是 7.49 之前 FlClash 打开 X 拿到 4 字节 `IPv6` 403 的那条路径。链接格式没有 `ip-version` 这类字段，所以钉法与 Clash 相同：`@<边缘 IP>` + `host=`/`sni=` 指回域名。
- 修法：`manual`（`env.nodes` 非空）或 `?e=0` 时不钉（与 Clash 的 `noEdge` 同义）；否则 `edgeIps = X_EDGE_IPS.slice(0, 8)`，主循环与地区条目都按 `ei++ % edgeIps.length` 轮转取 IP，`n.host` / `host` 作为无 IP 时的回退。
- 验收：`test/test_score.mjs` 第 157 组 7 条（每条都是 IP 字面量、`host=`/`sni=` 仍是域名、IP 至少三种、`?e=0` 退回域名、手动节点不钉、地区条目也钉、源码里有 `X_EDGE_IPS.slice(0, 8)`）；golden 8 项不变（golden 的 `env.nodes` 非空 ⇒ 走手动分支，输出与改前一致）。A/B：旧代码 1107 通过 4 失败 → 新 1111/0。
### 7.168 自举审计（第 80–81 条）

- **「连不上」被说成「故意跳过直连」**：`src/proxy/dialer.ts:147` 原来写 `if (!sock) throw new Error("skip-direct")`，而这条路径成立的前提是「中继全试过、`dial4` 与 `dial` 都没给出 socket」——`dial()`（`src/proxy/dial.ts:176`）的每个出口要么 `return` 一个 socket、要么 `throw`，从来不会返回 null ⇒ 这行**永远不可达**，一旦可达就是「连不上」而不是「跳过」。`src/proxy/session.ts:196` 有同一句话的第二份：`sock` 在 `REGION.open` 回空时已经 `return`、`DIALER.open` 只会返回 socket 或抛错，所以那里同样不可达。真正的危害是 `/logs` 里只留一行 `ws: skip-direct`，读的人会以为「这条连接是故意放弃直连的」，看不到底层失败原因。
- 修法：两处都改成 `throw new Error("dial returned null")`（如实描述「两条拨号路径都没给出 socket」），并在 `session.ts` 的守卫上方写清「这里只为把类型收窄成 `Socket`，两条路径都不返回 null」以及历史标签的来历。
- **脚本补丁打乱的缩进**：`src/proxy/connection.ts` 的 `flush(closing)` 里，`HOOK.relPerf?.(…)` 那一行被历次脚本改成了**顶格（缩进 0）**，`HOOK.traffic` 那段与 `nsLatency` 那行少缩进两格（块内层级读起来是断的，且与 `nsStall`/`S.cagg` 两段的缩进不一致）。修法：只改空白（同时验证 `git diff --stat` 里该文件只有缩进变化），并加一条锁：`src/proxy/connection.ts` 里不允许出现顶格的语句、`HOOK.relPerf` 那行必须是 10 空格。
- 教训：`// 通道证据` 那段注释与代码曾经在 `if (!this.counted)` 里（7.108 前后挪过位置），脚本按行替换时把缩进一起挪丢了；这类改动不会让任何门禁变红，只有人读代码时才会发现。
### 7.169 自举审计（第 82–85 条）

- **第 82 条：补救链上的 `connect` 没有超时。** 主路径 `Dialer.open`（`src/proxy/dialer.ts:112-132`）给
  `connect()` 包了 `withTimeout(pk, 2500)`，注释也写明「`connect()` 自己没有超时，挂死的中继会把整个请求拖到
  客户端放弃为止」；但补救链三处（`src/proxy/fallback.ts:41`、`src/proxy/attacher.ts:98` 的 IPv6 兜底、
  `src/proxy/attacher.ts:137` 的 proxyip 兜底）都是裸 `await connect({...})`。补救链跑在客户端已经等了两三秒
  之后，挂死的代价更高；超时迟到成功的 socket 也没人关（7.86 学到的「6 个并发 connect 名额」）。
- **第 83 条：递归重试覆盖 `st.sock`/`st.writer` 不释放旧的。** `Attacher.run` 只做赋值，而 `releaseAll`
  只在 `session.ts` 的 `.finally` 里对**当前** socket 调一次 ⇒ 每重试一次漏一个 socket + 一把写锁。现在
  `run` 开头先 `if (st.sock && st.sock !== sock) releaseAll(st);`。
- **第 84 条（证伪，记下来免得再查）：`st.syncInflight()` 可以重复调用。** `src/proxy/connection.ts:206-216`
  按 key 幂等，只有 key 变了才把旧 key 减一、新 key 加一。
- **第 85 条：死条件与不记账。** `attacher.ts:110` 的 `if (!px || st.retried)` 里 `st.retried` 永远不生效
  （上面第 ④ 支已经 return）；`catch` 只 `close(1011, "proxyip failed")`，既不 `nsFail` 也不计数 ⇒
  一条「池子里能解析但连不上」的中继会被无限重复挑中。
### 7.170 自举审计（第 86–88 条，地区硬分流）

- **第 86 条：地区分流的两条 `connect` 没有超时。** `src/proxy/region.ts` 的 `RegionPicker.open` 是
  `?rg=xx` 的唯一入口（硬要求：找不到 / 连不上就明确失败，绝不回落），但两次 `connect()` 都是裸 `await`——
  和 7.169 修的补救链是同一个形状：主路径有 `withTimeout(pk, 2500)`，地区路径没有。挂死时客户端只会一直等。
  修法：两处都包 `withTimeout(…, 2500)`，并把超时迟到成功的 socket 关掉（免费计划全局 6 个并发名额）。
- **第 87 条：同一个节点一次失败罚两次。** 第一次 `connect` 失败已经 `nsFail(st.node)`；如果同国没有备选
  （或备选被 `checkTarget` 拦下），`st.node` 还是那一个，函数末尾又 `nsFail(st.node)` 一次 ⇒ `streak` 跳两档、
  `bad`/`fail` 记两次。小池子里一节冷却 10 秒会直接变成 60 秒，而这个地区可能只有这一条节点。
  修法：记 `failed` 变量，只有换到别的节点时才再罚一次。
- **第 88 条：地区失败被记成「目标不可达」。** `session.ts` 的 `failRegion` 把三种原因（该地区没节点、
  节点地址被策略禁止、节点连不上）都记成 `cnt("dead")` + `st.dead = true`，而 `dead` 在别处专指
  「目标站连不上」⇒ 面板上 `dead` 升高时分不清是站的问题还是池子的问题。改成 `cnt("rgFail")`
  （`st.dead = true` 保留：它是「后续帧不要再解析」的闩，与计数无关）。
### 7.171 自举审计（第 89–90 条）

- **第 89 条：会话层补救链还有一处裸 `connect`。** `Dialer.open` 抛错后，`src/proxy/session.ts` 会「临时取一条中继直连」
  （`SEL.current` → `parseProxyIp` → `connect`），这条路径也是补救链的最后一跳，却和 7.169/7.170 修过的
  `fallback.ts` / `attacher.ts` / `region.ts` 三处不同：没有 2500ms 上限，超时迟到成功的 socket 也没人关。
  现在补上 `withTimeout(pk0, 2500)` 并在 `catch` 里关掉迟到的那条（免费计划全局 6 个并发 `connect` 名额）。
- **第 90 条：地区钉住的失败被记成「目标不可达」。** `src/proxy/attacher.ts` 的 `st.retried` 分支（「换节点也不通」）
  无条件 `cnt("dead")`，但 `?rg=xx` 这条路上 `dialAnother` 被限定了同一地区 —— 走到这里可能只是「该地区没别的候选」，
  不是目标连不上。和 7.170 在 `session.ts` 里做的拆分同一个口径，改记 `rgFail`；直连那一支的 `dead` 保持不变。
### 7.172 自举审计（第 91–92 条，DO 端点的反方向）

- **判据反过来**：前几轮查的是「调用方有、实现方没有」（`/meter/{dbt,raw,hold,cont}` 那批），这一轮查
  「实现方有、调用方全无」——有完整代码、有文档提到，但没有任何路由能触发它，等于「写着的功能实际不可达」。
- **第 91 条：`/meter/http80` 死实现**。DO 侧那份 `probeHttp80(h, r, p)` 与 `src/routes/debug.ts` 的 `?http=`
  （`withTimeout(probeHttp80(...), 6000)`）完全重复，唯一的差别是它跑在 DO 里、要多吃一次 CPU 预算；零调用点。已删。
- **第 92 条：`/meter/reset` 死实现**。用量清零能力写在 DO 里（`this.c = { up: 0, … }` + `save()`），
  但没有任何路由或面板按钮能触发它 —— 想做「管理员清零」得先有管理员命令的权限设计，那是新功能不是修缺陷。已删。
- 顺带修掉一处**落错位置的注释**：`src/store/meter.ts` 里「只在当前为 0 时回填，天然幂等，重建脚本后能自动恢复历史用量」
  原本紧贴在 `/http80` 那一块上方，而它描述的是 `/seed` 的「累计为 0 才回填」分支 —— 已挪到 `/seed` 正上方（端点删掉后它会变成孤句）。
- **门禁补反方向**：`tools/check-wire.mjs` 原来只查「调用方是否有实现」，于是实现方被删也会静默通过。
  现在对每个 `endsWith("/x")` 的 DO 端点要求 `src/` 里（`meter.ts` 自己除外）必须出现 `https://meter/x`，
  否则报「有实现但没有任何调用方（死端点：能力写着，实际不可达）」并 exit=1（`/get` 走兜底是登记过的契约）。
- **自证**：把 `src/store/meter.ts` 换回旧版跑新 `check-wire` → 恰好报 `/meter/http80` 与 `/meter/reset` 两条、exit=1。
- 锁：第 162 组 4 条（两个端点已删、不再 import `probeHttp80`、回填注释回到 `/seed` 上方、`check-wire` 有反向检查）；
  旧代码上 4 条全红（1133 通过 / 4 失败），改后 1137/0。
### 7.173 自举审计（第 93–95 条，池子侧的死状态）

- **第 93 条：`NodeEntry.src` 写四处、读零处。** 存活表的条目里记着 `src: "pool" | "seed" | "probe"`，
  但全仓没有一处读它（`.src` 的其它命中都是判定行的证据来源、`SourceHealth` 的局部对象、`/debug` 的回显）；
  更糟的是探活命中时 `S.alive.set(k, {…, src: "probe" })` 会把整条覆盖 —— 连「来源」这件事本身都不成立。
  删掉类型字段与四处写入（`pool.ts` 的三处、`warm.ts` 的一处）。
- **第 94 条：`pxSet` 的 `alive` 分支零调用方。** 唯一调用者是 `/<uuid>/debug?cur=`，只传 `cur`；
  而那条分支会 `S.alive = new Map(patch.alive.map(…))` 整体替换内存里的存活表，绕过 `commitPool` 的代际号、
  KV 锚点与缩水守卫 —— 一旦有人接上就是「内存与 KV 脱节」。签名收成 `{ cur?: string | null }`，
  模块函数与 `Pool` 门面同步。
- **第 95 条：活文档体检只覆盖两份。** `doc-audit` 的 `LIVING` 原来只查 `docs/ARCHITECTURE.md` 与 `docs/v8.md`，
  `docs/LIMITS.md` 里 12 处 `src/…ts` / `SC.常量` / `name()` 引用从来没被核过（这次核完是干净的）。
  加进 `LIVING` 并做注入验证：塞一行伪引用 → `docs/LIMITS.md:155 \`SC.NO_SUCH_CONST\` → 常量不存在` +
  `\`noSuchFn()\` → 符号不存在`、exit=1；撤掉后 exit=0。
- 锁：第 164 组 5 条（类型里没有 `src?`、池子与 `warm` 四处写入都不带来源、`pxSet` 没有 `patch.alive`、
  签名只剩 `cur`、`LIVING` 含 `LIMITS.md`）。A/B：旧代码 1138 通过 / 4 失败，改后 1142/0。

### 7.174–7.183 自举审计（第 96–118 条）

这一段共 23 条缺陷，逐条证据、修法与锁都在 `docs/v8实现清单.md` 的 H6 表（行 96–118）。留在这里的只有**能复用的判据**：

- **第 96–100 条：一次调用的子请求预算有三个方向**。读方向（`usageSnapWrite` 逐用户 `meterGet`、面板 `ADMIN_STATS_MAX`）、写方向（`PendingLedger.flush` 一轮带全表 ⇒ 尾部用户永久饥饿，改 `PEND_MAX = 32` + 游标轮转），以及「谁有权确认」——`vt`/`hl`/`facts`/`cl` 只挂在主 uuid 一个请求体上，ack/nack 却写在每个批次回调里（7.176 的 `carriedBy`）。判据：**问「这一次调用最多花多少个往返」，而不是「并发多大」**。
- **第 101 条：`WS 分帧 ≠ UDP 分帧`**。`handleDns` 只解析单条消息 ⇒ 拆包的那次查询永久无应答；Trojan 侧还把「没到齐」和「非法」都当 `null`，直接 1003 断连。修法是给 `Connection` 加跨消息残留 `udpBuf`（`DNS_CARRY_MAX = DNS_MAX + 64`）。判据：**任何「一帧一条消息」的假设都要在协议层验证**。
- **第 102 条：恒等变换伪装成策略**。`alivePlan(x, 48)` 在 401 个 `alive` 取值下恒等于 48（加码值最大 20，被 `SCAN_SUB` 夹回），`ALIVE_MIN` 零读取点 —— 文档说「不够就加码」，代码里什么也没发生。判据：**给「策略函数」喂全量输入看它有没有真的改变输出**。
- **第 103–106 条：探测路径的预算与地址解析**。`probeTf` 内部要有自己的 `TF_MS`（超时只让调用方不等，DO 里的请求照样挂着）；`splitRelay` 必须认裸 IPv6 与 `[v6]:port`（按冒号拆会把 `2a06:98c0::1:443` 拆成 `2a06`）；`refreshCfHttp` 要有在途集合 + 负缓存（否则冷启动 6 条连接 = 6 次探测，吃掉全部 `connect()` 名额）。
- **第 107–114 条：上限、合并、口径**。四条通病：① 上限只写在一条写入路径上（`VerdictTable.set` 有 `sweep`、`setState`/`import` 没有；`S.needPx` 的上限只写在 attacher）；② 逐字段 `max` 会拼出从未发生过的证据（DO 的 `hl`）；③ 恢复/合并只让触发的那一维变大（`/set` 的字节维度）；④ 淘汰留最旧（`hl` 按插入顺序 `slice(200)`）。外加两条「静止的格子说的不是真相」（面板 `0 B`、`colspan=4`）与一条「注释还在描述已修的 bug」。
- **第 115–118 条：起搏样本与补救链**。`seedAlive` 不能把探活 RTT 写进真实首字节的矩（40ms vs 400ms ⇒ CUSUM 立刻冻结那唯一能用的中继）；派生密钥的缓存必须记「用哪份 kek 算的」（换 kek 后旧 isolate 会一直解不开，表现是 `kv unseal failed` + 快照当空表）；补救链遇到一条坏条目要 `continue` 而不是 `return null`，且要过 `HOOK.chanPref`（已判封锁的中继再拨一遍只有 403）。

教训：这 23 条里超过一半是「同一条规则只在一个调用点成立」，另一小半是「跨层传值丢了一个维度」（时间戳、状态、`top`）。两者都不报错、门禁全绿，只能靠**按字段/按端点做读写点对照**与**闭环证明**发现。
### 7.184 自举审计（第 119–121 条，唯一真源与 IPv6 地址）

- **D119 错误分类键没有上限**：`ErrRing.count()` 只在 `bucket.size > 64` 时删「非当前窗口」的键，而分类键是 `errKind(msg)` = 消息前两个词 —— `logErr(`tfb ${host} …`)`、`logErr(`forced proxyip ${p.host}`)` 这类把站点名/地址带了进来，**同一窗口里换站点就是一个新键**，于是窗口淘汰一个都删不掉；再叠加「每次写日志都要把整张表遍历一遍」，随机站点名即可把它撑成 CPU 放大（免费计划只有几十毫秒）。修法：窗口淘汰之后再按「本窗口计数最少」淘汰一次，表恒 ≤ 64 行，留下的是真正高频的那几类（面板 `errsByKind` 只取前 8）。实测 400 个不同站点：旧代码 401 行，新代码 64 行，且高频类 `cron: boom` 的计数原样保留。
- **D120 五类事实的寿命有两处真源**：`src/store/factmerge.ts` 里 eg=21600000 / ps=2700000 / dead=1800000 / blk=90×60000 / dns=86400000 是裸数字，而 `src/route/{eg,ps,dns}facts.ts` 与 `commitfact.ts` 各有一份同名常量。两处漂移的症状是「本地已经当它过期、DO 还当它是新鲜证据」，不报错、单测也测不出来 —— 7.154 的 `VT_TTL` 就是这么分裂成两份的。修法：`FACT_TTL`（`src/core/facts.ts`，core 层，store 与 route 都能取）做唯一真源，`factmerge` 与五个 TTL 全部改成 `FACT_TTL.xxx`（导出名保持不变，调用点与单测零改动）。
- **D121 IPv6 中继地址被拆成两截**：`src/core/tf.ts` 的 `probeTf` 用 `lastIndexOf(":")` 拆 `host:port`、`src/route/tfb.ts` 用 `split(":")[0]` 取 IP，`2a06:98c0::1:443` 会被拆成 host=`2a06`、port=`98c0` ⇒ 探测打到完全不相干的主机上，判定键还会被写成 `r:2a06`（写进判定表的键从此对不上真实中继）。7.180 在 `http80.ts` 修过同一处，这两处漏改。修法：两处都走 `core/http80.ts` 的 `splitRelay`（认 `[v6]:port` / 裸 IPv6 / 缺端口），拼地址用新增的 `relayAddr`（IPv6 加方括号）。
- 锁：第 174 组 12 条（`FACT_TTL` 五个数字、route 五个 TTL 与它相等、`factmerge` 不再含裸数字、400 个站点后 `bucket.size <= 64` 且高频类保留、`errlog` 的 `cold.length - 64`、`splitRelay` 的两种 IPv6 写法、`tf.ts`/`tfb.ts` 的源码接线）。A/B 只 stash `errlog.ts`/`tf.ts`/`tfb.ts`（`facts.ts` 与五个 TTL 别名是等价改写，留着才能解析）→ 旧代码 **1243 通过 / 4 失败**，恢复后 **1247 / 0**。
### 7.185 自举审计（第 122–123 条，探活又写回首字节矩与冷却源没真跳过）

- **D122 探活 RTT 第三次被写进真实首字节**：`src/px/pool.ts` 的三条探活路径（`refreshOne` 与 `probeAlive` 两支）都在 `nsProbe` 之后又调了 `nsLatency(k, x.ms)`。探活是「ClientHello → ServerHello」（40ms 量级），真实请求的首字节含 TLS 握手（400ms 量级）——`nsLatency` 的 `cus` 按 `ms - base` 累加，`base ≈ 40ms` 时第一条真实请求就 `+330 > CUSUM_H(300)`，把刚被扫出来的中继冻 60 秒、站点排行整份作废。同一处的对照组是 `reProbe` 分支，它本来只有 `nsProbe`。
- 修法：三处 `nsLatency` 全删（样本数仍由 `nsProbe` 累加），`nsLatency` 从 import 里去掉。
- **D123 冷却中的源从来没有被跳过**：`SourceHealth.rank(env)` 只把冷却源排到最后，`refillPool` 仍无条件 `fetch` 每一个源 ⇒ 文档声称的「避免白烧子请求预算」从未成立（免费计划一轮 48 个子请求）。
- 修法：`SourceHealth` 新增 `cooling(src, now)`（`n >= 2 && until > now`，`rank` 里那句判断改成调它，保持单一真源）；`refillPool(env, keep = 0)` 在池子够多（`Math.max(POOL_ENOUGH, ceil(keep * 0.75))`，`POOL_ENOUGH = 300`）时 `skip` 冷却源并记 `cnt("srcSkip")`，不够就照旧全抓（否则缩水守卫会拒掉整轮刷新，池子反而变薄）；`cronScan` 传 `S.pool.length` 当 `keep`。
- 锁：第 175 组 12 条（`pool.ts` 里 `nsLatency(` 计数为 0 而 `nsProbe(` ≥ 4；两次 `nsProbe` 后 `pN === 2` 且 `pSum === 0`；`cooling` 的四条状态迁移；池子够多时只发 1 次 `fetch` 且带 `skip`；只给 10 条时 3 次 `fetch` 且不跳；`POOL_ENOUGH === 300`）。A/B：`pool.ts` 退回旧版 → 红 1；删掉跳过判据 → 红 3。
- 教训一：`test/test_score.mjs` 的 `ok(n, c, info)` 第三参是**失败信息**不是 `want`，`ok("…", cond, false)` 永远是红的；要比较就用 `eq` 或写成 `cond === false`。
- 教训二：源码回退后不重新 `bundle` + `mk_test`，行为断言两边全绿（第一版 A/B 就这样假通过）——只有「读源码文本」的断言会红。

### 7.186 自举审计（第 124 条，假总闸与单测空锁）
- **D124 `Plan.cap` 是「写端有、读端没有」的假总闸**（`src/route/budget.ts`）。它自称「本轮总闸」，
  注释还写「refill + tfb 也在里面」，但生产侧只用过 `plan.adm`（`src/routes/cron.ts` 传给 `cronScan`），
  `cap` 从没有任何减法 —— 而 `test/test_score.mjs` 有五处断言拿它当上界（`q.adm <= q.cap`、
  `sum <= q.cap`），永远成立，等于什么也没锁。修法：把两笔账拆开写清楚 —— ① 探活吃 `connect()`
  额度（`SC.PROBE_CONC = 6`），按 `SCAN_MAX` 给满；② fetch 子请求额度是 `SC.SCAN_SUB = 48` 减去
  固定支出 `SUB_FIXED`（源 6 / 判定批 1 / DoH 2 / 上报 1 / 快照 4 = 14），剩下的 `plan.sub = 34`
  才是能自由分配的；`restorePick` 的上限改成 `Math.min(RESTORE_MAX, plan.sub)`（以前写死 12，
  与 48 没有任何数量关系，再加一个消费者就会静默撞线）。单测改成锁账本等式。
- **排除了一个「看起来像缺陷」的东西**：`withTimeout` 超时后那一半仍在跑，看起来会变成未捕获的
  rejection（1101）。A/B 把 `src/core/util.ts` 退回旧版跑单测：行为断言**两边全绿** ——
  `Promise.race` 挂上去时就给 `p` 同时挂了 resolve/reject 处理器，晚到的失败只是被丢弃。真正会造出
  未捕获 rejection 的是 `.then(完成分支)` 这种只挂一半的新链（dialer / region / session / fallback /
  attacher 那五处都显式跟了 `.catch`）。因此**没有**给 `withTimeout` 加多余的丢弃器，只在单测里
  留一条行为基线：超时后等到那一半真正失败，进程不能崩。
- 教训：A/B 必须能红。这一轮的「修复」是被 A/B 自己否掉的 —— 只看源码就动手，会多出一段没人需要、
  还掩盖真实信号的空实现。

### 7.187 自举审计（第 125–126 条，出站切片与建连超时）

- **D125 出站事实按插入序切片**：`src/store/meter.ts` 的 `/vt` 把七张表打出站，七张表的上限是
  200/200/512/1024/512（vt/hl/eg/ps/dead/blk2/dns，前两个 200）却只发 120/120/160/200/120/120/160 行；
  `eg`/`ps`/`dead` 在返回前显式按 `at` 降序排过，`vt`/`hl`/`blk2`/`dns` 是直接 `slice(0, n)`。
  而 `Object.entries` 是插入序、合并只会追加新键 ⇒ 切出来的是**最旧**的那批：新学到的证据在本地
  躺着，永远到不了别的 isolate（`blk2` 表上限 1024 却只发 120 行）。同一形状 7.177（pend 星形饥饿）、
  7.181（`hl` 淘汰留最旧）修过两回，出口这一层漏了。修法：出站形状整体搬到新建的
  `src/store/factout.ts` 的 `factsOut(src, now)`，七张表统一走 `freshTop(rows, at, n)`（超上限才排序、
  降序取前 n）；`meter.ts` 的 `/vt` 只剩一行委托（557 → 540 行，也顺便给 560 行上限腾出余量）。
- **D126 诊断默认分支的 `connect` 没有超时**：`src/routes/debug.ts` 的 `?host=`/裸 debug 分支
  `const s6 = await connect(...)` 直接 await，黑洞 v6 地址会一直挂着，占住免费计划全局 6 个 `connect`
  名额之一（7.169–7.171 修过五处同类）。修法：`Promise.resolve(connect(...))` + `withTimeout(pk, 2500)`，
  catch 里把迟到连上的 socket 也关掉。
- 顺手把构造函数里被脚本打散缩进的九行（`o.blk`…`o.blk2`）恢复成 8 空格。
- 锁：第 177 组 18 条（300 行 vt / 250 行 hl / 1100 行 blk2 / 600 行 dns 全都超过响应上限，
  断言「取到的是最新那条」；老格式裸数字仍按 blocked、`dead` 保持 3、过期行一条不发；
  `freshTop` 直接按时间戳降序；`meter.ts` 用 `factsOut(this)` 且不再自己拼 `blk2`）。
  A/B：切片退回插入序 → **7 红**；`debug.ts` 退回 HEAD → **2 红**（两条都是源码锁）。

### 7.188 自举审计（第 127–128 条，没有生产者的旧表与热路径三次扫描）

- **D127 旧封锁表没有生产者，诊断把「空表」当成了「没被封锁」**：`Meter` 里那张 `blk: Record<string, number>`（键 `host|node` → 到期时间）从 7.124 起就没有写者了 —— 封锁事实改走 `blk2`
  （`host|relay` → `{ n, at }`）。但字段、`save()` 序列化、`/add` 的合并段、`GET /blk` 全留着，`/<uuid>/debug?do=1` 还在读它：`ringBlk` 永远是 `[]`，看起来像「跨 isolate 没有封锁记录」，
  而真数据在 `blk2` 里。同一批里 `?diag` 的 `relayBlocked`（来自 `vAll()`）是真的，所以这个假仪表不会误导到选路，但会误导排查。
  修法：字段 / 初始化 / `unseal` / `save` / `/add` 合并段 / `/blk` 端点整体删除（`src/store/meter.ts` 540 → 517 行）；`src/routes/debug.ts` 的 `ringBlk` 改读 `https://meter/vt` 的 `blk2`，
  用 `at + BLK_TTL` 算剩余寿命，并多给一个 `n`（批数）。
- **D128 决策里同一张实测表扫了三遍**：`src/route/policy.ts` 的 CF 托管目标分支连着调 `relSnap(c.host)` 三次（`fresh`、`seen`、冷启动闸门的 `length === 0`），
  每次都是「遍历 512 条 + 排序」。而这条分支是热路径（`tools/exp-v8proof.mjs` 的 400 条请求里 379 条走它）。
  修法：`const relRows = relSnap(c.host); const fresh = relRows.length; const seen = new Set(relRows.map((r) => r.ip));`，冷启动闸门复用 `fresh === 0`。
- 锁：第 178 组 8 条（计量表没有 `this.blk`、没有 `/blk` 端点、出站仍走 `factsOut`；诊断读 `/vt` 的 `blk2`、用 `at + BLK_TTL` 算寿命；决策里 `relSnap(c.host)` 只出现一次、冷启动复用 `fresh === 0`；
  再加「量过的那条照旧进表、样本数只累加不重置」）。第 105 组原来那条读 `/meter/blk` 的断言改到 `blk2` 上。
- A/B：`meter.ts` + `debug.ts` 退回 HEAD → 4 红；`policy.ts` 退回 HEAD → 2 红。两条都先 `bundle` + `mk_test` 再跑（否则测的是旧包，见 7.185 的教训）。
### 7.189 自举审计（第 129–130 条，第五张事实表没跟上，残槽与人）

- **D129 吞吐容量表的上限与寿命只落在成功路径上**：`eg`/`ps`/`dead`/`blk2`/`dns` 五张事实表都是「插入之后立刻限界」，只有 `src/route/capfacts.ts` 的 `trim()` 写在
  「确认成功」之后。而 R1 要求两次取样一致且与池内中位数差 2 倍 —— 绝大多数中继只会留下 `at = 0` 的行，`trim` 几乎不会被调用：
  实测 300 个中继各来一条样本 → `rows.size = 300`（`CAP_MAX` 是 256）。更糟的是这些行**永不过期**：`capOf` 里 `if (!row || !row.at) return 1;` 直接早退，连删都不删。
  修法：行上多一个 `seen`（最后一次取样时刻），`note()` 里 `this.rows.set(ip, row)` 之后立刻 `if (this.rows.size > CAP_MAX) this.trim(now);`；
  `trim` 与 `capOf` 都用 `Math.max(row.at, row.seen)` 判寿命（未确认的行按取样时间过期，确认过的行仍按确认时间）。
- **D130 `HOOK.psNote` 是没人注册也没人调用的残槽**：`docs/v8实现清单.md` 第 113 行写着「`connection.ts` 的 `HOOK.psNote` 已删除」—— 调用点确实删了（改成
  `src/route/judge.ts` 的判定出口直接 `PS.note`，避免两套规则分叉），但槽位本身（`src/core/hook.ts` 的类型行 + `HOOK` 的默认值）留着，
  `src/route/psfacts.ts` 的文档还写着「供 `HOOK.psNote` 使用」。既有类型、又有默认值、却既无注册点也无调用点 —— 正是 7.123「`HOOK.facts` 从未注册」的同族。
  修法：类型行与默认值都删，`psNote` 的文档改成指向真正的调用方。
- 锁：第 179 组 15 条（`CAP_MAX === 256`、上限在插入路径上、寿命用 `Math.max(row.at, row.seen)`、不再有 `if (!row || !row.at) return 1;` 的早退；
  行为面 300 条不超上限、未确认的行到期后从表里删掉、真过门的那条仍被记住且 `factor` 在 `tput` 给 0.5 / `lat` 给 1；`hook.ts` 无 `psNote`、`HOOK` 上无该键、`psfacts` 文档指向 `judge.ts`）。
- A/B：`capfacts.ts` 退回 HEAD → **5 红**（其中一条直接打印 `size=300`）；`hook.ts` 退回 HEAD → **2 红**。

### 7.190 自举审计（第 131–133 条，三个写在文档里、代码从没读过的订阅参数）

- **D131 入口数参数没有任何代码在读**：`docs/v8.md` 与实现清单都写着「`?ei=4..16` 控制发几个入口 IP」，但全仓 `searchParams.get("ei")` 零命中 ——
  `src/views/sub.ts` 与 `src/views/sub-links.ts` 各自硬编码 `X_EDGE_IPS.slice(0, 8)`。修法：`src/views/sub-common.ts` 新增
  `edgeCount(url)`（空值/非数字回落到种子表长度，夹在 4 与 8 之间；`Number("")` 是 0 不是 `NaN`，第一版就栽在这里），两处渲染都用它。
- **D132 关中继块的参数同样没人读**：中继条目是「入口 × 协议 × 模式」的笛卡尔积，是客户端列表里最占地方的一块，文档说 `?r=0` 可以关掉，
  实现里却只认 `?e=0`。修法：`const noRelay = url.searchParams.get("r") === "0";` + 中继块条件改成 `!noEdge && !noRelay`。
- **D133 目标实测组的成员根本不是中继条目**：组的注释写着「成员是按中继走的节点条目」、v8 §7 也按 10 条中继算出 97.4%，实现却是
  `q(pick(all, 64))` —— 把入口/域名/地区条目一起塞进去，测出来的是「CF 自己的出口能不能过这个站」，与 `?tu=` 想回答的问题正交；
  而 64 条成员意味着客户端每隔 180 秒对目标站打 64 次。修法：`const tuMembers = relayNames.length ? pick(relayNames, 10) : noRelay ? [] : pick(all, 10);`
  （冷 isolate 里可能一条存活中继都没有，退化到前 10 个条目，否则 `?tu=` 会静默失效），四处判据全部改用它。
- 锁：第 180 组 17 条（`edgeCount` 五个边界；`?ei=4` 只出 8 个入口条目且第 5 个 IP 不出现；`?r=0` 无 `r-` 条目、无中继优选组、入口条目仍在；
  `?tu=` 的成员**全部**以 `r-` 开头且 ≤10；`?r=0` 时实测组不退化；冷 isolate 下仍出组）。第 38 组那条源文本断言跟着改成新写法。
- A/B：三个视图文件退回 HEAD 后 `W.edgeCount` 不存在，第 180 组直接抛错（这本身就是证据）；恢复后 1331 全绿。

- 文档索引：`docs/ARCHITECTURE.md`（分层/类与职责/注释约定）、`docs/评分机制_final.md`（打分与抽样）、`docs/判定模块设计.md`（判定层）、`docs/本地验证.md`（能本地验 vs 必须真 CF）、`docs/LIMITS.md`（平台限制实测）。
- **S3（`ps`）评估结论（2026-11-15）**：`facts=eg,ps` 与 `?fx=eg` 交替配对 40 对 → 30/40 vs 30/40，**差 0（±7.3）**。
  原因是 7.121 之后 CF 托管站点默认直连，`ps` 没有作用面；代码保留、绑定保持 `eg`。结论是「无作用面」而非「测出变差」。
