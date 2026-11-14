# OOP 重构计划（7.00 起）

目标（用户 2026-11-14 goals）：「压缩判定，保证业务逻辑的 403 绝不会被拦截，IP 级封禁 1–3 次请求即可感知，用 OOP 重构整个项目」。

## 1. 已经完成的部分（7.00）

| 模块 | 之前的形态 | 现在 |
| --- | --- | --- |
| `src/route/verdict.ts` | 一堆函数 + 模块级 `const TAB = { m: new Map() }` | `class VerdictTable`（set/setState/ok/bad/dead/all/import/clear/**clearHost**）+ 实例 `VT` + 薄包装函数 |
| `src/route/judge.ts` | 判定逻辑内联在 `policy.ts` 的 `HOOK.traffic` 里（~50 行） | `class Judge`（`onTraffic` / `blocked` / `prefer`）+ 实例 `JUDGE` |
| `src/route/policy.ts` | 自由函数 `decide/shadow` + 12 个 `HOOK.*` 赋值散在文件各处 | `class Policy`（`decide/shadow/relays/prefer/win/install`）+ 实例 `POLICY`；`install()` 一次装配所有 HOOK |

判定链条因此收敛成一条：**观测 → `Judge.onTraffic` → `VerdictTable` → `Policy.decide` → 选择器执行**。
`session.ts` 里不再有任何「判定」分支，只有一行 `pxDecision(...)`。

### 1.1 「压缩判定」的量化

- 判定相关代码：`src/route/*` + `src/proxy/cfverdict.ts` + `src/proxy/pxhook.ts` = **1253 行 / 15 文件**（重构前分散在 `store.ts`、`session.ts`、`selector.ts`、`pool.ts` 里，且互相不知道对方存在）。
- `S` 里与判定相关的字段从 9 组（needPx / cfHost / pxHosts / cfHttp / cfBlock / relayOff / relaySite / viaRelay|viaDirect / edge）收敛到 **8**（`needPx, cfHost, cfHttp, bigByHost, bigChan, smCnt, vtQ, relayOff`），下一轮目标 7（把 `relayOff` 折进 `Policy`）。

## 2. 判定语义（7.00 定稿）

```
大响应 down >= 20KB          → 记「这条通道能出整页」基线
小响应 0 < down < 12KB        → 若 ① 本出口 fetch 根路径 200，或 ② 同站点**另一条**通道
                               6 小时内出过整页 → 判该通道被封（1 次请求即可）
                              否则只排队复核 + 记 needPx（不写判定）
中继小响应 < 6KB 累计 3 次     → 判该中继对此站点不可用（假 200）
某站点全部通道都被判死         → VerdictTable.clearHost() 自愈（宁可再试，不许没路）
```

**「业务 403 绝不会被拦截」的定义**：判定只改变「走哪条通道」，永不断开连接、永不丢弃请求；
最坏情况是换个通道把同样的 403 送到客户端。单元测试第 43/44 组覆盖：
无旁证的业务 403 不判死、站点全封时自愈、1 次请求判定、假 200 攒 3 次。

## 3. 后续阶段（每步独立可验证，门禁全绿才进下一步）

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P1（本轮 R2） | `relayOff` 折进 `Policy`；`Prefs` 改成 `class Prefs` | `S` 判定字段 7；`test_score` 全绿；`?vt`/`?prefs` 输出不变 |
| P2 | `nodes/` 的评分函数改成 `class NodeStats`（`ok/fail/probe/speed/stall/score` 方法），`stat.ts`/`score.ts` 合并成 `NodeStats` + `Scorer` | tsc/arch/tests 全绿；`scoreParts` 结果逐位一致（用 audit-score 对照） |
| P3 | `store/` 收敛成 `class Store`（`kv.ts`/`snapshot.ts`/`pend.ts`/`meter-client.ts` 变成其内部分区对象） | 部署后 `/health`+`/proxyip?day=1` 数字不变 |
| P4 | `px/` 收敛成 `class Pool`（抓取/探活/准入/淘汰）+ `class Selector`（已有） | 仿真 2000 节点 ≤1.16x |
| P5 | `proxy/` 的 `session.ts` 拆成 `class Session`（首包解析/拨号/管道）+ `class Dialer` | session.ts < 300 行；`sim_v3` 全绿 |
| P6 | `views/`（Clash/SingBox/Links）与 `routes/` 各自成类，路由表数据化 | golden 8 项逐字节一致 |

## 4. 纪律

- 每一步都必须过：`tools/tsc.js`、`tools/check-arch.js`（<560 行/文件、单向依赖、无顶层 let）、`test_score`、`test_v3`、`smoke`、`sim`、`golden`。
- 行为等价优先：先改成类、保持逻辑逐位一致，再单独提交「优化」。
- 任何一步让线上 `/health`、`?vt`、订阅字节发生变化，都必须能一键回滚（提交粒度 ≤1 阶段）。
