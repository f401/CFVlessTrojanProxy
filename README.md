# cf-proxyx

VLESS / Trojan over WebSocket，跑在 Cloudflare Workers 上。
直连优先，直连被隔离时自动走 proxyip 中转；带节点评分、轮换与用量计量。

- 单文件产物（TS 源码 → 打包 → 混淆），适合上传到 Workers
- 纯免费额度可跑（KV 5 个键、一个 DO 类）
- 数据面热路径为 CPU 优化（每 512 KB 才做一次统计）

---

## 架构

```
客户端 ──wss──► Worker ──connect()──► 目标站
                   │                    │
                   │                    └─ 失败 → proxyip 中转（CF 托管站点必走）
                   │
                   ├─ 认证：uuid / password（KV 用户表 + env 静态配置）
                   ├─ 选择：Selector（每 isolate 一份 CUR，lat/tput 双游标）
                   ├─ 观测：Connection（吞吐直方图、失败率、空关闭归因）
                   └─ 计量：PEND → Meter DO → KV 快照 → subscription-userinfo
```

### 模块

| 目录 | 文件 | 职责 |
|---|---|---|
| `src/core/` | `util` | 编码 / SHA-224 / WebSocket 工具 |
| | `const` | 纯常量（评分参数、直方图、seed 闸门） |
| | `state` | `AppState`：isolate 级可变状态（`S` 单例） |
| `src/store/` | `index` | barrel：对外只暴露这一层 |
| | `kv` / `crypto` | KV 读写 / AES-GCM 封装 |
| | `snapshot` / `metering` | 用量灾备快照 / PEND + DO 账本 |
| | `meter` | `Meter` Durable Object（全局账本） |
| `src/nodes/` | `score` | 评分纯函数（毫秒当量、可用性、吞吐直方图） |
| | `selector` | 挑谁 / 何时换 / 失败处理 |
| | `metrics` | RTT 学习、错误日志、按站点的节点画像 |
| `src/px/` | `pool` | 中转池状态、`pxGet`、cron |
| | `probe` | TLS 验真探活、候选源抓取 |
| | `seed` | 信誉表按机房分桶读写 |
| `src/proxy/` | `protocol` | VLESS / Trojan 首包解析 |
| | `dial` | DNS、三级拨号、目标校验 |
| | `session` | WS 握手与会话状态机 |
| | `fallback` | 换节点重连 |
| | `tunnel` | 双向管道 + 背压 |
| | `connection` | 一条连接的字节 / 采样 / 背压 |
| `src/views/` | `sub` / `panel` | 订阅渲染（clash/singbox/links）/ 面板页 |
| | `html` / `auth` | 转义与格式化 / 面板会话与限流 |
| `src/core/` | `quota` | 配额与 `subscription-userinfo`（纯计算） |
| `src/edge/` | `respond` / `types` | 响应与安全头（唯一来源）/ 请求上下文 |
| `src/routes/` | `health` `subscription` `admin` `tools` `logs` `cron` | 端点实现 |
| `src/index.ts` | — | 组装根：路由分发 + ws 升级 + cron |

---

## 快速开始

```bash
./scripts/fetch-deps.sh     # typescript + 混淆器（首次）
npm run build               # tsc + 打包 → dist/_worker.js
npm test                    # 470 项断言 + 8 项 golden
npm run obf                 # → _worker_v3.mid.js（可部署）
```

### 部署

```bash
cp config/config.env.example config/config.env   # 填 token / account / zone
cp config/metadata.example.json config/metadata.json
./scripts/deploy.sh
```

**两个必须知道的坑**：

1. `metadata` 里的 `migrations` 只在**首次创建**脚本时需要；后续更新要删掉，否则报
   `10079 Actor migration tag precondition failed`。
2. 上传的 multipart 必须带 `filename=_worker.js`，Cloudflare 用文件名当模块名，
   否则报 `No such module: _worker.js`。

### 重建脚本（遇到 500/522 卡死时）

删除脚本会连同 **DO 类、自定义域名、cron** 一起清掉，必须按序补齐：

```bash
DELETE /accounts/{acct}/workers/scripts/{name}
PUT    ...（metadata 必须带 migrations）
PUT    /accounts/{acct}/workers/domains      # 注意是 PUT，POST 会报 10405
PUT    /accounts/{acct}/workers/scripts/{name}/schedules
GET    /<uuid>/debug?restore=1               # 从 KV 快照续回用量
```

---

## 配置（环境变量 / bindings）

| 名称 | 必填 | 说明 |
|---|---|---|
`uuid` | ✓ | 用户 UUID，逗号分隔可多个 |
`pwd` | | Trojan 密码（裸密码或 `uuid:密码`），secret |
`kek` | | 落盘加密种子（64 位 hex），secret |
`nodes` | ✓ | 订阅入口 `host:port:tls[:name],...` |
`proxyip` | | `auto` 自动池 / `h:p` 手动 / 空=关闭 |
`regions` | | `auto` 或 `JP,US,HK` |
`adminKey` | | 面板登录密码 |
`quotaBytes` / `expireAt` | | 订阅头展示用 |
`STATS` | ✓ | KV namespace |
`METER` | ✓ | Durable Object（类名 `Meter`） |
`pxShadow` | | 影子流量比例（默认 0.1） |
`defaultMode` | | `lat` / `tput`（默认 tput） |
`pxSchedH` | | 定时轮换小时数（0 关闭） |

---

## 测试

```
test/test_v3.mjs     59 项   协议解析 / 订阅输出 / 目标校验
test/smoke_v3.mjs    26 项   端到端路由（假 env）
test/test_score.mjs  34 项   评分 / 选择 / 连接状态机 / 收尾计数
```

测试跑的是**打包产物**（`dist/_worker.js`），不是 TS 源码 —— 保证测的就是要部署的东西。

---

## 安全

- 仓库里**不含任何密钥**：`config/config.env`、`config/metadata.json` 都在 `.gitignore` 里
- KV/DO 里的值统一 `ENC1:` 加密（AES-256-GCM，密钥 = SHA-256(kek)）
- 出站拦截私网/保留地址与 23 个危险端口
- 混淆后产物不含 `vless` / `trojan` / `proxyip` 等关键字（构建时自动校验）

---

## 已知限制

- 每个 isolate 的采样窗口独立，吞吐样本跨机器要等 30 分钟
- 直连流量不经过节点，所以节点吞吐样本天然稀疏
- `kbps` 是服务端视角，客户端瓶颈时偏高 —— 只适合比较节点，不适合当测速
- KV 写受免费额度限制（1000 次/天）：seed ≤26 次/天、snap 走「1h/2h + 全局 45 分钟闸门」、
  usage 快照 2 小时一次，合计约 70 次/天（早先是 600+）
