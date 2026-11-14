import { S } from "../core/state";
import { kvGetStrict, kvSet } from "../store/index";
import { dec, enc, secretPwd, sha224Bytes, toHex, uuidFromBytes } from "../core/util";

/* 协议解析：VLESS / Trojan 首包 */
export const USERS_TTL = 300000; // 面板改动最多 5 分钟生效（把 KV 读从 1.4 万/天压到 1.4 千）

export const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 加载用户表：把 env 里的 uuid/trojan（secret）与 KV 托管用户合并，结果缓存 5 分钟。
 * @param {object} env Worker 环境（读 uuid / uuids / trojan / STATS）
 * @returns {Promise<{list: Array, uuids: Set<string>, trojan: Map<string,string>}>} 用户表与两套鉴权索引
 */
export async function loadUsers(env: Env): Promise<Auth> {
  const sig = `${env.uuids || env.uuid || ""}|${secretPwd(env)}`;
  if (S.usersCache.v && S.usersSig === sig && Date.now() - S.usersCache.t < USERS_TTL) return S.usersCache.v;
  const prevSig = S.usersSig;
  S.usersSig = sig;

  let managed: Partial<UserRec>[] = [];
  let readOk = true;
  try {
    managed = (await kvGetStrict<UserRec[]>(env, "users")) || [];
  } catch (e) {
    // KV 抖动不等于"没有用户"：有旧缓存就继续用，别让所有托管用户被踢下线
    readOk = false;
  }
  if (!readOk && S.usersCache.v && prevSig === sig) {
    S.usersCache.t = Date.now() - USERS_TTL + 60000; // 1 分钟后再试，别每个请求都打 KV
    return S.usersCache.v;
  }

  const uuids = new Set<string>();
  const trojan = new Map<string, string>();
  const list: UserRec[] = [];
  const byId = new Map<string, UserRec>();
  const hashOf = (pwd: string) => toHex(sha224Bytes(enc.encode(pwd)));

  /** 共享密码只保留一个稳定 owner；不要让后加载的用户把前面的顶掉 */
  const setTrojan = (id: string, pwd: string) => {
    const h = hashOf(pwd);
    const cur = trojan.get(h);
    if (!cur || cur === id) {
      trojan.set(h, id);
      return;
    }
    const owner = byId.get(cur);
    if (!owner || !owner.enabled) trojan.set(h, id);
  };

  /** 只撤销该 id 自己的映射；如果密码是多人共享的，转给另一个启用用户 */
  const delTrojanFor = (id: string) => {
    for (const [h, uid] of trojan) {
      if (uid !== id) continue;
      const other = list.find((x) => x.id !== id && x.enabled && x.pwd && hashOf(x.pwd) === h);
      if (other) trojan.set(h, other.id);
      else trojan.delete(h);
    }
  };

  const add = (id: string, pwd?: string, note?: string, enabled?: boolean, managedFlag?: boolean) => {
    if (!RE_UUID.test(id)) return;
    let rec = byId.get(id);
    if (!rec) {
      rec = { id, pwd: "", note: note || "", enabled: enabled !== false, managed: !!managedFlag };
      list.push(rec);
      byId.set(id, rec);
    } else {
      if (note && !rec.note) rec.note = note;
      if (managedFlag) rec.managed = true;
      rec.enabled = enabled !== false; // 托管记录最后写，必须能覆盖 env 的启用状态
    }
    if (pwd) {
      if (rec.pwd && rec.pwd !== pwd) delTrojanFor(id);
      rec.pwd = pwd;
    }
    if (rec.enabled) {
      uuids.add(id);
      if (rec.pwd) setTrojan(id, rec.pwd);
    } else {
      uuids.delete(id);
      delTrojanFor(id);
    }
  };

  // 1) 环境变量里的用户
  String(env.uuids || env.uuid || "")
    .split(",")
    .forEach((x) => add(x.trim().toLowerCase(), "", "env", true, false));

  const rawTrojan = secretPwd(env);
  if (rawTrojan && !rawTrojan.includes(":")) {
    // 单密码模式：一个公共密码，给所有 env 用户用
    String(env.uuids || env.uuid || "")
      .split(",")
      .forEach((x) => add(x.trim().toLowerCase(), rawTrojan, "env", true, false));
  } else {
    // 多密码模式：user_uuid:password,user_uuid:password
    rawTrojan.split(",").forEach((pair) => {
      const i = pair.indexOf(":");
      if (i < 0) return;
      add(pair.slice(0, i).trim().toLowerCase(), pair.slice(i + 1).trim(), "env", true, false);
    });
  }

  // 2) 面板管理的用户
  for (const m of managed) {
    if (!m || !m.id) continue;
    add(String(m.id).toLowerCase(), m.pwd, m.note || "", m.enabled !== false, true);
  }

  const out = { uuids, trojan, list, ok: readOk };
  S.usersCache = { v: out, t: readOk ? Date.now() : Date.now() - USERS_TTL + 60000 };
  return out;
}

