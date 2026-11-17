# proxyx 架构（v7）

> 一句话：**core ← 各业务域 ← routes ← 组装根**，单向依赖；每个域一个目录；热路径不许跨层回调。

## 1 分层

```
core/     const util net state quota 无业务依赖：常量 / 工具 / 目标校验 /
          counter hist node-snapshot 日计数 / 直方图分位 / 节点快照
store/    index kv crypto         适配器：KV / 加密 / 快照 / 计量 / Meter DO
          snapshot pend stats
          meter-client meter
nodes/    stat(+types/table/view/observe) score site rtt diag metrics errlog  节点域：统计（表 / 派生 / 观测）、评分、站点画像/族键、入口 RTT、诊断结论
px/       pool poolgen poolsrc rawprobe geo failpolicy seed selector pickpath rotation failbook 中转域：候选池、抓取源、探活、选择器
          const regions              共享常量 / 地区列表（打破 pool 互引）
proxy/    protocol dial session     数据面：协议、拨号、会话
          fallback tunnel connection
          ws-in                      客户端→上游字节流（8MB 上行队列上限）
views/    sub* panel* html          纯渲染：sub-common/singbox/links + panel/admin/stats
edge/     respond types auth        响应与安全头、请求上下文、管理会话
routes/   health subscription admin   proxyip debug(+tables/nets/actions) tools(barrel)
          logs cron
index.ts                            组装根：分发 + ws 升级 + cron
```

依赖门禁（`npm run arch`）会拦住：反向依赖、目录级与**文件级**循环依赖、顶层 `let`、单文件 > 560 行、以及**任何 `any`**（`src/` 与 `types/` 一并检查；边界用 `unknown` + 收窄）。
`types/*.d.ts` 里的全局 `declare` 只允许 `WebSocketPair`（Workers 真全局）；其余全局声明会掩盖漏 import，必须用显式 `import`。

依赖图当前是**严格单向**的：`core → store → nodes → px → proxy → views → edge → routes`。`ALLOW` 表为空；`npm run arch` 会对全部层做循环检查，任何反向边都会失败。

## 2 一次请求怎么走

```
fetch(request)
 ├─ Upgrade: websocket ──► proxy/session.handleUpgrade
 │                          ├─ protocol.detect/parse      首包鉴权
 │                          ├─ nodes.selector.pick        选节点（站点偏好 → 单层抽样 → 游标兜底）
 │                          ├─ proxy.dial                 direct / node / v6 / proxyip 三级降级
│                          │  （CF 托管目标先确认有没有非 CF 中继：优选 IP 本身就是 CF 边缘，
│                          │    拿它中转到 CF 站只会更慢，见 isCfHost）
 │                          ├─ proxy.tunnel.pipeBack      双向搬运 + 512KB tick 结算
 │                          └─ store.pendAdd               字节进内存账本
 └─ HTTP
     ├─ /health                     routes/health
     ├─ /admin                      routes/admin
     ├─ /<uuid>/{page,cl,sb,ty,...}  routes/subscription
     ├─ /<uuid>/{proxyip,debug}     routes/tools
     ├─ /<uuid>/logs                routes/logs
     └─ scheduled                   routes/cron（30 分钟一轮；探活默认 ceil(池/4)、上限 min(SCAN_MAX=400, SCAN_SUB=48)；死候选本地记忆后不再占名额）
```

## 3 状态归属

| 归属 | 位置 | 生命周期 |
|---|---|---|
| 节点统计 / 游标 / 站点画像 | `core/state` 的 `S`（按域分段） | isolate |
| 选中结果缓存 | `S.curs` / `S.hostRankCache`（30s） | isolate |
| 候选名单 | `px/seed` ↔ KV `px:seed` | 跨 isolate（只传名字，不传统计） |
| 用量 | `store` PEND → `Meter` DO → KV 快照 | 全局唯一 |
| 加密密钥 | `KEY_BOX`（模块级常量对象） | isolate |

