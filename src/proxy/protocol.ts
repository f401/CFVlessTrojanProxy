import { kvGetStrict, kvSet } from "../store/index";
import { dec, enc, secretPwd, sha224Bytes, toHex, uuidFromBytes } from "../core/util";

/* 协议解析：VLESS / Trojan 首包 */
export const USERS_TTL = 300000; // 仅作 KV 读失败后的重试冷却基准（1 分钟后再试）；正常路径每次都读 KV

export const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 功能：用户表装配器：把 env 里的 `uuid`/`trojan` 与 KV 托管用户合并成一张表。
 *
 * 为什么值得成类：装配过程要同时维护四张互相引用的结构（按 id 索引、启用集合、
 * 密码摘要 → owner、输出顺序表），而「共享密码归谁」与「托管记录能否覆盖 env 的启用状态」
 * 这两条口径完全由加入顺序决定。散在一条 102 行函数里，任何人想改其中一条都要通读全部。
 */
export class UserIndex {
  /** 按 id 索引：同一 id 后写覆盖前写的 note / enabled / managed */
  private readonly byId = new Map<string, UserRec>();
  /** 启用用户的 id 集合：鉴权第一道门，登出/禁用要立刻从这里消失 */
  private readonly enabledIds = new Set<string>();
  /** 密码摘要 → 该密码的稳定 owner（共享密码只认一个） */
  private readonly owners = new Map<string, string>();
  /** 装配结果：按加入顺序，面板与订阅都依赖这个顺序 */
  readonly list: UserRec[] = [];

  /**
   * 功能：算密码摘要（共享密码的索引键，不是口令本身）。
   * @param pwd 明文密码
   * @returns sha224 的十六进制串
   */
  private hash(pwd: string): string {
    return toHex(sha224Bytes(enc.encode(pwd)));
  }

  /**
   * 功能：登记一个密码的 owner；共享密码只保留一个稳定 owner。
   *
   * 为什么不让后加载的顶掉前面的：env 里两位用户贴了同一个密码时，
   * 谁后写谁就成了 owner，面板与订阅会随加载顺序抖动。
   * @param id 用户 id
   * @param pwd 明文密码
   * @returns 无
   */
  private setOwner(id: string, pwd: string): void {
    const h = this.hash(pwd);
    const cur = this.owners.get(h);
    if (!cur || cur === id) {
      this.owners.set(h, id);
      return;
    }
    // 已有 owner 且它还启用着 ⇒ 保留它；否则转给当前这个
    const owner = this.byId.get(cur);
    if (!owner || !owner.enabled) this.owners.set(h, id);
  }

  /**
   * 功能：撤销某个 id 自己的密码映射；共享密码要转给另一个启用用户。
   * @param id 用户 id
   * @returns 无
   */
  private dropOwner(id: string): void {
    for (const [h, uid] of this.owners) {
      if (uid !== id) continue;
      // 共享密码：先找到另一个启用且密码摘要相同的用户接过去
      const other = this.list.find((x) => x.id !== id && x.enabled && x.pwd && this.hash(x.pwd) === h);
      if (other) this.owners.set(h, other.id);
      else this.owners.delete(h);
    }
  }

  /**
   * 功能：把一个用户并进表里（env 与托管两条来源都走这里）。
   * @param id 用户 id（必须是 UUID，否则忽略）
   * @param pwd 明文密码
   * @param note 备注
   * @param enabled 是否启用
   * @param managed 是否来自面板托管
   * @returns 无
   */
  add(id: string, pwd?: string, note?: string, enabled?: boolean, managed?: boolean): void {
    if (!RE_UUID.test(id)) return;
    let rec = this.byId.get(id);
    if (!rec) {
      rec = { id, pwd: "", note: note || "", enabled: enabled !== false, managed: !!managed };
      this.list.push(rec);
      this.byId.set(id, rec);
    } else {
      if (note && !rec.note) rec.note = note;
      if (managed) rec.managed = true;
      rec.enabled = enabled !== false; // 托管记录最后写，必须能覆盖 env 的启用状态
    }
    // 换密码要先撤销旧映射，否则旧摘要会一直指向这个用户
    if (pwd) {
      if (rec.pwd && rec.pwd !== pwd) this.dropOwner(id);
      rec.pwd = pwd;
    }
    if (rec.enabled) {
      this.enabledIds.add(id);
      if (rec.pwd) this.setOwner(id, rec.pwd);
    } else {
      this.enabledIds.delete(id);
      this.dropOwner(id);
    }
  }

