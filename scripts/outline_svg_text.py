#!/usr/bin/env python3
"""把校区底图 SVG 里的 <text> 全部转成 <path>（转曲/轮廓化）。

为什么：底图字体声明的是设计机上的 Source Han Sans（思源黑体）内部字体名，
真机没有该字体时各端回退不一致（Android 真机曾回退成衬线体，字母变"宋体"）。
转曲后文字即路径，任何设备渲染结果都与设计稿一致，与字体环境无关。

做法（针对 Adobe Illustrator 导出的结构，按需正则替换，文件其余部分保持原样）：
  - <text class="cls-n" transform="translate(x y)"><tspan x="0" y="0">…</tspan></text>
  - 从 <style> 解析每个 class 的 font-family / font-size / letter-spacing；
    font-family 含 "Medium" 用 SourceHanSansSC-Medium，否则用 Normal 字重。
  - 每个 <tspan> 生成一个 <path>，class = text 的 class + tspan 的 class，
    transform 原样保留，fill 等继承关系不变（字体类规则对 path 无效，无副作用）。
  - 不应用字体 kerning：Illustrator 排版间距已体现在 letter-spacing / tspan 定位里。

用法：
  tmp/font-venv/bin/python scripts/outline_svg_text.py 输入.svg 输出.svg
依赖：fonttools（见 tmp/font-venv），字体文件默认 ~/Library/Fonts/SourceHanSans.ttc。
"""
from __future__ import annotations

import html
import os
import re
import sys

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTCollection, TTFont

DEFAULT_FONT = os.path.expanduser("~/Library/Fonts/SourceHanSans.ttc")
SVG_NS = "http://www.w3.org/2000/svg"


def load_fonts(font_path: str) -> dict[str, TTFont]:
    """Normal/Medium 两个字重。"""
    if font_path.endswith((".ttc", ".otc")):
        coll = TTCollection(font_path, lazy=True)
        fonts = {}
        for font in coll.fonts:
            family = font["name"].getDebugName(1) or ""
            if family == "Source Han Sans SC Normal":
                fonts["normal"] = font
            elif family == "Source Han Sans SC Medium":
                fonts["medium"] = font
        if set(fonts) != {"normal", "medium"}:
            raise SystemExit(f"{font_path} 里找不到 Source Han Sans SC Normal/Medium 子字体")
        return fonts
    font = TTFont(font_path, lazy=True)
    return {"normal": font, "medium": font}


def parse_style_classes(svg: str) -> dict[str, dict[str, str]]:
    """解析 <style> 里的 class 规则：{cls: {font-family, font-size, letter-spacing}}。"""
    classes: dict[str, dict[str, str]] = {}
    for style_body in re.findall(r"<style[^>]*>(.*?)</style>", svg, re.S):
        for selectors, body in re.findall(r"([^{}]+)\{([^{}]*)\}", style_body):
            props = dict(
                (m.group(1).strip(), m.group(2).strip())
                for m in re.finditer(r"([\w-]+)\s*:\s*([^;]+);", body)
            )
            for sel in selectors.split(","):
                sel = sel.strip()
                if sel.startswith("."):
                    classes.setdefault(sel[1:], {}).update(props)
    return classes


def font_size_of(props: dict[str, str]) -> float:
    m = re.match(r"([\d.]+)px", props.get("font-size", "0"))
    if not m:
        raise ValueError(f"无法解析 font-size: {props.get('font-size')!r}")
    return float(m.group(1))


def letter_spacing_px(props: dict[str, str], font_size: float) -> float:
    m = re.match(r"(-?[\d.]+)em", props.get("letter-spacing", ""))
    return float(m.group(1)) * font_size if m else 0.0


class TextOutliner:
    def __init__(self, fonts: dict[str, TTFont]):
        self.fonts = fonts
        self.glyph_sets = {k: f.getGlyphSet() for k, f in fonts.items()}
        self.upm = {k: f["head"].unitsPerEm for k, f in fonts.items()}
        self.cmaps = {k: f.getBestCmap() for k, f in fonts.items()}
        self.hmtx = {k: f["hmtx"] for k, f in fonts.items()}
        self.missing: set[str] = set()

    def outline_run(
        self, weight: str, font_size: float, ls_px: float, x: float, y: float, text: str
    ) -> str:
        """把一行文字排成 SVG path d（text 局部坐标系，基线为 y）。"""
        scale = font_size / self.upm[weight]
        cmap, glyphs, hmtx = self.cmaps[weight], self.glyph_sets[weight], self.hmtx[weight]
        pen_x = x
        parts: list[str] = []
        for ch in text:
            gid = cmap.get(ord(ch))
            if gid is None:
                self.missing.add(ch)
                continue
            glyph = glyphs[gid]
            svg_pen = SVGPathPen(glyphs)
            # 字形坐标 y 向上、单位 UPM → 平移到落笔点，缩放并翻转为 SVG 的 y 向下。
            from fontTools.misc.transform import Transform

            tpen = TransformPen(svg_pen, Transform(scale, 0, 0, -scale, pen_x, y))
            glyph.draw(tpen)
            d = svg_pen.getCommands()
            if d:
                parts.append(d)
            pen_x += hmtx[gid][0] * scale + ls_px
        return " ".join(parts)