**约定**：任何"写 KV / 打 DO"都必须过时间闸门（`SEED_WRITE_GAP`、`FLUSH_*`、`pendMs`），
不允许按字节触发。当前实测 KV 写 ~60/天、DO 请求 <1k/天。

## 4 构建与门禁

```
tools/tsc.js      tsc（strict:true + noUnusedLocals/Parameters，0 error 才继续）
tools/bundle.js   esbuild → dist/_worker.js（生产）/ dist/_test.js（测试出口）
tools/check-arch.js 分层 / 循环 / 顶层 let / 体积
tools/check-dead.mjs 死导出（导出函数/常量必须在全仓有真实引用）
- tools/check-indent.mjs 缩进（语句不许被顶出所在块；7.237 已补齐 stat.ts 的 305 行与 score.ts 的 176 行，白名单清空、覆盖全仓）
- tools/check-insertorder.mjs 「按插入序」判据（`Object.keys/values/entries(...).slice` 与 `Map.keys().next()` 必须显式按时间排序，或写端先 delete 再 set；允许清单 `tools/insertorder-baseline.json` 逐条写理由，7.177/7.181/7.187/7.215/7.224 五条缺陷都是这个形状）
- tools/check-names.mjs 成员命名（类字段 / 接口成员名 ≤2 字符必须进白名单并写明理由；剩余数量记在 `tools/naming-baseline.json`，只许下降）
tools/doc-audit.mjs 注释 / 类表 / 活文档引用 / 表格列数与反引号 / 文档挂在 import 上 / H6 编号连续 / 版本口径 / JSDoc 类型与签名一致
  · H6 编号必须从 1 连续到最大值（7.231 的第 188 行、7.233 的第 190 行都是漏写，表格语法合法所以没人报）
  · `AGENTS.md` 头部的仓库版本、缺陷数、「差 N 个版本」三者必须与 `src/core/util.ts` 的 `VERSION`、H6 表最大编号对齐
test/*.mjs        473 断言 + 8 项逐字节 golden（含数据面模拟）；`src` 与 `types` 的 any 数量均为 0
obf/*.js          预处理 + 混淆（Meter 类名保留）
scripts/deploy.sh 一条龙：arch → tsc → bundle → test → golden → obf → PUT
```

测试出口在 `src/test-surface.ts`，只存在于 `dist/_test.js`；生产包只导出 `default` 与 `Meter`。

## 5 不变量（改代码前先读）

1. `export class Meter` 名字不能变（DO 命名空间绑定），混淆器 `reservedNames: ["^Meter$"]`。
2. 17 个绑定名不能变；`env.proxyip` 在混淆阶段会被改写成计算属性。
3. 订阅输出必须逐字节稳定（`test/golden.json`）。
4. 热路径只做"加字节 + 比阈值 + 发送"，其余搬到 tick。
5. 账务只在连接收尾结算一次；`nsOk` 必须由成功连接调用（历史上漏掉过，导致节点表永远 n=0）。
6. DO 存储键 `"a"` 是单键格式，老键 `c/e/s/g` 只读兼容，不要回写。
7. `rg=xx` 是**硬要求**：只在该国节点里选，找不到/连不上就断开，禁止回落到直连或全球节点。
8. 落盘前读旧值（seed / snap / usage）必须用 `kvGetStrict`；读失败要跳过写，不能当空表覆盖。
9. cron 与手动 `?refresh=1` 互斥：`S.cronBusy` 覆盖整轮 `cronOnce`，忙时不再排队；
   否则两轮 `cronScan` 会双跑探活、双写 seed、互相覆盖 `poolIdx`。
10. 排行缓存只准用 `invalidateRank()` 作废，不要手写 `S.rankCache.t = 0` ——
    两个模式的时间戳要一起清，漏一个就会出现"失败后排行不失效"。

## 6 目录之外的约定

