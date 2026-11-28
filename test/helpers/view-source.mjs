import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { expandHtml } = require('../../tools/view-assets.cjs');

/** 页面断言读构建时的真实内容，不依赖 CSS/JS 是否内嵌。 */
export const readView = file => expandHtml(file);

/** 职责拆分后同时检查路由和视图，避免历史源码锁逼迫实现合回单文件。 */
export const regionsSource = () => ['src/routes/tools.ts', 'src/views/regions.ts']
  .map(file => fs.readFileSync(file, 'utf8')).join('\n');