TEXT_RE = re.compile(r"<text\b([^>]*)>(.*?)</text>", re.S)
TSPAN_RE = re.compile(r"<tspan\b([^>]*?)(?:/>|>(.*?)</tspan>)", re.S)
ATTR_RE = re.compile(r'([\w:-]+)\s*=\s*"([^"]*)"')


def attrs_of(attr_src: str) -> dict[str, str]:
    return dict(ATTR_RE.findall(attr_src))


def convert(svg: str, outliner: TextOutliner) -> tuple[str, int]:
    classes = parse_style_classes(svg)
    count = 0

    def replace_text(m: re.Match) -> str:
        nonlocal count
        text_attrs = attrs_of(m.group(1))
        body = m.group(2)
        text_cls = text_attrs.get("class", "")
        text_props: dict[str, str] = {}
        for cls in text_cls.split():
            text_props.update(classes.get(cls, {}))
        weight = "medium" if "Medium" in text_props.get("font-family", "") else "normal"
        font_size = font_size_of(text_props)
        text_ls = letter_spacing_px(text_props, font_size)
        transform = text_attrs.get("transform", "")
        # <text x= y=> 与 transform 等价叠加（本批文件实际都用 transform）。
        base_x = float(text_attrs.get("x", "0"))
        base_y = float(text_attrs.get("y", "0"))

        paths: list[str] = []
        cursor = 0  # 追踪 tspan 之间的直接字符（本批文件没有，兜底用）
        pen_x, pen_y = base_x, base_y
        for tm in TSPAN_RE.finditer(body):
            direct = body[cursor : tm.start()].strip()
            if direct:
                d = outliner.outline_run(weight, font_size, text_ls, pen_x, pen_y, html.unescape(direct))
                if d:
                    paths.append(make_path(text_cls, "", transform, d))
            t_attrs = attrs_of(tm.group(1))
            t_cls = t_attrs.get("class", "")
            t_props = dict(text_props)
            for cls in t_cls.split():
                t_props.update(classes.get(cls, {}))
            t_weight = "medium" if "Medium" in t_props.get("font-family", "") else weight
            t_size = font_size_of(t_props) if "font-size" in t_props else font_size
            t_ls = letter_spacing_px(t_props, t_size) if "letter-spacing" in t_props else text_ls
            x = float(t_attrs.get("x", pen_x))
            y = float(t_attrs.get("y", pen_y))
            content = html.unescape(tm.group(2) or "")
            if content.strip():
                d = outliner.outline_run(t_weight, t_size, t_ls, x, y, content)
                if d:
                    paths.append(make_path(text_cls, t_cls, transform, d))
            cursor = tm.end()
        tail = body[cursor:].strip()
        if tail:
            d = outliner.outline_run(weight, font_size, text_ls, pen_x, pen_y, html.unescape(tail))
            if d:
                paths.append(make_path(text_cls, "", transform, d))
        count += 1
        return "".join(paths) if paths else ""

    def make_path(text_cls: str, tspan_cls: str, transform: str, d: str) -> str:
        cls = " ".join(c for c in (text_cls, tspan_cls) if c)
        t = f' transform="{transform}"' if transform else ""
        return f'<path class="{cls}"{t} d="{d}"/>'

    return TEXT_RE.sub(replace_text, svg), count


def main() -> None:
    if len(sys.argv) not in (3, 4):
        raise SystemExit("用法: outline_svg_text.py 输入.svg 输出.svg [字体.ttc]")
    src, dst = sys.argv[1], sys.argv[2]
    font_path = sys.argv[3] if len(sys.argv) == 4 else DEFAULT_FONT
    svg = open(src, encoding="utf-8").read()
    outliner = TextOutliner(load_fonts(font_path))
    out, n = convert(svg, outliner)
    if "<text" in out:
        raise SystemExit("转换后仍有 <text> 残留，检查未覆盖的写法")
    open(dst, "w", encoding="utf-8").write(out)
    if outliner.missing:
        print(f"警告: 字体缺字 {sorted(outliner.missing)}", file=sys.stderr)
    print(f"{src}: {n} 个 <text> 已转曲 -> {dst}")


if __name__ == "__main__":
    main()
