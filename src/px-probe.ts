/* 代理节点：探活与池子抓取 */
const PROBE_HELLO = (() => {
  const hx = "16030100d2010000ce030380f2b59e000bbca2041abbd20c3ad59999e3ee3a101aa9956fc2b767da0a0b36000038c02cc030009fcca9cca8ccaac02bc02f009ec024c028006bc023c0270067c00ac0140039c009c0130033009d009c003d003c0035002f00ff0100006d0000001700150000127777772e636c6f7564666c6172652e636f6d000b000403000102000a000c000a001d0017001e00190018002300000016000000170000000d002a0028040305030603080708080809080a080b080408050806040105010601030303010302040205020602";
  const a = new Uint8Array(hx.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(hx.substr(i * 2, 2), 16);
  return a;
})();

// 额外候选主机（不是列表，是"池域名"，解析后是多台机器）
const EXTRA_HOSTS = ["pyip.ygkkk.dpdns.org"];

// 候选池来源（按价值排序；单源失败不影响其余源）
//   1. IPDB 官方 GitHub 镜像 —— API 站从 Worker 访问恒 403，镜像可通
//   2. CB-X2-Jun —— IP:PORT:CC 格式，上游已做存活校验
//   3. jsDelivr —— 与 2 同内容，防 raw.githubusercontent 429
//   4. IPDB 精选带国家码
//   5. 老源（唯一长期验证可用的原始源）
//   6. 官方 API —— 目前 403，留作对方解封后的兜底
const POOL_SOURCES = [
  "https://raw.githubusercontent.com/ymyuuu/IPDB/main/BestProxy/proxy.txt",
  "https://raw.githubusercontent.com/CB-X2-Jun/cf-proxyip-lists/main/proxyip.txt",
  "https://cdn.jsdelivr.net/gh/CB-X2-Jun/cf-proxyip-lists@main/proxyip.txt",
  "https://raw.githubusercontent.com/ymyuuu/IPDB/main/BestProxy/bestproxy%26country.txt",
  "https://raw.githubusercontent.com/xgonce/Cloudflare_IP/main/result.csv",
  "https://ipdb.api.030101.xyz/?type=proxy",
];

// 一行候选：IP[:PORT][#CC | ,… | :CC | 空白]
const PX_LINE = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?(?:[#,:]|\s|$)/;

/**
 * 解析候选池的一行文本并写入去重表；私网/保留地址直接丢弃。
 * @param {string} line 一行文本（IP[:PORT][#CC|,|:CC]）
 * @param {string} src 来源 URL
 * @param {Map<string,object>} seen 去重表（key = ip:port）
 * @returns {boolean} 是否为有效新增
 */
function takePoolLine(line, src, seen) {
  const m = PX_LINE.exec(line.trim());
  if (!m) return false;
  const ip = m[1];
  let port = m[2] ? Number(m[2]) : 443;
  if (!(port >= 1 && port <= 65535)) port = 443;
  if (checkTarget(ip, port)) return false;
  const oct = ip.split(".").map(Number);
  if (oct.some((x) => !(x >= 0 && x <= 255))) return false;
  const key = ip + ":" + port;
  if (!seen.has(key)) seen.set(key, { h: ip, p: port, src });
  return true;
}

const POOL_TTL_MS = 24 * 3600e3;    // 候选池重建周期（上游源每天都会变）
// 换节点策略（可用环境变量覆盖）
//   pxDwellMin : 切换后最少驻留多少分钟（默认 360 = 6 小时）
//   pxFailMax  : 连续失败多少次才允许换（默认 5）
//   pxForceAt  : 失败到这个数就无视驻留强制换（默认 8）
/**
 * 读取轮换策略（可用 env 覆盖）。
 * @param {object} env Worker 环境
 * @returns {{dwell:number, fail:number, force:number}} 驻留毫秒、失败阈值、强制换阈值
 */
function pxPolicy(env: Env) {
  const d = Number(env.pxDwellMin);
  const f = Number(env.pxFailMax);
  const x = Number(env.pxForceAt);
  return {
    dwell: (Number.isFinite(d) && d >= 0 ? d : 0) * 60000,
    fail: Number.isFinite(f) && f > 0 ? f : 3,
    force: Number.isFinite(x) && x > 0 ? x : 5,
  };
}

/**
 * 探测某个候选是否为开放反代：TLS 握手后看证书链里是否出现 cloudflare。
 * @param {string} h 候选主机
 * @param {number} p 候选端口
 * @returns {Promise<{h:string,p:number,ms:number,ts:number,bad?:string}|null>} 成功返回节点信息，失败返回 null
 */
async function probeProxy(h, p) {
  if (checkTarget(h, p)) return null;      // 纵深防御：任何路径都不许探内网
  const t0 = Date.now();
  let sock = null;
  try {
    try {
      sock = await connect({ hostname: h, port: p });
    } catch (e0) {
      // IPv4 字面量在 Workers 上常常连不上，退回 sslip.io
      if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) throw e0;
      sock = await connect({ hostname: h + ".sslip.io", port: p });
    }
    const tcp = Date.now() - t0;          // ① 建连：纯网络 S.rtt
    const w = sock.writable.getWriter();
    await w.write(PROBE_HELLO);
    w.releaseLock();

    const r = sock.readable.getReader();
    let buf = new Uint8Array(0);
    const deadline = Date.now() + 4000;

    while (Date.now() < deadline && buf.length < 8192) {
      const wait = Math.max(200, deadline - Date.now());
      let got = null;
      try {
        got = await Promise.race([
          r.read(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), wait)),
        ]);
      } catch (e) {
        break;                       // 超时/断开：跳出，走下面的诊断返回
      }
      const v = got && got.value;
      if (!v || !v.length) break;
      const merged = new Uint8Array(buf.length + v.length);
      merged.set(buf, 0);
      merged.set(v, buf.length);
      buf = merged;

      if (buf[0] !== 0x16) return { h, p, ms: Date.now() - t0, tcp, tls: 0, ts: Date.now(), bad: "not-tls", head: toHex(buf.slice(0, 16)) };
      if (/cloudflare/i.test(dec.decode(buf))) {
        // ② TLS 往返：建连完成到收到第一段证书字节。丢包会让这段异常变长。
        return { h, p, ms: Date.now() - t0, tcp, tls: Math.max(0, Date.now() - t0 - tcp), ts: Date.now() };
      }
    }
    return { h, p, ms: Date.now() - t0, tcp, tls: 0, ts: Date.now(), bad: "no-cf-cert", len: buf.length, head: toHex(buf.slice(0, 24)) };
  } catch (e) {
    return null;
  } finally {
    try { sock && sock.close(); } catch (e) {}
  }
}