  /**
   * 功能：并进环境变量里的用户（`uuid`/`uuids` 与 `trojan` 的单密码/多密码两种写法）。
   * @param env Worker 环境
   * @returns 无
   */
  fromEnv(env: Env): void {
    const rawIds = String(env.uuids || env.uuid || "");
    rawIds.split(",").forEach((x) => this.add(x.trim().toLowerCase(), "", "env", true, false));
    const rawTrojan = secretPwd(env);
    if (rawTrojan && !rawTrojan.includes(":")) {
      // 单密码模式：一个公共密码，给所有 env 用户用
      rawIds.split(",").forEach((x) => this.add(x.trim().toLowerCase(), rawTrojan, "env", true, false));
      return;
    }
    // 多密码模式：user_uuid:password,user_uuid:password（没有冒号的项忽略）
    rawTrojan.split(",").forEach((pair) => {
      const i = pair.indexOf(":");
      if (i < 0) return;
      this.add(pair.slice(0, i).trim().toLowerCase(), pair.slice(i + 1).trim(), "env", true, false);
    });
  }

  /**
   * 功能：并进面板托管的用户（最后写，因此能覆盖 env 的启用状态）。
   * @param rows KV 里的托管用户
   * @returns 无
   */
  fromManaged(rows: Partial<UserRec>[]): void {
    for (const m of rows) {
      if (!m || !m.id) continue;
      this.add(String(m.id).toLowerCase(), m.pwd, m.note || "", m.enabled !== false, true);
    }
  }

  /**
   * 功能：导出鉴权表（用户列表 + 启用 id 集合 + 密码 owner 表）。
   * @param readOk 这次 KV 读成功了吗（false 时上层会把缓存缩短到 1 分钟）
   * @returns 用户表与两套鉴权索引
   */
  result(readOk: boolean): Auth {
    return { uuids: this.enabledIds, trojan: this.owners, list: this.list, ok: readOk };
  }
}

/**
 * 用户表缓存：只在 KV 读失败时兜底；正常路径每次都读 KV。
 */
export class UserCache {
  /** 最近一次读到的用户表（KV 故障兜底用） */
  v: Auth | null = null;
  /** 当前 env 的用户表签名，用于判断旧表是否仍属于同一套 env */
  sig = "";
  /** 缓存写入时间（故障兜底时设成已过期，让下一请求立刻重试 KV） */
  t = 0;

  /**
   * 功能：记下当前 env 签名，返回上一份签名用于比较。
   * @param sig 当前 env 用户表签名
   * @returns 上一次的签名
   */
  swapSig(sig: string): string {
    const prevSig = this.sig;
    this.sig = sig;
    return prevSig;
  }

  /**
   * 功能：KV 读失败时取旧表兜底，并把时间戳设成已过期。
   * @returns 带 ok=false 的旧表；无旧表时返回 null
   */
  stale(): Auth | null {
    if (!this.v) return null;
    this.t = Date.now() - USERS_TTL;
    return { ...this.v, ok: false };
  }

  /**
   * 功能：记录最近一次读到的用户表；故障兜底表直接标成已过期。
   * @param auth 用户表
   * @param readOk 这次 KV 读是否成功
   * @returns 无
   */
  remember(auth: Auth, readOk: boolean): void {
    this.v = auth;
    this.t = readOk ? Date.now() : Date.now() - USERS_TTL;
  }

  /**
   * 功能：清空缓存，使下一次 loadUsers 重新读 KV。
   * @returns 无
   */
  invalidate(): void {
    this.v = null;
    this.t = 0;
  }
}

/** 用户表缓存的进程内实例：loadUsers / invalidateUsers 共用 */
export const USERS = new UserCache();

/**
 * 功能：加载用户表：把 env 里的 uuid/trojan（secret）与 KV 托管用户合并，结果缓存 5 分钟。
 * @param env Worker 环境（读 uuid / uuids / trojan / STATS）
 * @returns 用户表与两套鉴权索引
 */