- 注释写"为什么"，不写"是什么"。
- 所有跨模块符号必须显式 import；禁止再引入 `ORDER` 之类的隐式顺序。
- 新增端点 = `routes/xxx.ts` 导出一个 `(c: RouteCtx) => Response`，在 `index.ts` 分发处加一行。

## 7 评分 v2（读时衰减 + 加权吞吐）

评分是纯计算：`nodes/score.ts` 的 `scoreParts(k, mode)` 同时供排序与面板使用，
`costOf()` 只是取 `.score`。四个维度各有独立语义：

| 维度 | 存什么 | 怎么用 |
|---|---|---|
| traffic | `okW` / `failW`（真实连接） | Beta 后验均值 `pFailRisk`，以及可用性门槛 |
| latency | `tcp`/`tls` EWMA、探活 `pN` | `confL = 1−e^(−(pN+okW)/4)`，向 `alive.ms` 先验收缩 |
| throughput | 加权直方图 `hist`、`sumW`、`sumW2`、`recentBytesW`、`lastSampleAt` | `confB` 由**有效窗口数** `nEff=sumW²/sumW2` 决定，不看连接数 |
| stall | `stallMs`/`runMs` | `pStall=(stall+50)/(run+1000)` |

关键点：

1. **读时衰减**：存储值是"上次写入时刻"的权重，`effView()` 按 `2^(−age/HL)` 折算出当前有效值；
   读分不修改状态，空闲节点会自己变旧。`HL=6h`。
2. **吞吐准入**：`nEff≥3`、`recentBytesW≥3MiB`、样本 ≤24h 三者同时满足才有 `confB`；
   累计 `bytesDown` 只用于展示，不能复活旧样本。
3. **权重**：每个窗口 `w=min(1,bytes/512KiB)×min(1,dt/1s)`，单连接累计封顶 4，
   一条长连接刷不出"高置信度"。
4. **seed 只是候选名单**（v6.35）：KV `px:seed` 只存 `{k,h,p,cc}`，没有任何统计；
   每个 isolate 的最优节点可能不同，跨 isolate 的传统计会把别人的体感当成本机样本。
5. **站点画像**：`hostKey(host)` 是唯一索引，读写都用它；`lat` 用 TTFB，`tput` 必须有站点级
   `bps` 样本，没有就回退全局同模式分，不允许拿 TTFB 冒充吞吐。站点画像**不出本 isolate**。
6. **门槛**：只有 `N≥8` 且 Wilson 下界 <0.4 才硬排除，其余靠 `pFailRisk` 软惩罚，
   避免小样本一两次失败就出局。
7. **风险先验**：`pMean=α/(α+β)`，α=α0+failW、β=β0+okW；溢价 `0.5·√var·(1−e^(−N/4))`
   随样本量才打开 —— **无本地样本时 pFailRisk 恰为 0.1**，不把"未知"当"坏"。
8. **延迟主信号是 ttfb**：`pSum/pSumSq` 存 ttfb 的 EWMA 均值与 **MAD**，
   与探活按 `REAL_W=8 / PROBE_W=2` 份加权；抖动 `MAD×1.4826` 乘 `JIT_W=0.5` 进 lat 分数。
   探活只负责"能不能连上"，不再单独决定延迟。用 MAD 而不是方差：一条 5 秒的怪连接
   只把 `jitMs` 抬到 ~240 ms，而不是秒级。
8b. **变点检测**：`cus`（延迟，ms 当量）与 `cusB`（吞吐，log2 倍数）两条 CUSUM。
   单条怪样本被 `CUSUM_K=30` 挡掉，连续两条 4 倍慢样本（`CUSUM_H=300`）立刻冻结 60 s；
   吞吐掉到 60% 以下才累积，越线就把直方图按 0.2 缩放并改写 `capBps`。
8c. **目标流量 S**：`?sz=i|s|b`（64 KB / 1 MiB / 16 MiB）把 S 带进 `scoreParts`。
   低延迟窄带节点赢在小请求、高延迟宽带节点赢在批量；默认 160 KB（lat）/ 10 MiB（tput）。
