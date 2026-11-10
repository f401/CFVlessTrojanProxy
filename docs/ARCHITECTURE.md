# proxyx 架构（v6）

> 一句话：**core ← 各业务域 ← routes ← 组装根**，单向依赖；每个域一个目录；热路径不许跨层回调。

## 1 分层

```
core/     util const state          无业务依赖
store/    index kv crypto         适配器：KV / 加密 / 快照 / 计量 / Meter DO
          snapshot metering meter
nodes/    score selector metrics    节点域：评分、选择、画像
px/       pool probe seed           中转域：候选池、探活、信誉表
proxy/    protocol dial session     数据面：协议、拨号、会话
          fallback tunnel connection
views/    sub panel html auth       纯渲染：(data) => string（auth 是面板会话）
core/     quota                     配额与订阅头（纯计算）
edge/     respond types             响应与安全头、请求上下文
routes/   health subscription admin tools logs cron
index.ts                            组装根：分发 + ws 升级 + cron
```

依赖门禁（`npm run arch`）会拦住：反向依赖、目录级循环依赖、顶层 `let`、单文件 > 560 行、以及**任何 `any`**（边界用 `unknown` + 收窄）。

唯一的跨层"接缝"在 `npm run arch` 的 `ALLOW` 表里显式列出，共 5 条（数据面回写指标、选择器读中转出口等）。

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
test/*.mjs        156 断言 + 8 项逐字节 golden
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

`/<uuid>/debug?diag=<host>` 与 `/proxyip?why=1` 输出的是同一份分项：
`latencyMs / e10Ms / pFailRisk / pStall / capBps / confB / nEff / sampleAgeMs / priorSource / gate`。
