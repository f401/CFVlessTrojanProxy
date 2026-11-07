# 评分机制（最终版）

> 一句话：**分数 = 这个节点平均让用户多等多少毫秒。**
> 两种模式共用一套观测，只有最后一步加权不同。

---

## 1. 观测：每个 (colo, node) 存 7 个数

```js
S = {
  tcp,        // TCP 建连 EWMA(α=0.3)      先验 250 ms
  tls,        // TLS 往返 EWMA(α=0.3)      先验 60 ms
  okW, failW, // 成功/失败权重（衰减）
  stallMs,    // 背压累计毫秒（衰减）
  runMs,      // 连接总毫秒（衰减）
  bytesDown,  // 累计下行字节（不衰减，只做"是否够格"闸门）
  at, failStreak, blackUntil
}
```

### 1.1 衰减（唯一入口）

```js
const HL = 6 * 3600e3;
function decay(s, now) {
  const k = Math.pow(0.5, (now - (s.at || now)) / HL);
  s.okW *= k; s.failW *= k; s.stallMs *= k; s.runMs *= k;
  s.at = now;
}
```
更新前、读分前都调一次。**不存在终身计数。**

### 1.2 概率（Beta 先验）

```js
pFail  = (failW + 1)   / (okW + failW + 10);   // 无数据 0.10
pStall = (stallMs + 50) / (runMs + 1000);      // 无数据 0.05
```

---

## 2. 两个代价函数

### 2.1 速率优先 `lat`

```js
v_lat = tcp
      + tls * 1.2
      + max(0, tls - 2*tcp - 30) * 2      // 额外往返 = 重传
      + pFail  * 8000
      + pStall * 2500;
```

### 2.2 吞吐优先 `tput`

```js
E10MB = 10*1024*1024 / bps_p90 * 1000     // 下载 10 MB 需要多少毫秒
v_tput = E10MB
       + tcp * 0.5                        // 握手只算一次，摊一半
       + pFail  * 8000
       + pStall * 2500;
```

`bps_p90` 来自 **带衰减的直方图**（8 桶 log2，16 KB/s ~ 16 MB/s）：
衰减后重算 p90，所以它是"**近期**峰值能力"，不是历史最高。

> "最大速度"= 能力上限 → 用 p90 不用均值；均值会被"客户端限速/服务器抽风"拖低。

---

## 3. 置信度与收缩

```js
n     = okW + failW;
okBps = bytesDown >= 1MB;                 // 不够 1 MB 的样本不算数

conf_lat  = 1 - Math.exp(-n / 4);         // n≈4 就到 0.63
conf_tput = okBps ? 1 - Math.exp(-n / 8) : 0;   // 吞吐要更谨慎
prior     = median(v of alive 里 n>=2 的) || 400;
vF        = v * conf + prior * (1 - conf);
```

- 新节点**向中位数靠拢**：不进第一，也不垫底
- 吞吐模式额外要求"累计 1 MB"，否则一个 40 KB 的样本就能封神

---

## 4. 两条单向闸门（只加不减）

```js
if (pStall > 0.25 && n >= 5)                 v += 400;   // 明显卡
if (bps_p90 < 8*1024 && n >= 5 && at < 1h)   v += 400;   // 实测极慢
```
闸门**不会抬升任何节点**，只做降级。

---

## 5. 选择状态机

```js
cands = alive ∩ ¬black，按 vF 升序（同分：最久没被选中优先）

if (!cur)                cur = cands[0];
else if (black(cur))     cur = cands[0];
else if (cands[0].v < cur.v - H && now - lastSwitch > DWELL)
                         cur = cands[0];
else                     keep;
```

| 参数 | lat | tput |
|---|---|---|
| 滞回 `H` | `max(20, 15%)` | `cur.v * 0.15` |
| 驻留 `DWELL` | 10 min | 10 min |
| 切换预算 | 3 次/小时 | 3 次/小时 |

**回滚**：切换后 60 s 内 `pStall` 上升或出现失败 → 立刻切回，该节点 30 min 内不再自动选。

---

## 6. 影子采样（喂数据的唯一入口）

```js
pShadow = 0.10;          // 单模式
pShadow = 0.05;          // 双游标时各自减半
```

- 只作用于**新建连接**，在途连接不动
- 目标：本机房 `bytesDown < 1MB 或 n < 3` 的节点，按"最久没测"排序
- 拿到 3 个有效样本即退出待测队列
- 影子连接失败/卡顿 → 该节点 5 min 内不再入选

