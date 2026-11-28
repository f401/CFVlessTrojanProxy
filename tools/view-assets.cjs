// 页面资源只在构建时展开；运行时仍交付单个 HTML，不增加请求或放宽 CSP。
const fs = require('node:fs');
const path = require('node:path');

/** 展开 views 内的静态资源；拒绝越界、未知后缀与递归包含。 */
function expandHtml(file, viewsRoot = path.resolve(__dirname, '../src/views')) {
  const absolute = path.resolve(file);
  const source = fs.readFileSync(absolute, 'utf8');
  return source.replace(/<!-- @include ([\w./-]+) -->/g, (_, name) => {
    const target = path.resolve(path.dirname(absolute), name);
    const relative = path.relative(viewsRoot, target);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !/\.(css|js)$/.test(target)) {
      throw new Error(`Invalid view asset: ${name}`);
    }
    const text = fs.readFileSync(target, 'utf8');
    if (/<!-- @include|<\/(?:script|style)/i.test(text)) throw new Error(`Unsafe view asset: ${name}`);
    return text;
  });
}

/** 同一展开器用于生产包、测试包与页面测试，避免测试旧资源。 */
const viewAssetsPlugin = {
  name: 'view-assets',
  setup(build) {
    build.onLoad({ filter: /\.html$/ }, args => ({ contents: expandHtml(args.path), loader: 'text' }));
  },
};
module.exports = { expandHtml, viewAssetsPlugin };
