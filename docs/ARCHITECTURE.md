# proxyx 架构（v7）

> 一句话：**core ← 各业务域 ← routes ← 组装根**，单向依赖；每个域一个目录；热路径不许跨层回调。

## 1 分层

```
core/     const env-parse net state quota 无业务依赖：常量 / 配置解析 / 目标校验 /
          bytes sha224 timeouts     字节编解码 / SHA-224 / 超时预算（util 只做门面）
          ws concurrency errors     WS 发送与释放 / 有限并发 / 错误文本 / 协议名拼装
          counter hist node-snapshot 日计数 / 直方图分位 / 节点快照
store/    index kv crypto         适配器：KV / 加密 / 快照 / 计量 / Meter DO
          snapshot pend stats
          meter-client meter
nodes/    stat(+types/table/view/observe) score(+health/cost/cands) site rtt diag metrics errlog  节点域：统计（表 / 派生 / 观测）、评分、站点画像/族键、入口 RTT、诊断结论
px/       pool poolgen probe seed selector pickpath rotation failbook 中转域：候选池、抓取源、探活、选择器
          const regions              共享常量 / 地区列表（打破 pool 互引）
proxy/    protocol dial session     数据面：协议、拨号、会话
          fallback tunnel connection
          conn-settle conn-sample   连接结束时的结算流水线 / 纯采样换算（权重、卡顿窗口、KB/s）
          ws-in                      客户端→上游字节流（8MB 上行队列上限）
views/    sub* panel* html          纯渲染：sub-common（clash + singbox + links 三格式同住）+ panel/admin/stats
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
目标流量：`?sz=i|s|b` 随连接声明 S，见 docs/history/评分机制_final.md §2.4。

## 7 代码风格

- 统一由 Prettier 格式化：`printWidth=120`、2 空格、双引号、分号；配置在 `.prettierrc.json`。
- 修改后跑 `npm run format`，再跑 `npm run arch && npm test`。
- 类型边界用 `unknown` + 收窄，仍然禁止 `any`（`npm run arch` 会拦）。
- 目录依赖方向不变：`core ← 业务域 ← routes ← index`；跨层接缝必须登记在 `check-arch.js` 的 `ALLOW` 表。
- 响应头只有 `edge/respond.ts` 一个来源：静态页用 `CSP_STATIC`（无 script-src），管理页用默认
  `SEC_HEADERS`；不要再在路由里手写 `content-type` / CSP。
- 运行参数只有 `core/env-parse.shadowRate` 一个来源：选择器、控制页、`/proxyip` 必须同值，
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
| `NodeStatsTable` | `src/nodes/stat.ts` | 全局节点统计表，**纯静态方法**：`nsGet()` / `invalidateRank()` 与九个写入（`nsOk`/`nsProbe`/`nsProbeFail`/`nsFail`/`nsSiteFail`/`nsSpeed`/`nsStall`/`nsLatency`/`nsEmptyClose`）；7.360 起不再有模块级 `STATS` 实例 —— 状态全在 `S.nstat`，实例本身就毫无意义。类型 / 派生纯函数 / 观测三块同在一个文件 |
| `CandidateBoard`（`CANDS`） | `src/nodes/score.ts` | 候选表：排行（20 秒缓存 + 大池分片重建）、过滤、挑下一个、取最优；缓存与分片游标是它自己的字段，作废靠 `S.rankGen` 代际号（这样 `nodes/stat.ts` 不必反向 import 本文件） |
| `ScoreModel` | `src/nodes/score.ts` | 一次评分的过程对象（活一次、不跨请求）：构造时取好条目 / 存活项 / 窗口当量，延迟 / 吞吐 / 风险 / 闸门各成一个方法，`parts()` 合成总分；`scoreParts()` 只是 `new ScoreModel(...).parts()` 的一行包装 |
| `stat-view` | `src/nodes/stat.ts` | 派生视图（`effView`/`pFailOf`/`availOf` 等纯函数，同文件） |
| `stat-observe` | `src/nodes/stat.ts` | 九类观测写入（`nsOk`/`nsFail`/`nsLatency`…，同文件） |
| 密钥封装与解封（自由函数 `seal` / `unseal`） | `src/store/crypto.ts` | KV 里的值统一加密后落盘，派生密钥按 kek 指纹缓存。这里原本还有 `Store`/`STORE` 门面，7.357 已整体删除：16 个方法全是薄委托，`src/` 里一个调用点都没有（生产侧一直直接调 `PEND`、`flushSnap`、`readStats` 这些真实入口），留着只会让人以为上层还要经过它 |
| 快照读写（自由函数 `flushSnap` / `writeSnap` / `getSnap` / `usageSnapWrite`） | `src/store/snapshot.ts` | 用量快照的合并写与 TTL 缓存（无跨请求状态要独占，所以没有类）；`writeSnap` 只做编排，读快照 / 全局闸门 / 建骨架 / 合并用量 / 合并延迟 / 落盘各成一个函数；`usageSnapWrite` 同样只编排：读旧值 / 轮转切批 / 逐用户合并 / 搬旧值 / 落盘各成一个函数 |
| `PendingLedger`（`PEND`） | `src/store/pend.ts` | 待上报账本与 flush 定时器：`flush` 只编排（摘批 → 拼体 → 发 → 确认或退回 → 退避），搭车增量由 `PendCarry` 记账（`owner`/`sync`/`rows`） |
| 池子读写（自由函数 `nsOf` / `pxSet` / `flushPx` / `pxGet` / `aliveList` / `cronScan` / `ensurePool` / `commitPool`） | `src/px/pool.ts` | 候选池的读写口：`pool.ts` 只做再导出与「键 → 统计视图」的换算，存活表与探活冷却在 `alive.ts`、一轮维护在 `scan.ts`、代际提交在 `poolgen.ts`。这里原本还有个 `Pool` 类，9 个静态方法全是「转调同名模块函数」，`src/` 里**零调用点**（生产侧直接调那些函数），7.360 已删 |
| `AliveBoard`（`ScanHouse.board`） | `src/px/alive.ts` | 存活表：冷启动从种子名单铺底（四档回退）、裁「重罚」、超 `ALIVE_MAX` 按先删不在池里的再删最慢的收缩、补国家码；无字段（状态全在 `S.alive`），7.350 起由收尾执行器 `ScanHouse` 自己持有、不再有模块级 `ALIVE`，`pxGet()`/`aliveList()` 里按需现造一个 |
| `ProbeCooldown` | `src/px/alive.ts` | 探活坏点表，纯静态方法：`skip()` 判「暂时跳过」、`bump()` 记连续失败、`sweep()` 先删过期再按 `PROBE_BAD_MAX` 淘汰最久没更新的（7.360 起无模块级 `PROBE_COOL` 实例，表本体在 `S.probeCool`） |
| `PoolScan` | `src/px/scan.ts` | 一轮池子维护的**编排**：取池子 → 准入复测 → 探新候选 → 头部复测 → 其余存活项环切刷新 → 裁剪与统计 → 中转实测 → 落盘；顺序只在这一处，三个执行器（`ScanProbe`/`ScanAlive`/`ScanHouse`）与批探活（`probeBatch`）都住在同一个文件里 |
| `ScanProbe` | `src/px/scan.ts` | 新候选扫描：在「还没有结论」的候选里轮转（全都有结论时退回复检没进池的）、按 `PROBE_CONC` 切成段、成功进存活表并记节点统计、同 /24 慢 3 倍以上的排进下一轮复测 |
| `ScanAlive` | `src/px/scan.ts` | 存活节点复测：准入复测队列（每次 4 条）→ 头部（游标 + 吞吐前 3）→ 其余环切 12 条；只有头部与环切失败记探活失败，复测只做「把延迟拉回来」 |
| `ScanHouse` | `src/px/scan.ts` | 一轮的收尾（存活表读写器由它自己持有，7.350 起不再有模块级 `ALIVE`）：裁存活表（重罚先出、再按 `ALIVE_MAX`）、补国家码、清节点统计表（6 小时无动静 + 75% 硬上限）、中转实测（每轮最多 2 站点 × 4 节点）、seed 落盘（≥55 分钟） |
| `SourceHealth`（`SOURCES`） | `src/px/probe.ts` | 池子源健康度（连续失败降权、1 小时冷却、不删源） |
| `RawProbe` | `src/px/probe.ts` | 一次原始探测的会话（建连 → 写报文 → 按预算收首段字节）：`open` 负责 sslip.io 回退、`tcpMs`/`elapsedMs` 只在建连时刻上算、`peek` 收够/到点/提前判据三选一退出、`close` 保证迟到连上的 socket 也被关（免费计划全局只有 6 个并发 `connect()`）；两个探测只保留「首段字节怎么判」 |
| `SeedStore` | `src/px/seed.ts` | 跨 isolate 的种子表（只存名字 `{k,h,p,cc}`），纯静态方法（7.360 起无模块级 `SEEDS` 实例，读失败计 `seedReadFail` 的那条路径仍在） |
| `Selector`（`SEL`） | `src/px/selector.ts` | 门面：十个方法各一行委托给三个执行器，本身不再有算法；失败记账器与换节点器都由它自己持有（7.347 起不再有模块级 `FAILS`，7.356 起不再有模块级 `ROTATION`，同一个 `rotation` 实例也交给记账器） |
| `PickPath`（`PICK`） | `src/px/pickpath.ts` | 编排：地区硬要求（`?rg=`）与 `current` 的偏好顺序；同文件里还有下面两个类，7.345 起它们由门面自己持有（`PICK.site` / `PICK.paths`），模块级不再有 `SITE` / `PATHS` 两个单例 —— 画像与偏好都只在编排的调用栈里存活，拆成三个文件会让「这次为什么换了节点」分散在三处 import |
| `SitePick`（`PICK.site`） | `src/px/pickpath.ts` | 站点画像这一层：`pick` 只做编排，五段各一方法 —— `syncCursor`（游标自愈）、`byProfile`（≥3 条样本、首选不超过 2 小时才覆盖全局）、`byShadow`（冷启动影子）、`bySample`（单层抽样 + 负载溢出）、`leastBad`（全池被罚时的兜底） |
| `ThompsonPicker` | `src/px/ts.ts` | 单层 Thompson 抽样：构造时一次算清「池子大小 → 抽样宽度 → 乐观面 β → 目标流量 → 探活剪枝线 → 池内最快带宽」，`arms()` 逐候选算 σ 与乐观代价，`pickOf()` 按 `TS_BAND` 剪枝后取代价最小；样本不足的臂豁免剪枝（否则「没测过 → 先验慢 → 被剪掉 → 永远没测过」锁死） |
| `PathPrefs`（`PICK.paths`） | `src/px/pickpath.ts` | 偏好过滤：判定层否决、入口族偏好（非 CF 出口优先，1.5x+50ms 带内）、站点通道偏好、拨号重试的「排除已试过」重扫；只读不写（7.345 起不再是模块级单例，由 `PICK` 持有；`PREFS` 那个名字仍归入口偏好） |
| `Rotation`（`SEL.rotation`） | `src/px/rotation.ts` | 什么时候换：最短驻留时间（`dwellOf`）、切走判据、扫描后的观察窗与定时复查；无字段（状态在 `S.curs`/`S.lastSwitch`），7.356 起由 `Selector` 持有并注入给 `FailBook`，模块级 `ROTATION` 已撤 |
| `FailBook`（`SEL.fails`） | `src/px/failbook.ts` | 失败怎么记：节点级失败推进快速失败窗口并重算分数，站点级失败只进站点画像；要切走时调构造注入的 `rotation.maybeSwitch`（7.356 起换节点器由门面持有并传进来，不再引模块级单例） |
| `Dialer` / `RegionPicker` | `src/proxy/dialer.ts`、`region.ts` | `Dialer.open()` 只分派三段：`classify`（CF 托管识别 + 一次 200ms 的事实预热，决定要不要绕中继）、`viaRelay`（循环骨架：`nextCand` 取候选并判四类跳过 —— 解析为空 / 内网地址 / 已试过 / 边缘中继，`attemptRelay` 只拨一次并记账冷却；名额按真实拨号次数算）、`direct`（CF 托管目标先按 A 记录拨 IPv4）；两条直连都走 `guarded` 的有限等待 |
| `SocketDialer` | `src/proxy/socket-dialer.ts` | 按预算建连，超时后关掉「迟到成功」的 socket（四处手写过的同一条规则，现在只有一份实现） |
| `MeterDiagnostics`（`MeterEndpoints.diagnostics`） | `src/store/meter-diagnostics.ts` | 计量 DO 的诊断端点（stage/tim/iter/burn/burnjs/crypto/tfb/tf）：每个端点一个方法，不落盘、不碰账目；无状态，7.352 起由端点对象自己持有，模块级 `METER_DIAGNOSTICS` 已撤 |
| `MeterState` | `src/store/meter-state.ts` | 账本本体：五件账本 + 七张事实表 + 代号；`adopt()`/`restore()` 把落盘口径逐项映射到内存字段，`parts()` 反着来，`snapshot()`/`rollback()` 供 `/add` 落盘失败时回滚 |
| `MeterAdd` | `src/store/meteradd.ts` | `/add` 的合并器：日计数、错误环、连接观测、判定表、六张事实表、中继存活度、节点快照、用量各一个私有方法，`apply()` 只负责顺序；`FactMerger` 是它的私有成员，不再需要模块级单例 |
| `MeterEndpoints` | `src/store/meter.ts` | 计量 DO 的端点实现：`/add`、`/seed`、`/set` 三个会改账本的（各自处理回滚）与 `/cl`/`/hl`/`/vt`/`/cnt` 四个只读的；诊断端点由它自己持有的 `diagnostics` 分派；`Meter` 只留串行化、落盘与生命周期 |
| `VerdictTable`（`VT`） | `src/route/verdict.ts` | 判定表（站点 × 通道）：状态机、TTL/上限、弱证据不得冲掉强证据、通配目标拒写；公开类型与 `VT_TTL_MS` 同住这一个文件，调用方直接用 `VT.set(...)`/`VT.bad(...)`（7.300 删掉了十二个同名转发函数） |
| `Judge`（`JUDGE`） | `src/route/judge.ts` | 判定出口：`onTraffic` 只做编排（事实 → 整页 → 小响应 → 封锁），四段各一方法；正/负记忆与封锁结论都在同一处 |
| `Policy`（`POLICY`） | `src/route/policy.ts` | 单点决策与策略分级：三张按站点的内存表（`pin`/`rot`/`seq`）+ 排序链 `neg → pos → score → vAt`；CF 托管目标的分支树按代价四段各自成函数（`cfV6Choice` → `cfColdChoice` → `cfEgressChoice` → `cfEgChoice`），`decideCf` 只编排；7.351 起自己持有装配器 `wiring` |
| `PolicyWiring`（`Policy.wiring`） | `src/route/policy-wiring.ts` | 把策略接到 HOOK 的二十个槽位（漏注册不会有门禁报错，7.123 的 `HOOK.facts` 就是这样失效的）；无状态，7.351 起由 `Policy` 自己持有，模块级 `WIRING` 已撤 |
| `RelayHealth`（`HEALTH`） | `src/route/relay-health.ts` | 中继健康表（sent/pending 语义） |
| `RelayLedger` | `src/route/relay-ledger.ts` | 中继健康表的两张账本（已同步快照 + 待确认行）：`forget()` 是唯一删除入口，`counts()` 暴露规模以发现表外键 |
| `CronLock` | `src/core/lock.ts` | cron 闸门，纯静态方法：持有时间戳 + `SC.CRON_STALE_MS` 截止；超时接管计 `cronStale`（布尔闩卡死即永久停摆）。7.360 起无模块级 `CRONLOCK` 实例 |
| `TfbBook`（`TFB`） | `src/route/tfbbook.ts` | 起搏记账（上次开批时间 + 本窗口批数；`sweep` 是唯一清理入口，上限与 `SC.PX_MAX` 同源） |
| `TransportRegistry`（`TRANSPORTS`） | `src/core/transport.ts` | 探测传输的注册表：业务侧只说「要一个能探测的传输」，具体实现（userland TLS / 运行时 fetch）由这里决定。7.271 起 `probeTf` 不再写死 tunnelfetch |
| `TunnelFetchTransport` | `src/core/transport.ts` | 用 `tunnelfetch`（userland TLS 1.3）探测，能把 TCP 落到中继上 —— 唯一能回答「这条中继到目标行不行」的实现 |
| `GatewayFetchTransport` | `src/core/transport.ts` | 用运行时自带 `fetch` 探测，只能直连；留着做「同一目标、两条腿」的对照，与上一条并排看才能分清「目标拒绝这个出口族」与「中继不可用」 |
| `BoundedMap` | `src/core/table.ts` | 有界「键 → 行」表（容量 + 寿命 + 淘汰顺序）；`RelPerfTable` 与 `TfbBook` 继承的淘汰规则就这一份，7.251 前四处各写一遍，于是出现过「上限判在插入之前」那种偏差 |
| `TimedMarks` | `src/core/table.ts` | 「键 → 标记时刻」的有界表：`mark()` 写一条标记，`on()` 判断还在不在寿命内；`set` 之后才裁（7.227 的单测抓到过 `alive=513`），过期的在 `on()` 里顺手删。7.359 起 `Judge` 的两张表用它，淘汰规则不再各写一遍 |
| `HostProfile`（`HOSTS`） | `src/nodes/metrics.ts` | 站点画像（站点族 × 节点的成败/字节/ttfb/bps）；`markNode()` 只按「取行 `entryOf()` → 过期减半 `decay()` → 计数 `count()` → 采样 `measure()` → 打时间」编排，两张表的上限各自一个方法（`evictHost()` 按族内最近更新淘汰、`evictNode()` 按行内时间淘汰）；`siteKey`/`hostKey`/`hostScore` 与同名薄包装同在此文件 |
| `ErrRing`（`ERRS`） | `src/nodes/errlog.ts` | 错误账本（5 秒去重、10 分钟直方图、限流丢弃计数） |
| 预算分配（自由函数 `planRound`） | `src/route/budget.ts` | 每轮预算分配（准入/复核）：判定额度这一项在 7.149 随 `round.ts` 一起删掉，现在只有 `adm` 与 `cap` |
| `FactMerger` | `src/store/factmerge.ts` | 把 DO 车身里的五类事实并进本地表：每张表一个私有方法（族号、历史最好、判死行、`|` 键、容量淘汰各不相同），`merge()` 只负责分派 |
| `FactsStore` | `src/route/factsstore.ts` | 事实表同步，纯静态方法：冷启动合并 → 上行增量 → ack/nack 三段生命周期；内部逐类点名五张表（7.360 起无模块级 `FACTS` 实例） |
| `EgFacts`（`EG`） | `src/route/egfacts.ts` | 出口族事实（中继 IP → v4/v6）与 ×40 的族偏置，含 pending/ack |
| `DnsFacts`（`DNS`） | `src/route/dnsfacts.ts` | 「纯 v4 站点」确证（24 小时）与 v6 出口折价 |
| PsFacts（PS） | src/route/psfacts.ts | 站点 × 中继「能不能过」成功率表（45 分钟半衰期）：形状、先验与表本体同在此文件，待上报队列与有界化继承自 FactTable |
| `BlkFacts`（`BLK`） | `src/route/blkfacts.ts` | 单 IP 封锁事实（键为站点 + 出口 IP、三批确认、只乘 6 倍代价、站点级自愈）；表本体 / 待上报队列 / 有界化继承自 `FactTable` |
| `FactTable`（抽象基类） | `src/route/fact-table.ts` | 六张事实表的公共生命周期：`ack()` 只清这一批真的发出去的行、`nack()` 什么都不清、有界化只在插入路径上；子类只声明寿命 / 上限 / 批次与线格式编解码 |
| `DeadFacts` | `src/route/deadfacts.ts` | 中继「连不上」事实（唯一允许把候选挪到队尾的事实） |
| `CapFacts` | `src/route/capfacts.ts` | 吞吐容量表（相对池内中位数的容量比，带噪声门） |
| `FactShadow` | `src/route/factshadow.ts` | 事实写入决策器的影子统计（% 形，不参与决策） |
| `RelPerfTable` | `src/route/relperf.ts` | 站点 × 中继的实测性能表（首字节 / 吞吐，只有 ≥1 MB 的样本才记吞吐） |
| `Prefs` | `src/route/prefs.ts` | 判定表折成「能打通 / 打不通」两栏，纯静态方法 `of` / `chan` / `json`；7.349 起不再有 `prefsOf`/`chanPref`/`prefsJson` 三个转发函数，7.360 起也不再需要 `PREFS` 实例（`HOOK.chanPref` 槽位注册到 `Prefs.chan`） |
| `LatObs` | `src/core/obs.ts` | 首字节 / 总耗时 / 抖动三类窗口统计器 |
| `FirstObs` | `src/core/obs.ts` | 前 N 条连接的端到端质量（只累计、不清零，用于冷启动归因） |
| `Attacher`（`ProxySession.attacher`） | `src/proxy/attacher.ts` | 上游挂载与补救链：`run()` 只装配，收尾交给 `onClose()`；中转再试一条 / IPv6 兜底 / proxyip 三段各一方法；无字段，7.354 起由 `ProxySession` 自己持有，模块级 `ATTACHER` 已撤 |
| `ConnSettle`（`Connection.settle`） | `src/proxy/conn-settle.ts` | 一条连接结束时的结算流水线：收尾采样 → pStall 占比 → 节点观测聚合 → 首眼观测（含站点画像与通道证据）→ PEND 记账；只读 `SettleView`，状态仍归 `Connection`；7.348 起由连接自己持有，模块级 `SETTLE` 已撤 |
| `SampleWindow` | `src/proxy/connection.ts` | 一条连接的两个采样窗口边界（节点级 800ms 窗口 / 5 秒出样本间隔 / 站点级 60 秒）：窗口太短或间隔未到都不推进起点，小样本只推进起点不交样本 |
| `ClientFlow` | `src/proxy/connection.ts` | 客户端这一侧的流量控制：唯一读 `ws.bufferedAmount` 的地方，也是唯一区分「客户端自己走了」（记 `ccut`）与「真卡死」（记 `stall`）的地方 |
| `DebugSuite`（`DEBUG`） | `src/routes/debug.ts` | 调试路由四个组件的持有者（读表 / 测网 / 写操作 / 计量探测）：收成一个对象后，「这次调试动用了哪些能力」在同一处读完，也是判断「某个参数会不会真的拨号」的入口 |
| `DebugMeterProbes` | `src/routes/debug.ts` | 六个「计量 DO 诊断」端点（burn/stage/tim/iter/burnjs/crypto）：规格是数据表，派发只有一条路径（校验 → 取实例 → 带超时 fetch → 包 `{ ok, doStatus, <item> }`） |
| `DebugTables` | `src/routes/debug.ts` | 十一个只读诊断分支（dd/pss/eg/rt/blk/facts/plan/vt/hl/prefs/cl）：`read()` 只按固定顺序编排，每个分支一个方法、只认自己那个参数键（`?blk=` 等自己取参数、自己拼载荷）；只读表、不拨号、不改状态，`&do=1` 时只有 `healthRows()` 与 `connRows()` 会多一次 DO 往返 |
| `ProxyipView` | `src/routes/proxyip.ts` | `/proxyip` 的六个方法：只读报表（`?day`、`?src`）、两个管理员动作（`?reset` 清表、`?refresh` 跑一轮探活）、默认视图分三段——`liveRows()` 并内存表与跨 isolate 快照并按模式排序、`explain()` 只在 `?why=1` 时算画像与分项、`poolReport()` 只拼字段 |
| `AdminView`（`admin` 门面） | `src/routes/admin.ts` | `/admin` 的四个分支各占一个方法：登出只清 cookie、登录做挑战-应答与限速、用户操作要读改写整份托管用户表（`cur.ok === false` 时必须拒绝，否则会把缺失用户整份删掉）、面板按用户数扇出 DO 往返并被 `ADMIN_STATS_MAX` 截断 |
| `RateLimiter`（`RATE_LIMIT`） | `src/edge/auth.ts` | 登录尝试的固定窗口限流：`take` 判「这个来源这一分钟还能不能试」、`reset` 在成功登录后清零、`size` 供诊断；表按 `RL_MAX` 有界（超限只淘汰「计数最小且最旧」的一条，绝不整体清空、绝不淘汰刚写入的来源），7.355 起由类持有而不是裸 `Map` |
| `SubscriptionRoutes`（`subscription` 门面） | `src/routes/subscription.ts` | 控制页与订阅：`page()` 读用量 + 存活表两次往返、`feed(kind)` 把 clash / sing-box / 明文链接三种格式收成一条路（差别只有渲染器与 content-type，见 `FEEDS` 表）、`stats()` 的 JSON 分支零额外往返、`statsHtml()` 才并跨 isolate 快照；页面视图 `PageView` 由它自己持有（7.353 起，不再有模块级 `PAGES`） |
| `ProxySession` | `src/proxy/session.ts` | WebSocket 数据面的会话对象：握手 / 首帧解析 / 拨号（地区与补救两条路）/ 收尾各一个方法；`?rg=` 用的 `RegionPicker` 由它自己持有（7.346 起，不再有模块级 `REGION`） |
| `UploadStream` | `src/proxy/ws-in.ts` | 客户端 → 上游的上行字节流：积压计数、超限关连接（1013）、正常关闭与异常各自收尾；`wsToStream()` 只是 `new UploadStream(ws, early).stream` |
| `UserIndex` | `src/proxy/protocol.ts` | 用户表装配器：env（`uuid`/`uuids`、`trojan` 单密码与 `user:pass` 多密码）与 KV 托管用户合成一张表，维护「启用 id 集合」与「密码摘要 → 稳定 owner」；托管记录最后写，因此能覆盖 env 的启用状态 |
| `DebugNets` | `src/routes/debug-nets.ts` | 会对外拨号的诊断分支门面：七个分支在四个组件里，这里只按「只读 → 测速 → 诊断 → 探活 → 抓源 → 钉住 → 明文 HTTP → 判定批 → 真握手 → 回填 → seed → 兜底」然后按顺序派发（顺序变了，`?diag=x&refill=1` 会先花一次抓源）。7.344 起四个组件（`benchRunner`/`diagRunner`/`probeRunner`/`tfRunner`）由它自己持有，不再是模块级单例 |
| `DebugBench` | `src/routes/debug-nets.ts` | 出口测速（花 fetch 子请求，同文件） |
| `DebugDiag`（`DIAGONE`） | `src/routes/debug-nets.ts` | 站点诊断：`diag()` 只编排，六段细节各一方法（取样本 / 主动探活 / 证据选择 / CF 事实 / 本 isolate 判定 / DO 封锁环） |
| `DebugProbe` | `src/routes/debug-nets.ts` | 三个探针：原始 ClientHello / 明文 HTTP / IPv6 可达性（同文件） |
| `DebugTf` | `src/routes/debug-nets.ts` | 判定批与真握手（子请求 + DO CPU，同文件） |
| `DebugActions` | `src/routes/debug.ts` | 会改状态的诊断操作（refill/cur/restore/seed）：全部先过 `adminOnly`，都会写 KV 或 DO |
| `RouteTable` | `src/routes/table.ts` | 路径 → 处理器的分发表，纯静态方法（7.360 起无模块级 `ROUTES` 实例） |
| `SubscriptionView` / `PageView` / `PanelView` | `src/views/sub.ts`、`src/views/panel.ts` | 三种订阅格式与面板渲染（`PanelView` 六个分区各一方法、样式抽成 `PANEL_CSS`；`PageView` 无字段，7.353 起由 `SubscriptionRoutes` 自己持有实例，模块级 `PAGES` 已撤；`SubscriptionView` 同样无字段，7.358 起由 `SubscriptionRoutes` 自己持有（`this.view`），模块级 `SUBVIEW` 已撤） |
| `Meter` | `src/store/meter.ts` | DO 里的用量账本 |

自由函数集中在 `src/core/{util,net,hist,quota,hosts,hostmem,http80,table,enums,types,facts,hook,state,const,counter,lock,latobs,firstobs,node-snapshot,transport}.ts`（编解码 / SHA-224 / WS / 超时 / 并发 / 环境解析 / 协议名 / 错误文本都在 `util.ts` 一个文件里，7.290 起不再拆分；SHA-224 内部按「补位 `sha224Pad()` / 展开 `sha224Words()` / 压缩 `sha224Mix()`」三步各自成函数，7.338 起）、`src/proxy/protocol.ts`、`src/views/{html,sub-common,sub}.ts`（三种订阅格式与它们的共享 helper 现在都在 sub-common 里）：它们要么是纯计算，要么是字符串渲染，没有状态可装。

## 注释约定

- **函数级**：每个函数体上方必须有 `/** 功能 / @param / @returns */`，由 `tools/doc-audit.mjs --max 0` 在 preflight 里强制性把关。
- **体内**：只在「这一步在干什么」「为什么这么写」时才写，不逐行复述代码；分支、边界条件、协议字段偏移、临时绕过的原因属于必须写的。
- **HTML 模板不写体内注释**：模板字面量里的 `//` 会原样发给浏览器。`tools/body-audit.mjs` 自动跳过这类函数（body 只有一条 `return \`…\`;`）。
- 体检：`node tools/body-audit.mjs [--min 12] [--top 30]` 列出「体内零注释的长函数」，靠它维持存量不回流。

