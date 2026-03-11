#!/usr/bin/env python3

import json
import xml.etree.ElementTree as ET
from pathlib import Path


SVG_NS = "{http://www.w3.org/2000/svg}"

ROOT = Path(__file__).resolve().parents[1]
SVG_FILES = [
    ("地图/宝山本部地图.svg", "宝山校区"),
    ("地图/延长校区地图.svg", "延长校区"),
    ("地图/嘉定校区地图.svg", "嘉定校区"),
]
OUTPUT = ROOT / "data" / "campus-buildings.json"

OTHER_IDS = {
    "GYM",
    "swimming_pool",
    "hospital",
    "communication_center",
    "xingjian_center",
}

OTHER_NAME_KEYWORDS = (
    "体育馆",
    "游泳馆",
    "校医院",
    "文体中心",
    "交流展示中心",
)


def collect_texts(element: ET.Element) -> list[str]:
    texts: list[str] = []
    for text_node in element.iter(f"{SVG_NS}text"):
        text = "".join(text_node.itertext()).strip()
        if text:
            texts.append(text)
    return texts


def classify(svg_element_id: str, name: str) -> str:
    if svg_element_id.startswith("dorm_"):
        return "dorm"
    if "canteen" in svg_element_id or "食堂" in name:
        return "canteen"
    if "library" in svg_element_id or "图书馆" in name:
        return "library"
    if svg_element_id in OTHER_IDS or any(keyword in name for keyword in OTHER_NAME_KEYWORDS):
        return "other"
    if svg_element_id.startswith("building_"):
        return "building"
    if any(keyword in name for keyword in ("教学楼", "学院", "大楼")):
        return "building"
    if name.endswith("楼"):
        return "building"
    return "other"


def extract_entries(svg_path: Path, campus: str) -> list[dict[str, str]]:
    root = ET.parse(svg_path).getroot()
    entries: list[dict[str, str]] = []

    for element in root.iter():
        svg_element_id = element.attrib.get("id")
        if not svg_element_id or svg_element_id == "Layer_1":
            continue

        texts = collect_texts(element)
        if not texts:
            continue

        name = " ".join(texts)
        entries.append(
            {
                "svgElementId": svg_element_id,
                "name": name,
                "campus": campus,
                "category": classify(svg_element_id, name),
            }
        )

    return entries


def main() -> None:
    all_entries: list[dict[str, str]] = []

    for relative_path, campus in SVG_FILES:
        svg_path = ROOT / relative_path
        all_entries.extend(extract_entries(svg_path, campus))

    OUTPUT.write_text(
        json.dumps(all_entries, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(all_entries)} entries to {OUTPUT}")


if __name__ == "__main__":
    main()
