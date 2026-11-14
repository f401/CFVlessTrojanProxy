import { PAGES } from "../views/pageview";
import { adminAuthed, newNonce, randomPwd, rlReset, rlTake, sessionToken, sha256Hex } from "../edge/auth";
import { loadUsers, saveUsers } from "../proxy/protocol";
import { eachLimit } from "../core/util";
import { readStats } from "../store/index";
import { html } from "../edge/respond";
import type { RouteCtx } from "../edge/types";

/** /admin：登录（挑战-应答）+ 用户增删改。未设 adminKey 时整个面板关闭 */
export async function admin(c: RouteCtx): Promise<Response> {
  const { env, url, request, host: _host, first, seg, pageKey } = c;
  /* ---------- 管理面板（会话登录） ---------- */
  if (first === "admin") {
    const adminKey = String(env.adminKey || "");
    const safeHtml = (body: string, status = 200) => html(body, status);

    if (!adminKey) return safeHtml(PAGES.adminHint(), 503);
    if (adminKey.length < 12) {
      return new Response("adminKey 太短：请改用 16 位以上随机字符", { status: 503 });
    }

    const sub = (seg[1] || "").toLowerCase();

    // 登出
    if (sub === "logout") {
      return new Response(null, {
        status: 303,
        headers: {
          location: "/admin",
          "set-cookie": "adm=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
        },
      });
    }

    // 登录提交：只收 nonce + sha256(nonce:密码)
    if (sub === "login" && request.method === "POST") {
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      // 内存计数优先（同一 isolate 内精确），KV 只做跨 isolate 的粗粒度兜底
      if (!rlTake(ip, 10)) {
        return safeHtml(PAGES.login(newNonce(), "尝试次数过多，请 10 分钟后再试"), 429);
      }

      const f = await request.formData();
      const n = String(f.get("n") || "");
      const p = String(f.get("p") || "").toLowerCase();
      const ts = parseInt(n.split(".")[0], 16);
      if (!n || !p) return safeHtml(PAGES.login(newNonce(), "缺少参数"), 400);
      if (!ts || Date.now() - ts > 300000) {
        return safeHtml(PAGES.login(newNonce(), "登录已过期，请重试"), 400);
      }
      const want = await sha256Hex(`${n}:${adminKey}`);
      if (p !== want) {
        return safeHtml(PAGES.login(newNonce(), "密码错误"), 401);
      }
      rlReset(ip);

      const tok = await sessionToken(env);
      return new Response(null, {
        status: 303,
        headers: {
          location: "/admin",
          "set-cookie": `adm=${tok}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`,
        },
      });
    }

    // 其余都要已登录
    if (!(await adminAuthed(request, url, env))) {
      if (request.method === "POST") return new Response("Forbidden", { status: 403 });
      return safeHtml(PAGES.login(newNonce(), ""));
    }

    // 用户操作
    if (sub === "op" && request.method === "POST") {
      const f = await request.formData();
      const op = String(f.get("op") || "");
      const target = String(f.get("id") || "").toLowerCase();
      const cur = await loadUsers(env);
      // 读 KV 失败且没有完整缓存时，cur.list 可能缺托管用户；此时任何
      // 增删改都会把缺失的用户从 KV 里整份删掉，必须拒绝
      if (cur.ok === false) {
        return new Response("用户表暂时读不到（KV 故障），为避免覆盖请稍后重试", { status: 503 });
      }
      let list = cur.list.filter((x) => x.managed).map((x) => ({ ...x }));

      if (op === "add") {
        list.push({
          id: crypto.randomUUID(),
          pwd: randomPwd(16),
          note: String(f.get("note") || "").slice(0, 40),
          enabled: true,
          managed: true,
          ts: Date.now(),
        });
      } else if (op === "del") {
        list = list.filter((x) => x.id !== target);
      } else if (op === "toggle") {
        list = list.map((x) => (x.id === target ? { ...x, enabled: x.enabled === false } : x));
      } else if (op === "reset") {
        list = list.map((x) => (x.id === target ? { ...x, pwd: randomPwd(16) } : x));
      }

      await saveUsers(env, list);
      // 用 ?k= 打开面板时，操作后的 303 也要带上 k，否则下一跳掉回登录页
      const k = url.searchParams.get("k") || "";
      const back = "/admin" + (k ? "?k=" + encodeURIComponent(k) : "");
      return new Response(null, { status: 303, headers: { location: back } });
    }

    // 面板
    const users = await loadUsers(env);
    // 用量从 Meter DO 取（和 /stats 同一个口径）。
    // 以前读的是 `stats:<date>` 这个早已废弃的键 —— 迁移到 snap/DO 之后
    // 它再也没人写，"今日用量" 永远是 0。
    const statsMap: Record<string, { up: number; down: number; todayUp: number; todayDown: number }> = {};
    // 并行读：用户一多，串行 await 会把面板拖到几秒（每次都是一次 DO 往返）。
    // 限 8 并发：不把 50 个用户同时打出去，也不至于一个个排队。
    await eachLimit(users.list, 8, async (u) => {
      try {
        const s = await readStats(env, u.id);
        statsMap[u.id] = {
          up: s.up || 0,
          down: s.down || 0,
          todayUp: s.todayUp || 0,
          todayDown: s.todayDown || 0,
        };
      } catch (e) {
        /* 单个用户读失败不影响整页 */
      }
    });
    return safeHtml(PAGES.admin({ url, users, statsMap, pageKey }));
  }

  return new Response("Not Found", { status: 404 });
}

