// 删掉文件里"导入了但没用到"的具名符号
const fs = require("fs");
const target = process.argv[2];
let s = fs.readFileSync(target, "utf8");
const body = s.replace(/^import[\s\S]*?;$/gm, "");
let removed = [];
s = s.replace(/^import \{([^}]*)\} from "([^"]+)";$/gm, (all, names, spec) => {
  const keep = names.split(",").map((x) => x.trim()).filter(Boolean).filter((n) => {
    const id = n.split(/\s+as\s+/).pop();
    const used = new RegExp("\\b" + id.replace(/\$/g, "\\$") + "\\b").test(body);
    if (!used) removed.push(id);
    return used;
  });
  if (!keep.length) return "";
  return `import { ${keep.join(", ")} } from "${spec}";`;
});
s = s.replace(/\n{3,}/g, "\n\n");
fs.writeFileSync(target, s);
console.log(target, "removed:", removed.join(", ") || "-");
