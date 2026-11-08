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

依赖门禁（`npm run arch`）会拦住：反向依赖、目录级循环依赖、顶层 `let`、单文件 > 560 行。

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
