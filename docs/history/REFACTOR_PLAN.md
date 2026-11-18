# proxyx 架构重构计划（v6）

> 历史文档：记录的是当时的方案与实测，**不要照此改代码**；当前设计见 `docs/v8.md` 与 `docs/ARCHITECTURE.md`。

> 目标：把"17 个文件拼在一个作用域里"的脚本式工程，改成有真实模块边界、有类型、有组装根的分层工程。
> 原则：**对外契约零变化，分 7 步上线，每步可回滚。**

---

## 1 现状诊断（带证据）

| # | 问题 | 证据 |
|---|---|---|
| 1 | 没有模块系统，全靠拼接 | `build.js` 用 `ORDER` 数组把 17 个文件塞进同一作用域，`stripExports` 正则删 export；依赖顺序手工维护 |
| 2 | 上帝文件 | `index.ts` 713 行；`fetch` 一个函数 ≈500 行，混了健康检查/管理面板/订阅/统计/日志/debug/HTML 响应头 |
| 3 | 分层错位 | `store.ts`（存储）里装着 proxyip 池 + cron 扫描（§6.2 ≈300 行）；`net.ts`（socket）里装着流量统计；`panel.ts`（视图）里装着 `subHeaders`/`effectiveQuota`/限流 |
| 4 | 上帝状态 | `S` 单例 40+ 字段，混了节点/种子/池/计量/站点画像/DNS 六个域，无 `reset()`，测试互相串 |
| 5 | 巨型函数 | `handleUpgrade` 257 行单函数；`pipeBack`/`dialAnother` 与连接状态机分散三处 |
| 6 | 类型形同虚设 | `strict:false`；`function toHex(u8)` 这类零注解占 90%；`env.X` 21 个键在 12 个文件里裸读，无默认值/校验 |
| 7 | 测试绑内部符号 | `test-exports.txt` 手工列 30+ 符号，改结构就断 |
| 8 | 文档与代码脱节 | `docs/` 6 份，`ARCHITECTURE_v5.md` 已是 v5.4 之前的快照 |

---

## 2 目标结构

```
core/     ← 无业务依赖：类型 / 配置 / 日志 / 字节 / 时间 / 加密
store/    ← 适配器：KV / Meter DO / 快照 / 配额
nodes/    ← 节点域：注册表 / 评分 / 选择 / 种子
px/       ← proxyip 域：候选池 / 探测 / 评分 / cron
proxy/    ← 数据面：协议 / 拨号 / 管道 / 会话 / 降级链
edge/     ← 入口：路由 / 响应 / 鉴权
routes/   ← 9 个端点，一个文件一个
views/    ← 纯函数 (data) => string：面板 / 统计页 / cl / sb / links
app.ts    ← 组装根：export default { fetch, scheduled }
```

依赖方向单向：`core ← store|nodes|px|proxy ← routes ← app`。**任何反向 import 由脚本门禁拦住。**

| 目录 | 文件 | 行数上限 |
|---|---|---|
| `core/` | types, config, log, bytes, time, crypto | 6 × ≤120 |
| `store/` | kv, meter-do, snapshot, quota | 4 × ≤200 |
| `nodes/` | registry, score, selector, seed | 4 × ≤250 |
| `px/` | pool, probe, score, cron | 4 × ≤250 |
| `proxy/` | protocol, dial, tunnel, session, fallback | 5 × ≤250 |
| `edge/` | router, respond, auth | 3 × ≤150 |
| `routes/` | health, admin, sub, stats, debug, px | 6 × ≤150 |
| `views/` | layout, panel, stats, clash, singbox, links | 6 × ≤200 |

预估总行数持平（≈5.7k），**最大文件从 713 → ≈250**。

---

## 3 构建层：换成 esbuild

- `esbuild src/app.ts --bundle --format=esm --target=es2022 --external:cloudflare:sockets --keep-names --outfile=dist/_worker.js`
- 删除 `build.js`、`ORDER`、`stripExports`、`test-exports.txt`
- 混淆链 `obf/pre.js` + `obf/obf_mid.js` **不动**（仍对单文件后处理）
- 测试改为 `import("../dist/_worker.js")`，只认 `app.ts` 里一个 `export const __test = { ... }`（`pre.js` 负责剥掉）
- 收益：依赖图自动、重名立刻报错、死代码 tree-shaking（预估 −8% 体积）
- 风险点：`export class Meter` 必须原样保留 → `keepNames` + 构建后断言 `bundle.includes("class Meter")`

---

## 4 状态：拆域 + 显式 Ctx

`S` → 六个 store，各自 `reset()`：