/**
 * 从所有上游源抓取候选池并按 ip:port 去重（单源失败不影响其他源）。
 * @param {object} env Worker 环境
 * @returns {Promise<Array<{h:string,p:number,src:string}>>} 合并后的候选池
 */
async function refillPool(env: Env) {
  const seen = new Map();
  for (const src of POOL_SOURCES) {
    try {
      const r = await fetch(src, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          accept: "text/html,application/json,text/plain,*/*",
          "accept-language": "en-US,en;q=0.9",
          referer: "https://www.google.com/",
        },
      });
      if (!r.ok) continue;
      const txt = await r.text();
      for (const line of txt.split("\n")) takePoolLine(line, src, seen);
    } catch (e) {
      /* 换下一个源 */
    }
  }
  for (const h of EXTRA_HOSTS) {
    if (!seen.has(h)) seen.set(h, { h, p: 443, src: "builtin" });
  }

  const pool = [...seen.values()];
  if (pool.length) logErr("pool refilled: " + pool.length, "");
  return pool;
}

/**
 * 批量查询 IP 归属国（第三方免费接口，单次最多 100 个）。
 * @param {string[]} ips IP 列表
 * @returns {Promise<Record<string,string>>} IP → 两位国家码
 */
async function geoLabel(ips) {
  const out = {};
  if (!ips.length) return out;
  try {
    const r = await fetch("http://ip-api.com/batch?fields=status,countryCode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ips.slice(0, 100)),
    });
    if (r.ok) {
      const arr = await r.json();
      arr.forEach((x, i) => {
        if (x && x.status === "success" && x.countryCode) out[ips[i]] = String(x.countryCode).toUpperCase();
      });
    }
  } catch (e) {
    /* 查不到就不打标，不影响可用性 */
  }
  return out;
}

/**
 * 得出订阅里要输出的地区列表（配置固定值或按 alive 自动推断）。
 * @param {object} env Worker 环境
 * @returns {Promise<string[]>} 最多 6 个两位国家码
 */
async function regionListAsync(env: Env) {
  const raw = String(env.regions || "").trim();
  if (raw && raw.toLowerCase() !== "auto") {
    return raw
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter((x) => /^[A-Z]{2}$/.test(x))
      .slice(0, 6);
  }
  const list = await aliveList(env);
  const set = [];
  for (const x of list) {
    const cc = (x.cc || "").toUpperCase();
    if (cc && !set.includes(cc)) set.push(cc);
  }
  return set.slice(0, 6);
}