9. **探索**：`pxShadow`（默认 5%）只负责冷启动的第一批样本；之后的分流量由单层抽样器
   （`pickThom`）按"均值 + 排队 − 0.8×σ"决定，两者不叠加。`pxShadow=0` 视为关闭。
   **均值里的传输时间不用全局先验**（6.39）：有 `capBps` 测量就按测量算，没有则按候选表里最快的
   `capMax` 算（`TS_HIER`）—— 16 MB 场景里 40 MB/s 的节点命中率因此从 54% 升到 86%；
   失败代价也随 S 缩放（`failMs = clamp(1.6×base, 400, 20000)`），不再固定 5000 ms。
   排队项 = `S.inflight(k) × 本请求的传输时间`，单连接时为 0；候选数记录在 `S.candN`（`/health.candidates`）。
   抽样池宽度按池子分档（6.38）：`S.candN ≥ 1200` 取前 64，否则取前 32（`TS_K_SMALL`）——
   300~800 池里前 64 名含大量明显更差的节点，收窄后 800 池 1.17x→1.13x；
   2000 池前 64 只占 3%，收窄反而丢掉"可能变好"的候选（1.16x→1.20x）。
10. **排行缓存**：`alive≥24` 时 `candsFor` 用 20 秒的候选表，且**只缓存排序、不缓存可用性**——
    黑名单/冻结每次返回前都会重新过滤；`nsFail`/`freezeNode`/候选池换代会把缓存打掉。
    200 候选实测 0.98ms → 0.15ms。
    **每个模式各记一个写入时间**（`at[lat]` / `at[tput]`）：两模式共用一个 `t` 时，
    后算的那个会给另一个"续命"，20 秒的实际有效期能拖到 40 秒（6.34 修）。
    **池子 ≥1200 时分片重建**（`CAND_SLICE=128`）：每次 `pick` 只算 128 个节点、边算边维护前 224 名，
    一轮算完才换表，2000 候选的 4.1ms 重建被摊成 0.26ms/片（6.38）。
    `invalidateRank()` 只重置时间戳，**表和分片进度都留着**（否则失败密集时半张表 + 循环永远算不完）。
11. **站点吞吐中途采样**：长连接每 60 秒补一个站点级 bps 窗口（≥256KB 才记），
    这类采样只带 `bps`，不计入 `n/ok/bad`，避免把一条长连接算成多条连接样本。
12. **失败三态归因**：`node`（连不上节点）/ `site`（连上了但目标侧拒绝，只加 0.2 权重、不进冷却阶梯）/
    `client`（客户端切网、关页面、取消，完全不记失败、不冻结）。
13. **负载感知**：`S.inflight` 记录每个节点的在途连接；当前节点在途 ≥2 且存在分数 ≤1.5× 的空闲候选时溢出。
14. **采样质量**：窗口内背压时间 >50% 的吞吐样本权重 ×0.3（瓶颈在客户端，不代表节点能力）。
15. **快慢双窗口**：除 6 小时半衰期外，另有 10 分钟窗口的 `pFailFast`，评分取 `max(慢, 快)`；
    窗口内 ≥4 次且失败占比 ≥50% 视为抖动，冷却 5 分钟。
16. **站点偏好门槛**：至少 3 个节点有样本，且首选样本 ≤2 小时，才允许覆盖全局游标。

`/<uuid>/debug?diag=<host>` 与 `/proxyip?why=1` 输出的是同一份分项：
`latencyMs / jitMs / e10Ms / pFailRisk / pStall / capBps / confB / nEff / sampleAgeMs / gate`。

连接级观测：`/<uuid>/debug?cl=1`（本 isolate 按节点聚合，最多 400 个节点；p50/p95 取最近 64 条）与 `&do=1`（DO 环形 60 条聚合记录），
每条含 `t / k / ms / dn / up / ok`；落盘走现有的 `/add` 批次（`body.cl`），不新增请求。
目标流量：`?sz=i|s|b` 随连接声明 S，见 docs/评分机制_final.md §2.4。

