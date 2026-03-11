#!/usr/bin/env python3

import argparse
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = ROOT / "data" / "campus-buildings.json"
DEFAULT_OUTPUT = ROOT / "data" / "campus-buildings.geocoded.json"
AMAP_GEOCODE_URL = "https://restapi.amap.com/v3/geocode/geo"
ENV_FILES = (
    ROOT / ".env.local",
    ROOT / "AMAP_API_KEY.env.local",
)

AMAP_CITY_CONFIG = {
    "宝山校区": {
        "province": "上海市",
        "district": "宝山区",
        "campus_name": "上海大学宝山校区",
        "street_address": "上大路99号",
        "citycode": "310113",
    },
    "延长校区": {
        "province": "上海市",
        "district": "静安区",
        "campus_name": "上海大学延长校区",
        "street_address": "延长路149号",
        "citycode": "310106",
    },
    "嘉定校区": {
        "province": "上海市",
        "district": "嘉定区",
        "campus_name": "上海大学嘉定校区",
        "street_address": "城中路20号",
        "citycode": "310114",
    },
}


def load_api_key_from_env_files() -> str | None:
    for path in ENV_FILES:
        if not path.exists():
            continue

        content = path.read_text(encoding="utf-8").strip()
        if not content or content.startswith("{\\rtf"):
            continue

        for line in content.splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if stripped.startswith("export "):
                stripped = stripped[len("export ") :].strip()
            if stripped.startswith("AMAP_API_KEY="):
                return stripped.split("=", 1)[1].strip().strip("\"'")
            if stripped.startswith("AMAP_WEB_SERVICE_KEY="):
                return stripped.split("=", 1)[1].strip().strip("\"'")

        if "=" not in content and "\n" not in content:
            return content.strip().strip("\"'")

    return None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Use AMap geocoding to enrich campus building JSON with coordinates."
    )
    parser.add_argument(
        "--input",
        type=Path,
        default=DEFAULT_INPUT,
        help=f"Input JSON path. Defaults to {DEFAULT_INPUT}",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"Output JSON path. Defaults to {DEFAULT_OUTPUT}",
    )
    parser.add_argument(
        "--api-key",
        default=(
            os.environ.get("AMAP_API_KEY")
            or os.environ.get("AMAP_WEB_SERVICE_KEY")
            or load_api_key_from_env_files()
        ),
        help="AMap Web Service API key. Falls back to AMAP_API_KEY or AMAP_WEB_SERVICE_KEY.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=8.0,
        help="HTTP timeout in seconds. Defaults to 8.",
    )
    parser.add_argument(
        "--sleep",
        type=float,
        default=0.2,
        help="Delay between requests in seconds. Defaults to 0.2.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Only process the first N items. Defaults to 0 for all.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite existing navigation coordinates instead of skipping them.",
    )
    parser.add_argument(
        "--in-place",
        action="store_true",
        help="Write the enriched result back to the input file.",
    )
    parser.add_argument(
        "--insecure",
        action="store_true",
        help="Disable SSL certificate verification for local debugging.",
    )
    return parser.parse_args()


def normalize_name(name: str) -> str:
    return re.sub(r"\s+", "", name).strip()


def build_query(item: dict) -> tuple[str, str]:
    campus = item["campus"]
    if campus not in AMAP_CITY_CONFIG:
        raise KeyError(f"Unsupported campus: {campus}")

    campus_config = AMAP_CITY_CONFIG[campus]
    normalized_name = normalize_name(item["name"])
    address = (
        f"{campus_config['province']}{campus_config['district']}"
        f"{campus_config['street_address']} {campus_config['campus_name']} {normalized_name}"
    )
    return address, campus_config["citycode"]


def fetch_geocode(
    api_key: str,
    address: str,
    citycode: str,
    timeout: float,
    insecure: bool,
) -> dict:
    params = urllib.parse.urlencode(
        {
            "key": api_key,
            "address": address,
            "city": citycode,
            "output": "JSON",
        }
    )
    url = f"{AMAP_GEOCODE_URL}?{params}"

    context = ssl._create_unverified_context() if insecure else None
    with urllib.request.urlopen(url, timeout=timeout, context=context) as response:
        payload = response.read().decode("utf-8")
    return json.loads(payload)


