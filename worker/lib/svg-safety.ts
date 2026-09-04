import { HttpError } from "./http";

/**
 * SVG 消毒。原本长在 worker/modules/guide.ts 里（指南图示的上传通道），
 * 设施图标上传（modules/facility-icons.ts）需要同一份判定，所以搬到这里共用。
 *
 * 不复制一份的理由：这是安全边界。两份实现必然漂移，而漂移的那一份就是缺口 ——
 * 补了指南侧忘了图标侧，等于图标侧没有防护。
 *
 * 拒绝式校验，不做剥离。
 *
 * 为什么拒绝而不是剥离：剥离要枚举所有危险构造并正确改写，漏一个就等于放行；
 * 拒绝只要求「命中任一危险构造就整份不收」，且能给上传者明确反馈去改源文件。
 * 指南图示由我们自己从原稿导出，本来就不该含脚本 —— 命中即说明导出流程有问题。
 *
 * 覆盖的构造（都在真实 SVG XSS 里出现过）：
 *   <script>            直接执行
 *   on* 属性            onload/onclick/onbegin…
 *   javascript: / data: 在 href/xlink:href 里执行或注入
 *   <foreignObject>     嵌 HTML，可带 <script>
 *   <iframe/embed/object>  嵌外部文档
 *   <use href="外部">    引用外部文档的片段
 *   <!ENTITY>           XXE / 十亿笑声
 *   <handler>/<set attributeName="on…">  SMIL 事件
 */
export function assertSafeSvg(text: string): void {
  const lower = text.toLowerCase();

  // 先剥掉注释再查：<!-- <script> --> 是无害的，但注释里藏 ENTITY 不是。
  // 所以 ENTITY 与 DOCTYPE 在剥注释之前查。
  if (/<!doctype/.test(lower) || /<!entity/.test(lower)) {
    throw new HttpError(
      400,
      "unsafe_svg",
      "SVG must not declare a DOCTYPE or entities (XXE risk). Export without a DTD.",
    );
  }

  const stripped = lower.replace(/<!--[\s\S]*?-->/g, "");

  const checks: Array<[RegExp, string]> = [
    [/<script[\s>]/, "contains <script>"],
    [/<iframe[\s>]/, "contains <iframe>"],
    [/<embed[\s>]/, "contains <embed>"],
    [/<object[\s>]/, "contains <object>"],
    [/<foreignobject[\s>]/, "contains <foreignObject>"],
    [/<handler[\s>]/, "contains SMIL <handler>"],
    // on* 事件属性：要求前面是空白，避免误伤 font-variant 之类含 "on" 的属性名
    [/\son[a-z]+\s*=/, "contains an on* event attribute"],
    [/javascript\s*:/, "contains a javascript: URL"],
    // <set attributeName="onload" …>
    [/attributename\s*=\s*["']?\s*on[a-z]/, "targets an event attribute via SMIL"],
  ];

  for (const [pattern, reason] of checks) {
    if (pattern.test(stripped)) {
      throw new HttpError(400, "unsafe_svg", `SVG rejected: ${reason}. Re-export the figure without scripting.`);
    }
  }

  /* href 逐个查。三类判定：
   *
   *   data:image/png|jpeg|gif|webp  放行 —— 原稿图示的路网底图就是这样内嵌的
   *     （<image xlink:href="data:image/png;base64,…">，一张图占其 87% 体积）。
   *     位图不可执行，内嵌反而比外链安全：不产生任何出站请求。
   *   其它 data:                    拒绝 —— 尤其 text/html 与 image/svg+xml，
   *     前者可导航到脚本，后者是能带脚本的嵌套 SVG。
   *   //host 或 scheme://           拒绝 —— 外部文档引用，会泄露访问者 IP，
   *     且目标内容不在我们控制下。
   *
   * 允许 #fragment 与同源相对路径：clipPath/mask/use 靠 #id 互相引用，
   * 拦掉的话原稿图形直接散架。
   */
  const RASTER_DATA_URI = /^data:image\/(?:png|jpe?g|gif|webp)\s*;\s*base64\s*,/;
  const hrefs = stripped.match(/(?:xlink:)?href\s*=\s*["'][^"']*["']/g) ?? [];
  for (const raw of hrefs) {
    const value = raw.slice(raw.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "").trim();
    if (/^data:/.test(value)) {
      if (!RASTER_DATA_URI.test(value)) {
        throw new HttpError(
          400,
          "unsafe_svg",
          "SVG rejected: only base64 raster data URIs (png/jpeg/gif/webp) may be embedded; " +
          "text/html and nested image/svg+xml are not allowed.",
        );
      }
      continue;
    }
    if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//.test(value)) {
      throw new HttpError(
        400,
        "unsafe_svg",
        "SVG rejected: references an external document. Embed the artwork instead of linking to it.",
      );
    }
  }

  if (!/<svg[\s>]/.test(stripped)) {
    throw new HttpError(400, "validation_error", "Body does not look like an SVG document");
  }
}