## 7 代码风格

- 统一由 Prettier 格式化：`printWidth=120`、2 空格、双引号、分号；配置在 `.prettierrc.json`。
- 修改后跑 `npm run format`，再跑 `npm run arch && npm test`。
- 类型边界用 `unknown` + 收窄，仍然禁止 `any`（`npm run arch` 会拦）。
- 目录依赖方向不变：`core ← 业务域 ← routes ← index`；跨层接缝必须登记在 `check-arch.js` 的 `ALLOW` 表。
- 响应头只有 `edge/respond.ts` 一个来源：静态页用 `CSP_STATIC`（无 script-src），管理页用默认
  `SEC_HEADERS`；不要再在路由里手写 `content-type` / CSP。
- 运行参数只有 `core/util.shadowRate` 一个来源：选择器、控制页、`/proxyip` 必须同值，
  未设置时默认 5%，显式 `0` 表示关闭探索。
- 出站目标只走 `checkTarget`：IPv6 必须拆成 8 个 16 位分组后按数值判断，
  不能靠字符串前缀（`0:0:0:0:0:0:0:1`、`::7f00:1` 这类写法能绕过前缀匹配）。
- 落盘前读旧值必须用 `kvGetStrict`：读失败要跳过写，不能把"读不到"当"空表"，
  否则 seed / snap / usage 快照会用空对象覆盖别的 isolate 的数据。

## 8 设计取舍：有状态服务用类，纯计算用函数

- **有状态边界用类**：`AppState`（isolate 状态）、`SeedStore`（信誉表）、
  `Selector`（选路策略）、`Meter`（DO 账本）、`Connection`（单连接生命周期）。
- **纯计算保持函数**：`score/hist/net/quota` 与 `views` 渲染。它们无副作用，便于单测，
  也不会在热路径上引入 `this` 和对象分配。
- **不把每个函数都塞进 class**：Workers 每个请求都可能是新 isolate，状态属于
  `AppState`/DO，而不是模块实例；纯函数直接调用比服务定位器更轻。
- **选择器放 `px/`**：它需要“当前中转出口/存活池”，放在中转域后 `nodes` 不再反向依赖 `px`，
  这是 v7 拆环的关键一步。

## 类与职责（OOP 视图）

状态归类的原则：**有跨请求可变状态的东西才配拥有类**；纯函数（编解码、格式化、URL 拼装）保持自由函数，套一层类只是噪音。

