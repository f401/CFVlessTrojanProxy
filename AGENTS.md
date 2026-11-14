# AGENTS.md

给在这个仓库里干活的 AI/人类协作者的交接说明。目标：**任何一次改动都能被门禁证明、能被回滚、不会把线上搞挂**。

项目：`cf-proxyx`（`package.json` 名，版本号 1.0.0；实际对外版本是 `src/core/util.ts` 的 `VERSION`，当前 **7.85** 已上线）。
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
| `src/store/` | KV 与 DO（`Meter`）读写、快照、待上报账本、密钥链 | `store.ts`、`meter.ts`、`snapshot.ts`、`pend.ts`、`chan.ts` |
| `src/nodes/` | 节点统计与打分、错误环、域名画像 | `stat.ts`、`score.ts`、`metrics.ts` |
| `src/px/` | 候选池、探活、选择器、单层抽样、地区分组、seed 交互 | `pool.ts`、`probe.ts`、`selector.ts`、`ts.ts` |
| `src/proxy/` | WS 入口、协议解析、拨号、连接计量、CF 托管识别 | `session.ts`、`connection.ts`、`dialer.ts`、`dial.ts` |
| `src/views/` | 订阅（clash / sing-box）与面板 HTML | `sub.ts`、`subview.ts`、`panel.ts` |
| `src/edge/` | 鉴权（`X-Admin-Key` / Bearer / sha256 摘要）、响应封装 | `auth.ts`、`respond.ts` |
| `src/route/` | 判定层：verdict / judge / policy / budget / tfb / verify / edge 偏好 | `policy.ts`、`verdict.ts`、`tfb.ts` |
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
- `src/test-surface.ts` 是对外暴露给测试的「窗口」：新增/改名导出时必须同步，否则测试拿到 `undefined`。
- 仿真数字有噪声：同代码重跑 20 节点能在 1.28–1.54 之间跳。**只认 SEEDS=8 的中位数**，并且用 `git stash push -- src/` 做配对基线，不要拿不同时间点的两次跑分对比。

---

## 6. 编码与补丁约定

- **注释**：函数级写「功能 / 参数 / 返回」；体内只写「这步在干嘛 / 为什么」，协议字段偏移、边界条件、临时绕过的原因必须写。不复述代码，HTML 模板（`views/` 里的模板字符串）不写体内注释——里面的 `//` 会发给浏览器。
- **类**：只有**独占跨请求可变状态**的模块才配类（`VerdictTable`、`Pool`、`Scorer`、`Store`、`RelayHealth`…）。纯计算/纯渲染保持自由函数，不要为了「OOP」把 `util.ts` 变成类。
- **批量改代码**：不要按行号定位。用**整行 `trim()` 锚点 + 命中数必须为 1** 的脚本，命中数不对就 `process.exit(1)`；重复锚点用「连续多行」组合。写得好的范本：`.tmp-sim/steps*.mjs`。
- **CRLF**：仓库里 CRLF/LF 混排（`test/test_score.mjs` 尤其严重）。锚点匹配前先 `s.includes("\r\n")` 探测，写回统一 `lines.join("\r\n")`；用 `"\n"` 硬拼锚点会一直 `anchor miss`。
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

- 线上 **7.85**（工作区与线上一致）。7.80–7.85 修的是「中继那一跳到底值不值」：
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
- 选路现状：`SC.POLICY = 2`（判定层全生效）；冷 isolate 由 `src/px/warm.ts` 的 `seedAlive` 起搏（不 await），判定表里**通配封锁不外发也不导入**。
- 正在攻的问题：CF 托管站点（如 x.com）经中继仍会有 ~20–30% 的 4 字节 `IPv6` 403 —— 根因是中继出口地址族，服务端只能「学」（`CF_NEG` 软降权 + 站点级硬封锁）不能改。7.71 起加了「正记忆」（`JUDGE.markPos/posOn`，10 分钟、仅本 isolate）：某条中继刚给该站出过整页就排到队首，突发并发成功率从 ~70% 提到 ~90%（20 并发 × 4 轮 73/80）。注意：**不要在连接内重放 ClientHello 重试**——Worker 只看得见 TLS 密文，首块永远是 ServerHello，识别不了 4xx 页（该实验已回退）。也不要「先缓冲首块、发现是小响应再换中继」：https 里看不到方法，重放会重复投递 POST。7.72 起 `stick` 排序多一层 `HEALTH.rank` 健康度（站点无关），并加了 `smN`/`smD` 归因计数——但**计数器是每 isolate 一份**，跨 isolate 归因只能看 `/<uuid>/stats`（不含 cnt），不要拿单个 `/health` 的数字当全局结论。
- OOP 收类已完成到「有模块级可变状态就有类」：`Pool`、`Scorer`、`Store`、`SeedStore`、`VerdictTable`、`Judge`、`Policy`、`RelayHealth`、`VerifyQueue`、`EdgePrefs`、`SourceHealth`、`PendingLedger`、`HostProfile`、`ErrRing`、`RouteTable`……（清单见 `docs/ARCHITECTURE.md` 的「类与职责」表）。剩下的是纯计算/纯渲染模块，按约定**不**改成类。
- `subtls` 已删除（7.69）：`src/vendor/{subtls.js,subtls.d.ts,roots.js}`、`src/core/tlsprobe.ts`、`src/route/{probe,sweep}.ts` 及其端点（`?tls=`/`?raw=`/`?tlsnow=`/`DO /meter/{probe,raw,dbt}`）全部移除，包体回到 1.4MB 级。
- 文档索引：`docs/ARCHITECTURE.md`（分层/类与职责/注释约定）、`docs/评分机制_final.md`（打分与抽样）、`docs/判定模块设计.md`（判定层）、`docs/本地验证.md`（能本地验 vs 必须真 CF）、`docs/LIMITS.md`（平台限制实测）。
