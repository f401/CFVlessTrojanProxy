/**
 * 构建期由 esbuild 的 text loader 把 .html 模板读成字符串。
 * 模板里的占位符是 `{{name}}`，运行期由 `renderTemplate` 替换。
 */
declare module "*.html" {
  const template: string;
  export default template;
}