| 类 | 文件 | 独占的可变状态 |
| --- | --- | --- |
| `NodeStatsTable`（`STATS`） | `src/nodes/stat-table.ts` | 只有「按 host:port 取条目」与「打掉排行缓存」两件事 |
| `stat-view`（无类，纯函数） | `src/nodes/stat-view.ts` | 衰減、视图、失败概率、可用性、卡顿概率：只吃 `NodeStats`、不碰 `S` |
| `stat-observe`（无类，纯函数） | `src/nodes/stat-observe.ts` | 成功 / 探活 / 失败 / 站点失败 / 带宽 / 卡顿 / 首字节 / 空关闭八类观测写入 |
| `Scorer`（`SCORER`） | `src/nodes/score.ts` | 排行缓存、黑名单/冻结表、可用性判断 |
| `Store` / `Seal` | `src/store/store.ts`、`crypto.ts` | KV 写入节流、AES 密钥缓存 |
| 快照读写（自由函数 `writeSnap` / `getSnap` / `flushSnap`） | `src/store/snapshot.ts` | 用量快照的合并写与 TTL 缓存（无跨请求状态要独占，所以没有类） |
| `PendingLedger`（`PEND`） | `src/store/pend.ts` | 待上报账本、自适应退避与 flush 定时器 |
| `Pool` | `src/px/pool.ts` | 门面：`nsOf`/`pxSet`/`flushPx` 与 `Pool` 的九个委托方法；存活表与探活冷却在 `alive.ts`，一轮维护在 `scan.ts`，代际提交在 `poolgen.ts` |
| `AliveBoard`（`ALIVE`） | `src/px/alive.ts` | 存活表：冷启动从种子名单铺底（四档回退）、裁「重罚」、超 `ALIVE_MAX` 按先删不在池里的再删最慢的收缩、补国家码；`pxGet()`/`aliveList()` 是它的门面 |
| `ProbeCooldown`（`PROBE_COOL`） | `src/px/alive.ts` | 探活坏点表：`skip()` 判「暂时跳过」、`bump()` 记连续失败、`sweep()` 先删过期再按 `PROBE_BAD_MAX` 淘汰最久没更新的 |
| `PoolScan` | `src/px/scan.ts` | 一轮池子维护的执行器：准入复测 → 探新候选 → 头部复测 → 其余 alive 环切刷新 → 存活表裁剪 → 国家码 → 统计表裁剪 → 中转实测 → 落盘；每段一个方法，`run()` 只写顺序 |
| `SourceHealth`（`SOURCES`） | `src/px/probe.ts` | 池子源健康度（连续失败降权、1 小时冷却、不删源） |
| `SeedStore` | `src/px/seed.ts` | 跨 isolate 的种子表（只存名字） |
| `Selector`（`SEL`） | `src/px/selector.ts` | 门面：十个方法各一行委托给下面三个执行器，不再有算法 |
| `PickPath`（`PICK`） | `src/px/pickpath.ts` | 挑谁：地区硬要求（`?rg=`）、站点偏好 → 单层抽样 → 游标兜底、以及「这条连接当时选的是谁」（`current`） |
| `Rotation`（`ROTATION`） | `src/px/rotation.ts` | 什么时候换：最短驻留时间（`dwellOf`）、切走判据、扫描后的观察窗与定时复查 |
| `FailBook`（`FAILS`） | `src/px/failbook.ts` | 失败怎么记：节点级失败推进快速失败窗口并重算分数，站点级失败只进站点画像；要切走时调 `ROTATION.maybeSwitch` |
| `Dialer` / `RegionPicker` | `src/proxy/dialer.ts`、`region.ts` | 中继串行拨号、地区选择 |
| `SocketDialer` | `src/proxy/socket-dialer.ts` | 按预算建连，超时后关掉「迟到成功」的 socket（四处手写过的同一条规则，现在只有一份实现） |
| `MeterDiagnostics` | `src/store/meter-diagnostics.ts` | 计量 DO 的诊断端点（stage/tim/iter/burn/burnjs/crypto/tfb/tf）：每个端点一个方法，不落盘、不碰账目 |
| `MeterState` | `src/store/meter-state.ts` | 账本本体：五件账本 + 七张事实表 + 代号；`adopt()`/`restore()` 把落盘口径逐项映射到内存字段，`parts()` 反着来，`snapshot()`/`rollback()` 供 `/add` 落盘失败时回滚 |
| `VerdictTable`（`VT`） | `src/route/verdict.ts` | 判定表（站点 × 通道） |
| `Judge`（`JUDGE`） | `src/route/judge.ts` | 流量侧弱证据的累加与落判定 |
| `Policy`（`POLICY`） | `src/route/policy.ts` | 单点决策与策略分级：三张按站点的内存表（`pin`/`rot`/`seq`）+ 排序链 `neg → pos → score → vAt` |
| `PolicyWiring`（`WIRING`） | `src/route/policy-wiring.ts` | 把策略接到 HOOK 的二十个槽位（漏注册不会有门禁报错，7.123 的 `HOOK.facts` 就是这样失效的） |
| `RelayHealth`（`HEALTH`） | `src/route/relay-health.ts` | 中继健康表（sent/pending 语义） |
| `RelayLedger` | `src/route/relay-ledger.ts` | 中继健康表的两张账本（已同步快照 + 待确认行）：`forget()` 是唯一删除入口，`counts()` 暴露规模以发现表外键 |
| `CronLock`（`CRONLOCK`） | `src/core/lock.ts` | cron 闸门：持有时间戳 + `SC.CRON_STALE_MS` 截止；超时接管计 `cronStale`（布尔闩卡死即永久停摆） |
| `TfbBook`（`TFB`） | `src/route/tfbbook.ts` | 起搏记账（上次开批时间 + 本窗口批数；`sweep` 是唯一清理入口，上限与 `SC.PX_MAX` 同源） |
| `TransportRegistry`（`TRANSPORTS`） | `src/core/transport.ts` | 探测传输的注册表：业务侧只说「要一个能探测的传输」，具体实现（userland TLS / 运行时 fetch）由这里决定。7.271 起 `probeTf` 不再写死 tunnelfetch |
| `TunnelFetchTransport` | `src/core/transport-tunnelfetch.ts` | 用 `tunnelfetch`（userland TLS 1.3）探测，能把 TCP 落到中继上 —— 唯一能回答「这条中继到目标行不行」的实现 |
| `GatewayFetchTransport` | `src/core/transport-tunnelfetch.ts` | 用运行时自带 `fetch` 探测，只能直连；留着做「同一目标、两条腿」的对照，与上一条并排看才能分清「目标拒绝这个出口族」与「中继不可用」 |
| `BoundedMap` | `src/core/table.ts` | 有界「键 → 行」表（容量 + 寿命 + 淘汰顺序）；`RelPerfTable` 与 `TfbBook` 继承的淘汰规则就这一份，7.251 前四处各写一遍，于是出现过「上限判在插入之前」那种偏差 |
| `HostProfile`（`HOSTS`） | `src/nodes/site.ts` | 站点画像（站点族 × 节点的成败/字节/ttfb/bps）；`siteKey`/`hostKey`/`hostScore` 与四个薄包装同在此文件 |
| `ErrRing`（`ERRS`） | `src/nodes/errlog.ts` | 错误账本（5 秒去重、10 分钟直方图、限流丢弃计数） |
| 预算分配（自由函数 `planRound`） | `src/route/budget.ts` | 每轮预算分配（准入/复核）：判定额度这一项在 7.149 随 `round.ts` 一起删掉，现在只有 `adm` 与 `cap` |
| `FactsStore`（`FACTS`） | `src/route/factsstore.ts` | 会同步事实表的门面：冷启动合并 → 上行增量 → ack/nack 三段生命周期 |
| `EgFacts`（`EG`） | `src/route/egfacts.ts` | 出口族事实（中继 IP → v4/v6）与 ×40 的族偏置，含 pending/ack |
| `DnsFacts`（`DNS`） | `src/route/dnsfacts.ts` | 「纯 v4 站点」确证（24 小时）与 v6 出口折价 |
| `PsFacts`（`PS`） | `src/route/psfacts.ts` | 站点 × 中继「能不能过」成功率表（45 分钟半衰期） |
| `BlkFacts`（`BLK`） | `src/route/blkfacts.ts` | 单 IP 封锁事实（键为站点 + 出口 IP、三批确认、只乘 6 倍代价、站点级自愈） |
| `DeadFacts` | `src/route/deadfacts.ts` | 中继「连不上」事实（唯一允许把候选挪到队尾的事实） |
| `CapFacts` | `src/route/capfacts.ts` | 吞吐容量表（相对池内中位数的容量比，带噪声门） |
| `FactShadow` | `src/route/factshadow.ts` | 事实写入决策器的影子统计（% 形，不参与决策） |
| `RelPerfTable` | `src/route/relperf.ts` | 站点 × 中继的实测性能表（首字节 / 吞吐，只有 ≥1 MB 的样本才记吞吐） |
| `Prefs`（`PREFS`） | `src/route/prefs.ts` | 判定表折成「能打通 / 打不通」两栏，兼供 `chanPref` |
| `LatObs` | `src/core/latobs.ts` | 首字节 / 总耗时 / 抖动三类窗口统计器 |
| `FirstObs` | `src/core/firstobs.ts` | 前 N 条连接的端到端质量（只累计、不清零，用于冷启动归因） |
| `Attacher` | `src/proxy/attacher.ts` | 上游挂载与补救链：中转再试一条 → IPv6 兜底 → proxyip → 放弃 |
| `DebugMeterProbes` | `src/routes/debug-meter.ts` | 六个「计量 DO 诊断」端点（burn/stage/tim/iter/burnjs/crypto）：规格是数据表，派发只有一条路径（校验 → 取实例 → 带超时 fetch → 包 `{ ok, doStatus, <item> }`） |
| `DebugTables` | `src/routes/debug-tables.ts` | 十一个只读诊断分支（dd/pss/eg/rt/blk/facts/plan/vt/hl/prefs/cl）：只读表、不拨号、不改状态 |
| `DebugNets` | `src/routes/debug-nets.ts` | 会对外拨号的诊断分支（bench/diag/probe/http/tfb/tf/host）：每条都消耗 `connect()` 名额或子请求 |
| `DebugActions` | `src/routes/debug-actions.ts` | 会改状态的诊断操作（refill/cur/restore/seed）：全部先过 `adminOnly`，都会写 KV 或 DO |
| `RouteTable` | `src/routes/table.ts` | 路径 → 处理器的分发表 |
| `SubscriptionView` / `PageView` | `src/views/subview.ts`、`pageview.ts` | 三种订阅格式与面板渲染 |
| `Meter` | `src/store/meter.ts` | DO 里的用量账本 |