/**
 * 清空用户表缓存，使下一次 loadUsers 重新读 KV（面板改完立刻生效）。
 * @returns {void}
 */
export function invalidateUsers() {
  S.usersCache = { v: null, t: 0 };
}

/**
 * 把托管用户列表写回 KV（只序列化 managed=true 的用户）。
 * @param {object} env Worker 环境
 * @param {Array<object>} list 完整用户列表
 * @returns {Promise<void>}
 */
export async function saveUsers(env: Env, list: UserRec[]) {
  const clean = list
    .filter((x) => x.managed)
    .map((x) => ({
      id: x.id,
      pwd: x.pwd || "",
      note: x.note || "",
      enabled: x.enabled !== false,
      ts: x.ts || 0,
    }));
  await kvSet(env, "users", clean);
  invalidateUsers();
}

/* ==================================================================
 * §4  协议侦测与解析
 * ================================================================== */

/**
 * 判断字节区间内是否全为十六进制字符（Trojan 密码预检）。
 * @param {Uint8Array} u8 字节数组
 * @param {number} from 起始下标（含）
 * @param {number} to 结束下标（不含）
 * @returns {boolean} 全部是 0-9a-fA-F 时返回 true
 */
export function isHexAscii(u8: Uint8Array, from: number, to: number) {
  for (let i = from; i < to; i++) {
    const c = u8[i];
    const ok = (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
    if (!ok) return false;
  }
  return true;
}

/**
 * 识别首包协议：第 57-58 字节是 \r\n 且前面 56 字节是十六进制 → Trojan，否则 VLESS。
 * @param {Uint8Array} u8 客户端首个载荷
 * @returns {'vless'|'trojan'} 协议名
 */
export function detectProtocol(u8: Uint8Array) {
  if (u8.length >= 58 && u8[56] === 0x0d && u8[57] === 0x0a && isHexAscii(u8, 0, 56)) {
    return "trojan";
  }
  return "vless";
}

/**
 * 把两种协议里含义不同的地址类型字节归一化成 VLESS 语义。
 * @param {'vless'|'trojan'} proto 协议名
 * @param {number} atyp 原始地址类型字节
 * @returns {number} 归一化后的 atyp（1=IPv4 3=域名 4=IPv6）
 */
export function normAtyp(proto: string, atyp: number): string | null {
  if (proto === "vless") {
    return atyp === 1 ? "v4" : atyp === 2 ? "dom" : atyp === 3 ? "v6" : null;
  }
  return atyp === 1 ? "v4" : atyp === 3 ? "dom" : atyp === 4 ? "v6" : null;
}

/**
 * 从首包中解析目标地址（IPv4 / 域名 / IPv6）。
 * @param {Uint8Array} u8 首包
 * @param {number} off 地址字段起始偏移
 * @param {number} kind 归一化后的 atyp
 * @returns {{host: string, port: number, next: number}|null} 目标地址、端口与下一字段偏移
 */
export function readAddr(u8: Uint8Array, off: number, kind: string): AddrOk | AddrErr {
  // 三种 atyp：v4 定长 4 字节、域名 1 字节长度 + n 字节、v6 定长 16 字节；
  // 任何越界都只回「地址截断」，上层据此直接拒掉，不做部分解析
  if (kind === "v4") {
    if (u8.length < off + 4) return { err: "地址截断" };
    return {
      host: `${u8[off]}.${u8[off + 1]}.${u8[off + 2]}.${u8[off + 3]}`,
      next: off + 4,
    };
  }
  if (kind === "dom") {
    if (u8.length < off + 1) return { err: "地址截断" };
    const n = u8[off];
    if (u8.length < off + 1 + n) return { err: "地址截断" };
    return { host: dec.decode(u8.subarray(off + 1, off + 1 + n)), next: off + 1 + n };
  }
  if (kind === "v6") {
    if (u8.length < off + 16) return { err: "地址截断" };
    // v6 展开成 8 组十六进制（不压缩 ::）：下游只把它当字符串键/SNI 用，不需要标准写法
    const p = [];
    for (let i = 0; i < 8; i++) p.push(((u8[off + i * 2] << 8) | u8[off + i * 2 + 1]).toString(16));
    return { host: p.join(":"), next: off + 16 };
  }
  return { err: "不支持的地址类型" };
}

/**
 * 解析 VLESS 请求头并校验 UUID。
 * @param {Uint8Array} u8 客户端首包
 * @param {object} auth loadUsers 的返回值
 * @returns {{ok: boolean, id?: string, host?: string, port?: number, udp?: boolean, offset?: number, ver?: number, err?: string}} 解析结果
 */
export function parseVLESS(u8: Uint8Array, auth: Auth): ParseResult {
  if (u8.length < 24) return { ok: false, err: "VLESS 头部过短" };

  const ver = u8[0];
  // 头部布局：1 字节版本 + 16 字节 UUID + 1 字节选项长度 + 选项，之后才是命令/端口/地址
  const uuid = uuidFromBytes(u8.subarray(1, 17));
  if (!auth.uuids.has(uuid)) return { ok: false, err: "鉴权失败", id: uuid };

  // 选项区只按长度跳过：里面是 flow/encryption 之类的协商字段，本代理不解释
  const optLen = u8[17];
  let off = 18 + optLen;
  if (u8.length < off + 1) return { ok: false, err: "VLESS 选项截断" };

  // 命令 1=TCP、2=UDP；随后 2 字节大端端口 + 1 字节 atyp
  const cmd = u8[off++];
  if (u8.length < off + 3) return { ok: false, err: "VLESS 头部不完整" };

  const port = (u8[off] << 8) | u8[off + 1];
  off += 2;
  const atyp = u8[off++];

  // atyp 先归一化再解析：VLESS 与 Trojan 对同一含义用了不同的数字（尤其域名是 2/3），交给 normAtyp 统一
  const kind = normAtyp("vless", atyp);
  if (!kind) return { ok: false, err: "不支持的地址类型" };
  const a = readAddr(u8, off, kind);
  if (a.err !== undefined) return { ok: false, err: a.err };

  const udp = cmd === 2;
  if (cmd !== 1 && cmd !== 2) return { ok: false, err: "不支持的命令" };

  return {
    ok: true,
    proto: "vless",
    id: uuid,
    udp,
    host: a.host,
    port,
    offset: a.next,
    ver,
  };
}

/**
 * 解析 Trojan 请求头并用 SHA-224(密码) 校验。
 * @param {Uint8Array} u8 客户端首包
 * @param {object} auth loadUsers 的返回值
 * @returns {{ok: boolean, id?: string, host?: string, port?: number, udp?: boolean, offset?: number, err?: string}} 解析结果
 */
export function parseTrojan(u8: Uint8Array, auth: Auth): ParseResult {
  if (u8.length < 61) return { ok: false, err: "Trojan 头部过短" };

  // 头部布局：56 字节密码摘要（SHA-224 的十六进制）+ CRLF，之后是命令/地址/端口/CRLF
  const hash = dec.decode(u8.subarray(0, 56)).toLowerCase();
  const id = auth.trojan.get(hash);
  if (!id) return { ok: false, err: "鉴权失败" };

  // 58 = 56 字节摘要 + 2 字节 CRLF；从这里开始读命令字节
  let off = 58;
  const cmd = u8[off++];
  const atyp = u8[off++];

  const kind = normAtyp("trojan", atyp);
  if (!kind) return { ok: false, err: "不支持的地址类型" };
  const a = readAddr(u8, off, kind);
  if (a.err !== undefined) return { ok: false, err: a.err };
  off = a.next;

  if (u8.length < off + 2) return { ok: false, err: "Trojan 头部不完整" };
  const port = (u8[off] << 8) | u8[off + 1];
  off += 2;

  // Trojan 用尾部 CRLF 标记头部结束；缺了说明客户端协议不对，直接拒，别把后面的数据当头部继续读
  if (u8.length < off + 2 || u8[off] !== 0x0d || u8[off + 1] !== 0x0a) {
    return { ok: false, err: "Trojan 缺少结尾 CRLF" };
  }
  off += 2;

  // 命令：1=CONNECT(TCP)、3=UDP ASSOCIATE
  const udp = cmd === 3;
  if (cmd !== 1 && cmd !== 3) return { ok: false, err: "不支持的命令" };

  return { ok: true, proto: "trojan", id, udp, host: a.host, port, offset: off };
}

/* ==================================================================
 * §5  出口策略与拨号
 * ================================================================== */

// 危险端口：邮件滥发、数据库、远程桌面、SMB 等