## 文档索引

`docs/README.md` 是索引与阅读顺序；下表只列**当前有效**的七份（历史设计稿与逐版测量
记录统一归档在 `docs/history/`，不进本表，免得读者照着早已落地的方案改代码）。

| 文档 | 用途 |
|---|---|
| [docs/v8.md](v8.md) | 设计正稿：事实层 / 判定 / 选路 / 预算 / 迁移 / 证据分级 / 业务 403 安全证明 |
| [docs/v8实现清单.md](v8实现清单.md) | 一页可勾选的硬规则，每条带数字与 § 出处；H6 表是缺陷台账（编号连续，门禁校验） |
| [docs/LIMITS.md](LIMITS.md) | 免费计划额度与平台限制实测 |
| [docs/命名约定.md](命名约定.md) | 命名规则、ALLOW 短名的理由表、模块级实例准入（`tools/check-names.mjs` 的判据来源） |
| [docs/本地验证.md](本地验证.md) | 哪些能本地验、哪些必须真 CF，以及量测纪律 |
| [docs/审计覆盖.md](审计覆盖.md) | 审计边界：哪些已系统性看过、哪些只能真机验、哪些判定过不必重开 |
| [docs/history/](history/) | 历史归档：v6/v7 重构计划、评分算法演进、判定层验收记录、吞吐诊断、节点选择仿真日志 |

## 文档管理约定

- `docs/` 顶层只放**描述当前系统**的文档；一旦某份文档描述的是「当时打算怎么做」，就
  `git mv` 进 `docs/history/`，并在文件开头标一行「历史文档，勿照此改代码」。
- 活文档（`ARCHITECTURE.md`、`v8.md`、`LIMITS.md`）里提到的路径、`SC.常量`、裸函数名和
  类名必须真实存在 —— `tools/doc-audit.mjs` 的 `livingRefs` 会逐个核对，归档文档不参与。
- 同一件事只在一处写：硬规则进 `v8实现清单.md`，机制与取舍进 `v8.md`，类与归属进本文件，
  历史证据进 `docs/history/`。