自由函数集中在 `src/core/{util,net,hist,quota,hosts}.ts`、`src/proxy/protocol.ts`、`src/views/{html,sub-links,sub-singbox,sub.ts}`：它们要么是纯计算，要么是字符串渲染，没有状态可装。

## 注释约定

- **函数级**：每个函数体上方必须有 `/** 功能 / @param / @returns */`，由 `tools/doc-audit.mjs --max 0` 在 preflight 里强制性把关。
- **体内**：只在「这一步在干什么」「为什么这么写」时才写，不逐行复述代码；分支、边界条件、协议字段偏移、临时绕过的原因属于必须写的。
- **HTML 模板不写体内注释**：模板字面量里的 `//` 会原样发给浏览器。`tools/body-audit.mjs` 自动跳过这类函数（body 只有一条 `return \`…\`;`）。
- 体检：`node tools/body-audit.mjs [--min 12] [--top 30]` 列出「体内零注释的长函数」，靠它维持存量不回流。

## 文档索引

| 文档 | 用途 |
|---|---|
| [docs/v8.md](v8.md) | **v8 设计（当前正稿，439 行）**：事实层 / 判定 / 选路 / 预算 / 迁移 / 证据分级 / 业务 403 安全证明 |
| [docs/v8实现清单.md](v8实现清单.md) | 一页可勾选的硬规则，每条带数字与 § 出处 |
| [docs/评分机制_final.md](评分机制_final.md) | 打分与抽样（线上 7.x 的实际算法） |
| [docs/判定模块设计.md](判定模块设计.md) | 判定层（verdict / judge / policy）的设计与取舍 |
| [docs/吞吐诊断.md](吞吐诊断.md) | 三层链路测量与中继容量实测 |
| [docs/LIMITS.md](LIMITS.md) | 免费计划额度与平台限制实测 |
| [docs/本地验证.md](本地验证.md) | 哪些能本地验、哪些必须真 CF |
| [docs/命名约定.md](命名约定.md) | 命名规则与 ALLOW 短名的理由表（`tools/check-names.mjs` 的判据来源） |
| [docs/审计覆盖.md](审计覆盖.md) | 审计边界：哪些已系统性看过、哪些只能真机验、哪些判定过不必重开 |
| [docs/命名约定.md](命名约定.md) | 命名规则与 ALLOW 短名的理由表（`tools/check-names.mjs` 的判据来源） |