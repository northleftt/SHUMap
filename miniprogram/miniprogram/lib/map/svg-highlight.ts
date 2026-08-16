// Skyline 通过 <image> 渲染整张 SVG，运行时无法直接修改其中的楼宇节点。
// 这里给指定 sourceElementId 的后代图形注入覆盖样式，再由页面把产物落到
// USER_DATA_PATH，作为与底图同尺寸的临时覆盖层。

const SHAPE_TAGS = ["path", "rect", "polygon", "ellipse", "circle", "polyline", "line"] as const;
const SHAPE_TAG_SET = new Set<string>(SHAPE_TAGS);
const SVG_TAG_PATTERN = /<(\/?)([a-zA-Z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)(\/?)>/g;

export type SvgHighlightVariant = "match" | "selected";

/** CSS.escape 的小程序可用实现，确保 SVG id 含标点或数字开头时选择器仍有效。 */
function escapeCssIdentifier(value: string): string {
  const input = String(value);
  let output = "";
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    const character = input.charAt(index);
    if (code === 0) {
      output += "\uFFFD";
      continue;
    }
    if (
      (code >= 1 && code <= 31)
      || code === 127
      || (index === 0 && code >= 48 && code <= 57)
      || (index === 1 && code >= 48 && code <= 57 && input.charAt(0) === "-")
    ) {
      output += `\\${code.toString(16)} `;
      continue;
    }
    if (index === 0 && character === "-" && input.length === 1) {
      output += "\\-";
      continue;
    }
    if (
      code >= 128
      || character === "-"
      || character === "_"
      || (code >= 48 && code <= 57)
      || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
    ) {
      output += character;
      continue;
    }
    output += `\\${character}`;
  }
  return output;
}

function attribute(attrs: string, name: string): string | null {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return match ? (match[1] ?? match[2] ?? null) : null;
}

function appendInlineStyle(attrs: string, declaration: string): string {
  let found = false;
  const next = attrs.replace(
    /\bstyle\s*=\s*(["'])(.*?)\1/i,
    (_match, quote: string, current: string) => {
      found = true;
      const separator = current.trim() && !current.trim().endsWith(";") ? "; " : "";
      return `style=${quote}${current}${separator}${declaration}${quote}`;
    },
  );
  return found ? next : `${attrs} style="${declaration}"`;
}

/**
 * 微信 SVG 解码器在多选择器规则较长时可能只画出原图、忽略末尾 CSS。同步给目标
 * 图形写 inline style，保证 Skyline <image> 的实际像素发生变化；末尾 CSS 仍保留，
 * 用于和网页端选择器语义一致及覆盖少见的 SVG 解析边界。
 */
function applyInlineHighlight(svgRaw: string, ids: ReadonlySet<string>, declaration: string): string {
  const groupStack: Array<string | null> = [];
  return svgRaw.replace(
    SVG_TAG_PATTERN,
    (raw, slash: string, rawTag: string, attrs: string, selfClosing: string) => {
      const tag = rawTag.toLowerCase();
      const isSelfClosing = Boolean(selfClosing) || /\/\s*$/.test(attrs);
      if (tag === "g") {
        if (slash) groupStack.pop();
        else if (!isSelfClosing) groupStack.push(attribute(attrs, "id"));
        return raw;
      }
      if (slash || !SHAPE_TAG_SET.has(tag)) return raw;
      const ownId = attribute(attrs, "id");
      const matched = Boolean(ownId && ids.has(ownId))
        || groupStack.some((groupId) => Boolean(groupId && ids.has(groupId)));
      if (!matched) return raw;
      const normalizedAttrs = isSelfClosing ? attrs.replace(/\/\s*$/, "") : attrs;
      const nextAttrs = appendInlineStyle(normalizedAttrs, declaration);
      return `<${rawTag}${nextAttrs}${isSelfClosing ? "/" : ""}>`;
    },
  );
}

/**
 * 在 SVG 根节点闭合前追加楼宇高亮样式。
 *
 * match 数值逐项对齐网页端 MapCanvas 的 g[data-match="true"]：
 * rgba(215, 232, 243, 0.95) / #1e80c1 / 1.8。
 * selected 对齐 g[data-selected="true"]：同色不透明填充 / 3px 描边。
 */
export function injectSvgHighlight(
  svgRaw: string,
  sourceElementIds: readonly string[],
  variant: SvgHighlightVariant,
): string | null {
  const ids = [...new Set(sourceElementIds.filter((value) => value.trim()))].sort();
  if (ids.length === 0) return null;
  const closing = svgRaw.lastIndexOf("</svg>");
  if (closing < 0) throw new Error("SVG document has no closing root element");

  const selectors = ids.flatMap((sourceElementId) => {
    const id = escapeCssIdentifier(sourceElementId);
    return SHAPE_TAGS.map((tag) => `#${id} ${tag}`);
  });
  const fill = variant === "match"
    ? "rgba(215, 232, 243, 0.95)"
    : "rgba(215, 232, 243, 1)";
  const strokeWidth = variant === "match" ? "1.8" : "3";
  const declaration =
    `fill: ${fill} !important; stroke: #1e80c1 !important; stroke-width: ${strokeWidth} !important;`;
  const inlineSvg = applyInlineHighlight(svgRaw, new Set(ids), declaration);
  const style =
    `<style>${selectors.join(", ")} { ${declaration} }</style>`;
  const inlineClosing = inlineSvg.lastIndexOf("</svg>");
  return `${inlineSvg.slice(0, inlineClosing)}${style}${inlineSvg.slice(inlineClosing)}`;
}
