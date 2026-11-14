// v8 §17.2 的 DO 事实表：语义与代价的可执行验证（只做实验，不进 src/）
// 用法：node tools/exp-facts-db.mjs
// 验证：ON CONFLICT 的「旧证据不覆盖新证据」、容量淘汰、分片读、序列化体积、操作耗时。

import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE facts (
    kind TEXT NOT NULL,
    k    TEXT NOT NULL,
    at   INTEGER NOT NULL,
    j    TEXT NOT NULL,
    PRIMARY KEY (kind, k)
  ) WITHOUT ROWID;
  CREATE INDEX idx_facts_at ON facts (kind, at);
`);

const UPSERT = `
  INSERT INTO facts (kind, k, at, j) VALUES (?, ?, ?, ?)
  ON CONFLICT (kind, k) DO UPDATE SET at = excluded.at, j = excluded.j
  WHERE excluded.at > facts.at
`;
const up = db.prepare(UPSERT);
const get = db.prepare("SELECT at, j FROM facts WHERE kind = ? AND k = ?");
const since = db.prepare("SELECT kind, k, at, j FROM facts WHERE at > ? ORDER BY at LIMIT ?");
const evict = db.prepare(`
  DELETE FROM facts WHERE kind = ? AND k IN (
    SELECT k FROM facts WHERE kind = ? ORDER BY at ASC LIMIT ?
  )
`);
const countKind = db.prepare("SELECT COUNT(*) AS n FROM facts WHERE kind = ?");

let pass = 0;
const fails = [];
const T = 1_700_000_000_000;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fails.push(`${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}
/** 一次写入，返回 {changed, at, j} */
function write(kind, k, at, j) {
  const r = up.run(kind, k, at, JSON.stringify(j));
  const row = get.get(kind, k);
  return { changed: Number(r.changes), at: row?.at, j: row ? JSON.parse(row.j) : null };
}

// 1) 新证据写入
eq("首次写入", write("eg", "45.136.117.194", T, { fam: 4 }), { changed: 1, at: T, j: { fam: 4 } });

// 2) 旧证据不得覆盖新证据（关键：两个 isolate 的乱序到达）
eq("旧证据被忽略", write("eg", "45.136.117.194", T - 5000, { fam: 6 }), { changed: 0, at: T, j: { fam: 4 } });

// 3) 同时间戳也不覆盖（严格大于；避免两个 isolate 互相打乒乓）
eq("等时戳被忽略", write("eg", "45.136.117.194", T, { fam: 6 }), { changed: 0, at: T, j: { fam: 4 } });

// 4) 新证据覆盖
eq("新证据覆盖", write("eg", "45.136.117.194", T + 1000, { fam: 6 }), { changed: 1, at: T + 1000, j: { fam: 6 } });

// 5) 站点维度的键是 host|relay，不与 eg 冲突
eq("复合键独立", write("ps", "x.com|45.136.117.194", T, { ok: 1 }), { changed: 1, at: T, j: { ok: 1 } });
eq("同前缀不同 host", write("ps", "x.com.cn|45.136.117.194", T, { ok: 0 }), { changed: 1, at: T, j: { ok: 0 } });

// 6) 容量淘汰：每个 kind 独立、按 at 升序删
for (let i = 0; i < 20; i++) write("ps", `h${i}.example|10.0.0.${i % 256}`, T + i, { ok: i % 2 });
eq("淘汰前条数", Number(countKind.get("ps").n), 22);
evict.run("ps", "ps", 4);
eq("淘汰 4 条后", Number(countKind.get("ps").n), 18);
eq("淘汰删的是最旧的", get.get("ps", "x.com|45.136.117.194")?.at, undefined);

// 7) 分片读：since 过滤 + 上限
eq("since 读到的条数受 LIMIT", since.all(T, 1000).length <= 1000, true);
eq("since 只返回更新的行", since.all(T + 15, 1000).every((r) => r.at > T + 15), true);

// 8) 序列化体积：一个 ps 行（短键）在 KV/DO 传输里的字节数
const sample = { q: 250, n: 12, at: T + 5 };
eq("ps 行 JSON < 40B", JSON.stringify(sample).length < 40, true);

// 9) 耗时：1000 次 upsert + 一次全量读
const t0 = performance.now();
for (let i = 0; i < 1000; i++) write("ps", `perf${i}.example|10.1.${(i >> 8) & 255}.${i & 255}`, T + i, { ok: i & 1 });
const tWrite = performance.now() - t0;
const t1 = performance.now();
const rows = since.all(0, 1000);
const tRead = performance.now() - t1;
console.log(`1000 次 upsert+回读: ${tWrite.toFixed(1)} ms（均 ${(tWrite / 1000).toFixed(3)} ms/次）`);
console.log(`一次 since 读 ${rows.length} 行: ${tRead.toFixed(2)} ms`);
console.log(`全库 JSON 体积: ${(JSON.stringify(since.all(0, 99999)).length / 1024).toFixed(1)} KB`);

console.log(`\n${pass}/${pass + fails.length} 通过`);
for (const f of fails) console.log("  FAIL", f);
if (fails.length) process.exit(1);