**它是"最大速度"的前提**：不试就不知道谁快。
死锁由它打破 —— **不是由公式打破**。

---

## 7. 黑名单：指数退避

```
streak 1 → 60 s    2 → 5 min    3 → 15 min    4 → 1 h 后清零再给一次机会
任意成功 → streak = 0, blackUntil = 0
```

---

## 8. 算例

| 节点 | tcp | tls | pFail | pStall | bps_p90 | v_lat | v_tput |
|---|---|---|---|---|---|---|---|
| A | 38 | 52 | 0.01 | 0.004 | 2.0 MB/s | **190** | **5,109** |
| B | 180 | 190 | 0.00 | 0.00 | 1.2 MB/s | 408 | 8,423 |
| C | 40 | 320 | 0.05 | 0.02 | 0.3 MB/s | 1,294 | 33,803 |
| D | 60 | 90 | 0.30 | 0.01 | 0.05 MB/s | 2,593 | 202,430 |

- `lat` 模式：A < B < C < D —— **近距丢包（C）比远距稳定（B）更糟**
- `tput` 模式：A < B < C < D —— 吞吐差距（数千毫秒）**完全压过**延迟差距（几十毫秒）

---

## 9. 可解释接口

`GET /<uuid>/proxyip?why=1`

```json
{"colo":"AMS","mode":"tput","cur":"45.147.250.39:443",
 "explain":[
  {"k":"45.147.250.39:443","v":5109,"chosen":true,
   "terms":{"e10mb":5000,"tcp":19,"fail":80,"stall":10,"gate":0},
   "n":132,"bytesDown":734003200,"pFail":0.010,"bps_p90":2097152},
  {"k":"91.215.154.80:443","v":33803,"chosen":false,
   "terms":{"e10mb":33333,"tcp":20,"fail":400,"stall":50,"gate":0},
   "n":9,"bytesDown":1887436,"pFail":0.05,"bps_p90":314572}
 ]}
```

---

## 10. 参数总表

| 参数 | 默认 | 说明 |
|---|---|---|
| `HL` | 6 h | 衰减半衰期 |
| `alphaTcp` | 0.3 | EWMA 系数 |
| `priorTcp/priorTls` | 250 / 60 ms | 冷启动先验 |
| `failCost` | 8000 ms | 一次失败的期望代价 |
| `stallCost` | 2500 ms | 卡顿当量 |
| `tlsGain` | 1.2 | 握手权重 |
| `lossGain/lossSlack` | 2 / 30 ms | 重传判定 |
| `confLat / confTput` | n/4 / n/8 | 置信度曲线 |
| `priorBps` | 200 KB/s | 无样本时的 E10MB≈51 s |
| `minSampleBytes` | 1 MB | 吞吐样本准入 |
| `H_lat / H_tput` | 20 ms / 15% | 滞回 |
| `DWELL` | 10 min | 最小驻留 |
| `budget` | 3 /h | 切换预算 |
| `pShadow` | 10% / 5%×2 | 影子比例 |
| `rollback` | 60 s → 冻 30 min | 回滚 |

---

## 11. 验收用例

| 场景 | 期望 |
|---|---|
| 全新节点（n=0） | 排在中位数附近，不抢第一 |
| 影子 3 个样本、共 1.2 MB | 正式进入排名 |
| 2 MB/s 节点有 30% 失败率 | 被 1.2 MB/s 但不失败的节点反超（2400 vs 5000 量级） |
| 同一节点 24 h 前失败 5 次 | 衰减到 1/16，不再拖累 |
| lat 模式近距丢包 vs 远距稳定 | 选后者 |
| tput 模式（同一对） | 看谁 bps_p90 高，不看延迟 |
| 切换后立刻卡顿 | 60 s 内回滚，30 min 内不再选它 |
| 客户端本身限速 1 MB/s | 所有节点 bps 都趋近 1 MB/s，排名退化但不出错 |

---

## 12. 与旧实现的对照

| 维度 | 旧 | 新 |
|---|---|---|
| 单位 | ms / 次数 / MB/s 混用 | 毫秒当量 |
| 失败 | 终身计数 `fail*40` | 6 h 衰减 + Beta 先验 |
| 近期失败 | `recent*300` 二值 10 min | 连续衰减 |
| 吞吐 | `-mbps*60` 进公式（死锁） | 独立模式 + 影子采样 |
| 置信度 | 无 | `1-exp(-n/k)` + 中位数收缩 |
| 抖动 | 单次 ms 直接进排序 | EWMA + 滞回 |
| 可解释 | 无 | `?why=1` 逐项分解 |
