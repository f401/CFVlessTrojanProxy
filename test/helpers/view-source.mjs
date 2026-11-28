import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { expandHtml } = require('../../tools/view-assets.cjs');

/** 页面断言读构建时的真实内容，不依赖 CSS/JS 是否内嵌。 */
export const readView = file => expandHtml(file);

/**
 * 职责拆分后同时检查路由和视图，避免历史源码锁逼迫实现合回单文件。
 * 2026-11-28：面板控制器与展示缓存搬到了 `src/routes/region-panel.ts`，
 * 这里把新文件一并读进来 —— 源码锁该锁「行为在哪」，不该锁「必须写在哪个文件」。
 */
export const regionsSource = () => [
  'src/routes/tools.ts',
  'src/routes/region-panel.ts',
  // 数据装配在 route 层读模型里，源码锁要跟着看
  'src/route/read-models.ts',
  'src/views/regions.ts',
].map(file => fs.readFileSync(file, 'utf8')).join('\n');

/**
 * 调试端点的源码锁要跟着「只读表搬进 route 层读模型」走：
 * 分支的实现现在在 `src/route/read-models.ts`，`src/routes/debug.ts` 只剩编排与写操作。
 */
export const debugSource = () => [
  'src/routes/debug.ts',
  'src/route/read-models.ts',
].map(file => fs.readFileSync(file, 'utf8')).join('\n');