def needs_geocode(item: dict, overwrite: bool) -> bool:
    if overwrite:
        return True

    navigation = item.get("navigation")
    if not isinstance(navigation, dict):
        return True

    longitude = navigation.get("longitude")
    latitude = navigation.get("latitude")
    return longitude in (None, "") or latitude in (None, "")


def update_item(item: dict, response: dict, address: str, citycode: str) -> dict:
    geocodes = response.get("geocodes") or []
    top_result = geocodes[0] if geocodes else {}
    location = top_result.get("location", "")
    longitude = None
    latitude = None
    if "," in location:
        lng_str, lat_str = location.split(",", 1)
        longitude = float(lng_str)
        latitude = float(lat_str)

    status = "success" if longitude is not None and latitude is not None else "no_result"
    navigation = dict(item.get("navigation") or {})
    navigation.update(
        {
            "coordSystem": "gcj02",
            "longitude": longitude,
            "latitude": latitude,
            "address": address,
            "mapDisplayName": f"{AMAP_CITY_CONFIG[item['campus']]['campus_name']} {normalize_name(item['name'])}",
            "cityCode": citycode,
            "geocodeLevel": top_result.get("level"),
            "formattedAddress": top_result.get("formatted_address"),
            "source": "amap-geocode",
            "verified": False,
            "geocodeStatus": status,
            "geocodeError": None,
        }
    )
    item["navigation"] = navigation
    return item


def main() -> int:
    args = parse_args()

    if not args.api_key:
        print("Missing AMap API key. Set --api-key or AMAP_API_KEY.", file=sys.stderr)
        return 1

    input_path = args.input.resolve()
    output_path = input_path if args.in_place else args.output.resolve()

    items = json.loads(input_path.read_text(encoding="utf-8"))
    if not isinstance(items, list):
        print("Input JSON must be an array.", file=sys.stderr)
        return 1

    processed = 0
    success = 0
    skipped = 0
    failures = 0
    cache: dict[tuple[str, str], dict] = {}

    for item in items:
        if args.limit and processed >= args.limit:
            break

        if not needs_geocode(item, args.overwrite):
            skipped += 1
            continue

        address = None
        citycode = None
        try:
            address, citycode = build_query(item)
            cache_key = (address, citycode)
            if cache_key not in cache:
                cache[cache_key] = fetch_geocode(
                    args.api_key,
                    address,
                    citycode,
                    args.timeout,
                    args.insecure,
                )
                if args.sleep > 0:
                    time.sleep(args.sleep)
            response = cache[cache_key]
            if response.get("status") != "1":
                raise RuntimeError(response.get("info") or "Unknown AMap API error")
            update_item(item, response, address, citycode)
            if item["navigation"]["geocodeStatus"] == "success":
                success += 1
            else:
                failures += 1
            processed += 1
            print(
                f"[{processed}] {item['campus']} / {item['name']} -> "
                f"{item['navigation']['longitude']},{item['navigation']['latitude']} "
                f"({item['navigation']['geocodeLevel']})"
            )
        except (urllib.error.URLError, TimeoutError, RuntimeError, ValueError, KeyError) as exc:
            failures += 1
            processed += 1
            navigation = dict(item.get("navigation") or {})
            navigation.update(
                {
                    "coordSystem": "gcj02",
                    "longitude": None,
                    "latitude": None,
                    "address": address,
                    "mapDisplayName": f"{item.get('campus', '')} {normalize_name(item.get('name', ''))}".strip(),
                    "cityCode": citycode,
                    "source": "amap-geocode",
                    "verified": False,
                    "geocodeStatus": "error",
                    "geocodeError": str(exc),
                }
            )
            item["navigation"] = navigation
            print(
                f"[{processed}] Failed: {item.get('campus')} / {item.get('name')} -> {exc}",
                file=sys.stderr,
            )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(items, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(
        f"Finished. success={success} failures={failures} skipped={skipped} output={output_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