export async function loadUsers(env: Env): Promise<Auth> {
  const sig = `${env.uuids || env.uuid || ""}|${secretPwd(env)}`;
  const prevSig = USERS.swapSig(sig);

  let managed: Partial<UserRec>[] = [];
  let readOk = true;
  try {
    // 用户表每次都读 KV：面板加的用户在别的 isolate 上必须立刻生效。
    // 以前拿「只含 env 变量的 sig」当正向缓存键，托管用户不在 sig 里，
    // A isolate 加完用户只清了自己，B isolate 命中旧缓存 ⇒ 新 UUID 一直 404
    // 直到 5 分钟 TTL 到期。这里的内存表因此**只**当 KV 读失败时的兜底，
    // 绝不作为正常路径的返回值。
    managed = (await kvGetStrict<UserRec[]>(env, "users")) || [];
  } catch (e) {
    // KV 抖动不等于"没有用户"：有旧缓存就继续用，别让所有托管用户被踢下线
    readOk = false;
  }
  if (!readOk && USERS.v && prevSig === sig) {
    // 读失败且上一份缓存还是同一套 env：继续用旧表，并保持"过期"时间戳，
    // 让下一个请求立刻再试 KV（不再因 TTL 未到而长期停在旧表）。
    // 关键：兜表必须标 ok=false —— 面板 usersOp 靠它拒绝增删改。旧表可能
    // 缺别的 isolate 刚加的用户，若当完整表写回 KV 会把新用户整份删掉。
    const stale = USERS.stale();
    if (stale) return stale;
  }

  // 装配顺序是口径：env 先、托管后（托管记录必须能覆盖 env 的启用状态）
  const index = new UserIndex();
  index.fromEnv(env);
  index.fromManaged(managed);
  const out = index.result(readOk);
  // 只保留最近一次成功读到的表，供 KV 故障时兜底（正常路径不会命中它）
  USERS.remember(out, readOk);
  return out;
}

/**
 * 清空用户表缓存，使下一次 loadUsers 重新读 KV（面板改完立刻生效）。
 * @returns {void}
 */
export function invalidateUsers() {
  USERS.invalidate();
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
 * 把两种协议里含义不同的地址类型字节归一化成 VLESS 语义。
 * @param {'vless'|'trojan'} proto 协议名
 * @param {number} atyp 原始地址类型字节
 * @returns {string|null} v4 / dom / v6 三个标签之一；识别不了回 null
 * （返回的不是数字 atyp：数字是线协议里的字节，标签是给人读的）
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
 * @param {string} kind normAtyp 归一化后的标签（v4 / dom / v6）
 * @returns {{host: string, next: number}|{err: string}} 成功给地址与下一字段偏移，失败给错误文案
 * （端口不在这里读：VLESS 的端口在地址之前、Trojan 的在之后，各自解析器按自己的顺序取）
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


/** 首帧解析的结构化结果：成功给出目标与偏移，失败给出原因与「该不该回 400」 */
export type FrameResult =
  | { ok: true; id: string; host: string; port: number; proto: string; ver?: number; udp: boolean; udpTrojan: boolean; offset: number }
  | { ok: false; err: string; bad: boolean };

/**
 * 功能：把首帧（VLESS / Trojan 头）解析成目标或失败原因 —— **纯函数式**，不做 I/O、不动账本、不关连接。
 *
 * 为什么单独成类：会话原先把「选协议、解析、回 400、记 noAuth、写 st.id/st.host、statBump、rttLearn、
 * checkTarget、设置 VLESS 响应头」全部塞在一个 parseHead 里，任何一条顺序错了都要靠通读才能发现（v7.187
 * 那种「先记统计后判目标」的错就是这样漏进去的）。这里只回答「这帧是什么」，副作用留给调用方按顺序做。
 */
export class FirstFrame {
  /**
   * 功能：判这一帧属于哪套协议（不解析目标）。
   *
   * 为什么单独给一个：诊断与单测要先知道「这一帧该按哪套规则解」，而 `read()`
   * 在鉴别之前就要求用户表齐全、失败还要区分 400 与 1011，拿它做分类太重。
   * @param u8 首帧内容
   * @returns `vless` 或 `trojan`
   */
  kindOf(u8: Uint8Array): "vless" | "trojan" {
    // Trojan 的指纹是「56 个十六进制字符 + CRLF」；VLESS 的版本号在实践中是 0，
    // 所以不能用首字节判（第一版就是这么写的，把真实 VLESS 全判成了 Trojan）
    if (u8.length < 58 || u8[56] !== 0x0d || u8[57] !== 0x0a) return "vless";
    for (let i = 0; i < 56; i++) {
      const c = u8[i];
      const hex = (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
      if (!hex) return "vless";
    }
    return "trojan";
  }

  /**
   * 功能：解析首帧。
   * @param u8 首帧内容
   * @param users 用户表（鉴权与 Trojan 密码摘要都在里面）
   * @returns 目标或失败原因；`bad` 为真表示该回 400（协议错），否则是按 1011 关
   */
  read(u8: Uint8Array, users: Auth): FrameResult {
    // 与 `kindOf()` 用同一判据：只有「56 hex + CRLF」才是 Trojan
    const hard = this.kindOf(u8) === "vless" ? parseVLESS(u8, users) : parseTrojan(u8, users);
    if (hard.ok === false) return { ok: false, err: hard.err, bad: true };
    return {
      ok: true,
      id: hard.id,
      host: hard.host,
      port: hard.port,
      proto: hard.proto,
      ver: hard.ver,
      udp: !!hard.udp,
      udpTrojan: hard.proto === "trojan",
      offset: hard.offset,
    };
  }
}
