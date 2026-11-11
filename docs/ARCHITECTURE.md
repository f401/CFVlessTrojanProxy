# proxyx 架构（v7）

> 一句话：**core ← 各业务域 ← routes ← 组装根**，单向依赖；每个域一个目录；热路径不许跨层回调。

## 1 分层

```
core/     const util net state quota 无业务依赖：常量 / 工具 / 目标校验 /
          counter hist node-snapshot 日计数 / 直方图分位 / 节点快照
store/    index kv crypto         适配器：KV / 加密 / 快照 / 计量 / Meter DO
          snapshot metering meter
nodes/    score metrics            节点域：纯评分、画像（不依赖中转域）
px/       pool probe seed selector 中转域：候选池、探活、信誉表、选择器
proxy/    protocol dial session     数据面：协议、拨号、会话
          fallback tunnel connection
          ws-in                      客户端→上游字节流（8MB 上行队列上限）
views/    sub panel html auth       纯渲染：(data) => string（auth 是面板会话）
edge/     respond types             响应与安全头、请求上下文
routes/   health subscription admin tools logs cron
index.ts                            组装根：分发 + ws 升级 + cron
```

依赖门禁（`npm run arch`）会拦住：反向依赖、目录级循环依赖、顶层 `let`、单文件 > 560 行、以及**任何 `any`**（边界用 `unknown` + 收窄）。

依赖图当前是**严格单向**的：`core → store → nodes → px → proxy → views → edge → routes`。`ALLOW` 表为空；`npm run arch` 会对全部层做循环检查，任何反向边都会失败。

## 2 一次请求怎么走

```
fetch(request)
 ├─ Upgrade: websocket ──► proxy/session.handleUpgrade
 │                          ├─ protocol.detect/parse      首包鉴权
 │                          ├─ nodes.selector.pick        选节点（站点偏好 → 全局游标 → 影子）
 │                          ├─ proxy.dial                 direct / node / v6 / proxyip 三级降级
 │                          ├─ proxy.tunnel.pipeBack      双向搬运 + 512KB tick 结算
 │                          └─ store.pendAdd               字节进内存账本
 └─ HTTP
     ├─ /health                     routes/health
     ├─ /admin                      routes/admin
     ├─ /<uuid>/{page,cl,sb,ty,...}  routes/subscription
     ├─ /<uuid>/{proxyip,debug}     routes/tools
     ├─ /<uuid>/logs                routes/logs
     └─ scheduled                   routes/cron（30 分钟一轮）
```

## 3 状态归属

| 归属 | 位置 | 生命周期 |
|---|---|---|
| 节点统计 / 游标 / 站点画像 | `core/state` 的 `S`（按域分段） | isolate |
| 选中结果缓存 | `S.curs` / `S.hostRankCache`（30s） | isolate |
| 信誉表 | `px/seed` ↔ KV `px:seed` | 跨 isolate / 跨机房 |
| 用量 | `store` PEND → `Meter` DO → KV 快照 | 全局唯一 |
| 加密密钥 | `KEY_BOX`（模块级常量对象） | isolate |

**约定**：任何"写 KV / 打 DO"都必须过时间闸门（`SEED_WRITE_GAP`、`FLUSH_*`、`pendMs`），
不允许按字节触发。当前实测 KV 写 ~60/天、DO 请求 <1k/天。

## 4 构建与门禁

```
tools/tsc.js      tsc（strict:true，0 error 才继续）
tools/bundle.js   esbuild → dist/_worker.js（生产）/ dist/_test.js（测试出口）
tools/check-arch.js 分层 / 循环 / 顶层 let / 体积
test/*.mjs        423 断言 + 8 项逐字节 golden
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
4. **seed 只是先验**：`cSeed=0.25×2^(−seedAge/24h)`，只影响 `priorBps`，不进本地 `nEff`、
   也不混进 `okW/failW`；导入的可靠性样本不再伪装成本地观测。
5. **站点画像**：`hostKey(host)` 是唯一索引，读写都用它；`lat` 用 TTFB，`tput` 必须有站点级
   `bps` 样本，没有就回退全局同模式分，不允许拿 TTFB 冒充吞吐。
6. **门槛**：只有 `N≥8` 且 Wilson 下界 <0.4 才硬排除，其余靠 `pFailRisk` 软惩罚，
   避免小样本一两次失败就出局。
7. **风险先验**：`pMean=α/(α+β)`，α=α0+failW、β=β0+okW；溢价 `0.5·√var·(1−e^(−N/4))`
   随样本量才打开 —— **无本地样本时 pFailRisk 恰为 0.1**，不把"未知"当"坏"。
8. **seed 修正先验而非样本**：同 colo、24h 内的 seed 以 `seedW=min(2,0.25×seedN)×2^(−age/24h)`
   个伪计数修正 α0/β0，不增加本地 N、不参与可用性门槛、不影响 confB。
9. **自适应探索**：当前节点 `nEff<3` 时探索上限 10%，样本够了回落到 `pxShadow`（默认 5%）；
   站点冷启动与全局影子共用同一次掷骰，`pxShadow=0` 视为关闭。候选数记录在 `S.candN`（`/health.candidates`）。
10. **排行缓存**：`alive≥24` 时 `candsFor` 结果缓存 20 秒，且**只缓存排序、不缓存可用性**——
    黑名单/冻结每次返回前都会重新过滤；`nsFail`/`freezeNode`/候选池换代会把缓存打掉。
    200 候选实测 0.98ms → 0.15ms。
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
`latencyMs / e10Ms / pFailRisk / pStall / capBps / confB / nEff / sampleAgeMs / priorSource / gate`。

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