| store | 字段 |
|---|---|
| `Nodes` | alive / nstat / curs / prev / lastSwitch / switchHits |
| `Pool` | pool / poolIdx / poolGen / scanN |
| `Seed` | seed / gcnt / seedAt / seedDirty |
| `MeterState` | stats / pend / pendAt / meterCache / snapCache / kvw |
| `Profile` | hostNode / hostDirect / hostRankCache |
| `Runtime` | cnt / cntSent / errs / rtt / dnsCache / usersCache |

- isolate 级单例在 `app.ts` 构造一次，装进 `Ctx` 显式传参
- 硬门禁：`src/**` 出现顶层 `^let ` 即构建失败（禁止新的隐式全局）

---

## 5 契约冻结表（重构期间不许动）

| 项 | 约束 |
|---|---|
| 17 个 binding 名 | 不改 |
| `export class Meter` | 名字不改（DO 命名空间绑定） |
| DO 存储键 `"a"` + 旧键 `c/e/s/g` 迁移 | 保留一个版本周期 |
| KV 键 `px:seed` / `stat:*` 格式 | 不改 |
| 路由路径 | `/health` `/admin` `/<uuid>/{cl,pcl,sb,psb,ty,pty,stats,logs,proxyip,debug}` 全保留 |
| 订阅输出 | 逐字节 golden 对比 |
| cron `*/30 * * * *` | 不改 |
| 协议字节处理 | VLESS/Trojan 解析结果保持不变 |

---

## 6 七个阶段

| 阶段 | 内容 | 工期 | 上线判定 |
|---|---|---|---|
| **P0 基线** | 抓 golden（3 个订阅 + stats JSON + health）；记录 5.4 的 24h KV 写/DO 请求/TTFB p50；打 tag `v5.4-baseline` | 0.5d | — |
| **P1 构建层** | esbuild + `__test` + keepNames；删拼接链 | 0.5d | 156 断言 + golden 全绿，**产物行为零变化** |
| **P2 类型与配置** | `core/types.ts`、`config.ts`（21 键集中默认值 + 校验 + 降级日志）；`strict` 逐目录打开 | 1d | tsc 0 error；非法 env 有单测 |
| **P3 拆状态** | 6 个 store + reset；`S.xxx` codemod 到 `ctx.xxx`，保留一版兼容 getter | 1d | 单测可独立 reset，不再串状态 |
| **P4 拆入口** | `edge/` + 9 个 route + 安全头单点；`index.ts` → `app.ts` 40 行 | 1.5d | 所有路由 golden 一致 |
| **P5 数据面** | `session.ts` 状态机 + `fallback.ts` 显式降级链（direct→node→v6→proxyip）+ `tunnel.ts`；账务收敛到 `session.close()` 单点 | 1.5d | 5 并发 × 100MB 压测，吞吐不劣化 >5% |
| **P6 域归位** | proxyip 出 `store`、流量统计出 `net`、`subHeaders` 出 `panel`；删兼容层与死代码 | 1d | 包体积 ≤ 现状 95% |
| **P7 收尾** | docs 合并成 README / ARCHITECTURE / LIMITS 三份（模块图自动生成）；CI 门禁 | 0.5d | 门禁全过 |

合计 **7.5 人日 / 7 次部署**。每阶段独立 tag，回滚 = 30 秒内重推上一版。

---

## 7 每阶段门禁（缺一不许合并）

1. `node tools/tsc.js` → 0 error（P2 后要求 strict）
2. 156 项断言 + golden（订阅三格式逐字节、`/stats` JSON 结构、`/health` 字段集）
3. 部署后 `/health` 版本号正确；三个 isolate 抽样 `/debug?diag=x.com`
4. 24h 观察：KV 写 ≤100/天、DO 请求 ≤1000/天、错误率不升、TTFB p50 劣化 ≤10%
5. 混淆后：关键字残留扫描为空 + `class Meter` 存在

---

## 8 明确不做

- 不引第三方框架（Hono/itty）：60 行路由够用，多一个依赖多一份 bundle 与不确定性
- 不改协议行为（VLESS/Trojan 字节级保持）
- 不动 DO / KV 存储格式（P3 只加版本字段，向后兼容读）
- 不拆多文件部署：混淆是整包后处理，拆模块会破坏符号一致性

---

## 9 风险表

| 风险 | 概率 | 应对 |
|---|---|---|
| esbuild 改变 `class Meter` 形态 | 中 | keepNames + 构建后断言 + preview 命名空间先验证 |
| 拆 `S` 丢 isolate 级状态 | 中 | 兼容 getter 一版 + 每域 reset 单测 + 灰度 |
| 热路径重构引入 CPU 回归 | 低 | P5 只搬代码不改算法；512KB tick 设计原样保留 |
| 订阅输出字节变化 | 低 | golden 逐字节 diff，不通过不合并 |
| 混淆后符号冲突 | 低 | 混淆后跑 smoke + 残留扫描 |
