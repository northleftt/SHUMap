#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_INPUT = path.join(ROOT, "data", "campus-buildings.json");
const DEFAULT_OUTPUT = path.join(ROOT, "data", "campus-buildings.picked.json");
const DEFAULT_SITE_URL = "https://www.opengps.cn/map/tools/pickupgps_amap.aspx";
const SYSTEM_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CAMPUS_METADATA = {
  "宝山校区": {
    province: "上海市",
    district: "宝山区",
    streetAddress: "上大路99号",
    campusName: "上海大学宝山校区",
  },
  "延长校区": {
    province: "上海市",
    district: "静安区",
    streetAddress: "延长路149号",
    campusName: "上海大学延长校区",
  },
  "嘉定校区": {
    province: "上海市",
    district: "嘉定区",
    streetAddress: "城中路20号",
    campusName: "上海大学嘉定校区",
  },
};
const CAMPUS_QUERY_PREFIX = {
  "宝山校区": "上海大学宝山校区",
  "延长校区": "上海大学延长校区",
  "嘉定校区": "上海大学嘉定校区",
};

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    siteUrl: DEFAULT_SITE_URL,
    campus: null,
    startFrom: null,
    overwrite: false,
    onlyMissing: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") {
      args.input = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === "--output") {
      args.output = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === "--site-url") {
      args.siteUrl = argv[i + 1];
      i += 1;
    } else if (arg === "--campus") {
      args.campus = argv[i + 1];
      i += 1;
    } else if (arg === "--start-from") {
      args.startFrom = argv[i + 1];
      i += 1;
    } else if (arg === "--overwrite") {
      args.overwrite = true;
    } else if (arg === "--all") {
      args.onlyMissing = false;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/pick_coords_playwright.js [options]

Options:
  --input <path>       Input JSON file. Default: ${DEFAULT_INPUT}
  --output <path>      Output JSON file. Default: ${DEFAULT_OUTPUT}
  --site-url <url>     Coordinate picker page. Default: ${DEFAULT_SITE_URL}
  --campus <name>      Only process one campus.
  --start-from <text>  Start from the first building whose name or svgElementId contains the text.
  --overwrite          Re-pick items even if they already have coordinates.
  --all                Process all records instead of only missing coordinates.
  --help               Show this help message.
`);
}

function normalizeName(name) {
  return String(name || "").replace(/\s+/g, "").trim();
}

function hasCoordinates(item) {
  const navigation = item && item.navigation;
  return Boolean(
    navigation &&
      navigation.longitude !== null &&
      navigation.longitude !== undefined &&
      navigation.latitude !== null &&
      navigation.latitude !== undefined
  );
}

function buildQuery(item) {
  const prefix = CAMPUS_QUERY_PREFIX[item.campus] || item.campus || "上海大学";
  return `${prefix} ${normalizeName(item.name)}`.trim();
}

function buildAddress(item) {
  const campusMeta = CAMPUS_METADATA[item.campus];
  const normalizedName = normalizeName(item.name);
  if (!campusMeta) {
    return `${item.campus || "上海大学"} ${normalizedName}`.trim();
  }
  return `${campusMeta.province}${campusMeta.district}${campusMeta.streetAddress} ${campusMeta.campusName} ${normalizedName}`;
}

function buildMapDisplayName(item) {
  const campusMeta = CAMPUS_METADATA[item.campus];
  const normalizedName = normalizeName(item.name);
  if (!campusMeta) {
    return `${item.campus || "上海大学"} ${normalizedName}`.trim();
  }
  return `${campusMeta.campusName} ${normalizedName}`;
}

function loadItems(inputPath, outputPath) {
  const sourcePath = fs.existsSync(outputPath) ? outputPath : inputPath;
  const raw = fs.readFileSync(sourcePath, "utf8");
  const items = JSON.parse(raw);
  if (!Array.isArray(items)) {
    throw new Error(`Expected an array in ${sourcePath}`);
  }
  return { items, sourcePath };
}

function matchesStartFrom(item, startFrom) {
  if (!startFrom) {
    return true;
  }
  const needle = startFrom.toLowerCase();
  return (
    String(item.name || "").toLowerCase().includes(needle) ||
    String(item.svgElementId || "").toLowerCase().includes(needle)
  );
}

function buildQueue(items, args) {
  const queue = [];
  let started = !args.startFrom;

  items.forEach((item, index) => {
    if (args.campus && item.campus !== args.campus) {
      return;
    }

    if (!started && matchesStartFrom(item, args.startFrom)) {
      started = true;
    }

    if (!started) {
      return;
    }

    if (!args.overwrite && args.onlyMissing && hasCoordinates(item)) {
      return;
    }

    queue.push(index);
  });

  return queue;
}

async function saveJson(outputPath, items) {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(outputPath, `${JSON.stringify(items, null, 2)}\n`, "utf8");
}

function formatCoordinate(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "未识别";
  }
  return String(value);
}

function buildOverlayState(item, position, total) {
  return {
    position,
    total,
    campus: item.campus,
    name: item.name,
    svgElementId: item.svgElementId,
    category: item.category,
    query: buildQuery(item),
    existingLongitude: item.navigation?.longitude ?? null,
    existingLatitude: item.navigation?.latitude ?? null,
  };
}

async function installOverlay(page) {
  await page.evaluate(() => {
    const existing = document.getElementById("shumap-overlay-root");
    if (existing) {
      existing.remove();
    }

    const style = document.createElement("style");
    style.id = "shumap-overlay-style";
    style.textContent = `
      #shumap-overlay-root {
        position: fixed;
        top: 16px;
        right: 16px;
        width: 340px;
        max-height: calc(100vh - 32px);
        overflow: auto;
        z-index: 999999;
        background: rgba(255, 255, 255, 0.96);
        border: 1px solid rgba(30, 41, 59, 0.18);
        border-radius: 16px;
        box-shadow: 0 18px 45px rgba(15, 23, 42, 0.18);
        padding: 16px;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;
        color: #0f172a;
      }
      #shumap-overlay-root h1 {
        font-size: 18px;
        margin: 0 0 10px;
      }
      #shumap-overlay-root .shumap-muted {
        color: #475569;
        font-size: 12px;
        line-height: 1.45;
      }
      #shumap-overlay-root .shumap-card {
        margin-top: 12px;
        padding: 12px;
        border-radius: 12px;
        background: #f8fafc;
        border: 1px solid #e2e8f0;
      }
      #shumap-overlay-root .shumap-label {
        font-size: 12px;
        color: #64748b;
        margin-bottom: 4px;
      }
      #shumap-overlay-root .shumap-value {
        font-size: 14px;
        word-break: break-word;
      }
      #shumap-overlay-root .shumap-query {
        display: flex;
        gap: 8px;
        align-items: stretch;
        margin-top: 10px;
      }
      #shumap-overlay-root .shumap-query textarea,
      #shumap-overlay-root .shumap-manual input {
        width: 100%;
        border: 1px solid #cbd5e1;
        border-radius: 10px;
        padding: 10px;
        font-size: 13px;
        resize: vertical;
        box-sizing: border-box;
        background: #fff;
      }
      #shumap-overlay-root button {
        border: none;
        border-radius: 10px;
        padding: 10px 12px;
        background: #0f766e;
        color: #fff;
        cursor: pointer;
        font-size: 13px;
      }
      #shumap-overlay-root button.shumap-secondary {
        background: #e2e8f0;
        color: #0f172a;
      }
      #shumap-overlay-root button.shumap-danger {
        background: #b91c1c;
      }
      #shumap-overlay-root .shumap-row {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 10px;
      }
      #shumap-overlay-root .shumap-row > * {
        flex: 1 1 0;
      }
      #shumap-overlay-root .shumap-manual {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-top: 10px;
      }
      #shumap-overlay-root .shumap-preview {
        margin-top: 10px;
        padding: 10px;
        border-radius: 10px;
        background: #ecfeff;
        border: 1px solid #a5f3fc;
        font-size: 13px;
      }
      #shumap-overlay-root .shumap-shortcuts {
        margin-top: 10px;
        line-height: 1.55;
      }
    `;

    document.head.appendChild(style);

    const root = document.createElement("aside");
    root.id = "shumap-overlay-root";
    root.innerHTML = `
      <h1>SHUMap 半自动标点</h1>
      <div class="shumap-muted">先点击地图主入口，再在这里保存。快捷键：<strong>F</strong> 填搜索词，<strong>R</strong> 刷新识别，<strong>S</strong> 保存，<strong>K</strong> 跳过，<strong>J</strong> 上一条。</div>
      <div class="shumap-card">
        <div class="shumap-label">进度</div>
        <div class="shumap-value" id="shumap-progress"></div>
        <div class="shumap-label" style="margin-top: 10px;">建筑</div>
        <div class="shumap-value" id="shumap-name"></div>
        <div class="shumap-muted" id="shumap-meta"></div>
      </div>
      <div class="shumap-card">
        <div class="shumap-label">搜索词</div>
        <div class="shumap-query">
          <textarea rows="2" id="shumap-query"></textarea>
        </div>
        <div class="shumap-row">
          <button id="shumap-fill">自动填写搜索词</button>
          <button class="shumap-secondary" id="shumap-refresh">刷新识别坐标</button>
        </div>
      </div>
      <div class="shumap-card">
        <div class="shumap-label">识别到的当前坐标</div>
        <div class="shumap-preview" id="shumap-preview">尚未识别，请点地图后点击“刷新识别坐标”。</div>
        <div class="shumap-manual">
          <input id="shumap-manual-lng" placeholder="手动输入经度" />
          <input id="shumap-manual-lat" placeholder="手动输入纬度" />
        </div>
        <div class="shumap-row">
          <button id="shumap-save">保存当前坐标</button>
          <button class="shumap-secondary" id="shumap-save-manual">保存手动坐标</button>
        </div>
        <div class="shumap-row">
          <button class="shumap-secondary" id="shumap-prev">上一条</button>
          <button class="shumap-danger" id="shumap-skip">跳过</button>
        </div>
      </div>
      <div class="shumap-shortcuts shumap-muted" id="shumap-status"></div>
    `;

    document.body.appendChild(root);

    const parseCoordText = (text) => {
      if (!text) {
        return null;
      }
      const cleaned = String(text).replace(/\n/g, " ").replace(/\s+/g, " ");
      const regex = /([0-9]{2,3}\.[0-9]+)\s*[,， ]\s*([0-9]{1,2}\.[0-9]+)/g;
      let match;
      while ((match = regex.exec(cleaned)) !== null) {
        const lng = Number(match[1]);
        const lat = Number(match[2]);
        if (lng >= 70 && lng <= 140 && lat >= 0 && lat <= 60) {
          return { longitude: lng, latitude: lat, raw: match[0] };
        }
      }
      return null;
    };

    const isVisible = (element) => {
      if (!element || !(element instanceof HTMLElement)) {
        return false;
      }
      const styleValue = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        styleValue.display !== "none" &&
        styleValue.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const textOf = (element) => {
      if (!element) {
        return "";
      }
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        return element.value || "";
      }
      return element.textContent || "";
    };

    const findByKeywords = () => {
      const keywords = ["鼠标点击坐标", "点击坐标", "点选坐标", "拾取坐标", "经纬度"];
      const candidates = [];
      const nodes = Array.from(document.querySelectorAll("body *")).filter(isVisible);
      for (const node of nodes) {
        const ownText = (node.textContent || "").trim();
        if (!ownText) {
          continue;
        }
        if (!keywords.some((keyword) => ownText.includes(keyword))) {
          continue;
        }
        const scope = node.closest("tr, td, th, div, section, form") || node.parentElement || node;
        const descendants = [scope, ...scope.querySelectorAll("input, textarea, span, div, td, p")];
        for (const descendant of descendants) {
          const parsed = parseCoordText(textOf(descendant));
          if (parsed) {
            candidates.push({ ...parsed, source: "keyword-scope" });
          }
        }
      }
      return candidates;
    };

    const findGeneric = () => {
      const candidates = [];
      const descendants = Array.from(
        document.querySelectorAll("input, textarea, span, div, td, p")
      ).filter(isVisible);
      for (const descendant of descendants) {
        const parsed = parseCoordText(textOf(descendant));
        if (parsed) {
          candidates.push({ ...parsed, source: "generic" });
        }
      }
      return candidates;
    };

    const dedupe = (items) => {
      const seen = new Set();
      return items.filter((item) => {
        const key = `${item.longitude},${item.latitude}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
    };

    const detectCoordinate = () => {
      const priority = dedupe(findByKeywords());
      if (priority.length > 0) {
        return priority[0];
      }
      const generic = dedupe(findGeneric());
      return generic[0] || null;
    };

    const guessSearchInput = () => {
      const fields = Array.from(
        document.querySelectorAll("input[type='text'], input[type='search'], textarea")
      ).filter((element) => isVisible(element) && !element.closest("#shumap-overlay-root"));

      const preferred = fields.find((field) => {
        const haystack = [
          field.id,
          field.name,
          field.placeholder,
          field.title,
          field.getAttribute("aria-label"),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return ["搜索", "关键字", "keyword", "poi", "名称", "地址"].some((keyword) =>
          haystack.includes(keyword.toLowerCase())
        );
      });

      return preferred || fields[0] || null;
    };

    const clickSearchButton = () => {
      const buttons = Array.from(document.querySelectorAll("button, input[type='button'], a"))
        .filter(isVisible)
        .filter((element) => !element.closest("#shumap-overlay-root"));
      const target = buttons.find((button) => {
        const text = (button.textContent || button.value || "").trim();
        return ["搜索", "查询", "定位", "查找"].some((keyword) => text.includes(keyword));
      });
      if (target) {
        target.click();
      }
    };

    window.__SHUMAP_STATE = {};
    window.__SHUMAP_detectCoordinate = detectCoordinate;
    window.__SHUMAP_autofillSearch = () => {
      const query = document.getElementById("shumap-query").value.trim();
      const field = guessSearchInput();
      if (!field) {
        document.getElementById("shumap-status").textContent = "没有识别到站内搜索框，请手动搜索。";
        return;
      }
      field.focus();
      field.value = query;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      field.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
      clickSearchButton();
      document.getElementById("shumap-status").textContent = `已尝试填入搜索词：${query}`;
    };

    window.__SHUMAP_refreshPreview = () => {
      const preview = document.getElementById("shumap-preview");
      const coord = detectCoordinate();
      if (!coord) {
        preview.textContent = "尚未识别到经纬度，请先在地图上点击目标点，或手动填写。";
        return null;
      }
      preview.textContent = `经度 ${coord.longitude} / 纬度 ${coord.latitude}（来源：${coord.source}）`;
      document.getElementById("shumap-manual-lng").value = String(coord.longitude);
      document.getElementById("shumap-manual-lat").value = String(coord.latitude);
      return coord;
    };

    window.__SHUMAP_setState = (state) => {
      window.__SHUMAP_STATE = state;
      document.getElementById("shumap-progress").textContent = `${state.position} / ${state.total}`;
      document.getElementById("shumap-name").textContent = state.name;
      document.getElementById("shumap-meta").textContent = `${state.campus} · ${state.category} · ${state.svgElementId}`;
      document.getElementById("shumap-query").value = state.query || "";
      document.getElementById("shumap-status").textContent =
        `已有坐标：${state.existingLongitude ?? "无"}, ${state.existingLatitude ?? "无"}`;
      window.__SHUMAP_refreshPreview();
    };

    document.getElementById("shumap-fill").addEventListener("click", () => {
      window.__SHUMAP_autofillSearch();
    });

    document.getElementById("shumap-refresh").addEventListener("click", () => {
      window.__SHUMAP_refreshPreview();
    });

    document.getElementById("shumap-save").addEventListener("click", async () => {
      const coord = window.__SHUMAP_refreshPreview();
      if (!coord) {
        document.getElementById("shumap-status").textContent = "没有抓到坐标，请手动填写或重新点击地图。";
        return;
      }
      await window.shuMapSavePoint(coord);
    });

    document.getElementById("shumap-save-manual").addEventListener("click", async () => {
      const lng = Number(document.getElementById("shumap-manual-lng").value);
      const lat = Number(document.getElementById("shumap-manual-lat").value);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        document.getElementById("shumap-status").textContent = "手动坐标格式不对，请输入数字。";
        return;
      }
      await window.shuMapSavePoint({ longitude: lng, latitude: lat, source: "manual-input" });
    });

    document.getElementById("shumap-skip").addEventListener("click", async () => {
      await window.shuMapSkipPoint();
    });

    document.getElementById("shumap-prev").addEventListener("click", async () => {
      await window.shuMapPrevPoint();
    });

    document.addEventListener("keydown", async (event) => {
      const tag = document.activeElement?.tagName?.toLowerCase();
      const editable = tag === "input" || tag === "textarea";
      if (editable) {
        return;
      }

      if (event.key === "f" || event.key === "F") {
        event.preventDefault();
        window.__SHUMAP_autofillSearch();
      } else if (event.key === "r" || event.key === "R") {
        event.preventDefault();
        window.__SHUMAP_refreshPreview();
      } else if (event.key === "s" || event.key === "S") {
        event.preventDefault();
        const coord = window.__SHUMAP_refreshPreview();
        if (coord) {
          await window.shuMapSavePoint(coord);
        }
      } else if (event.key === "k" || event.key === "K") {
        event.preventDefault();
        await window.shuMapSkipPoint();
      } else if (event.key === "j" || event.key === "J") {
        event.preventDefault();
        await window.shuMapPrevPoint();
      }
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (error) {
    throw new Error(
      "Missing Playwright runtime. Run `npm install` and install a browser before starting the picker."
    );
  }
  const inputPath = path.resolve(args.input);
  const outputPath = path.resolve(args.output);
  const { items, sourcePath } = loadItems(inputPath, outputPath);
  const queue = buildQueue(items, args);

  if (queue.length === 0) {
    console.log("没有需要处理的建筑。");
    return;
  }

  let queueCursor = 0;
  let actionLock = Promise.resolve();

  const launchOptions = { headless: false, slowMo: 80 };
  if (fs.existsSync(SYSTEM_CHROME_PATH)) {
    launchOptions.executablePath = SYSTEM_CHROME_PATH;
  } else {
    launchOptions.channel = "chrome";
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport: { width: 1600, height: 980 } });
  const page = await context.newPage();

  const persist = async () => {
    await saveJson(outputPath, items);
  };

  const syncState = async () => {
    const index = queue[queueCursor];
    const item = items[index];
    const state = buildOverlayState(item, queueCursor + 1, queue.length);
    await page.evaluate((value) => {
      window.__SHUMAP_setState(value);
    }, state);
    await page.evaluate(() => {
      window.__SHUMAP_autofillSearch();
    });
    console.log(
      `[${queueCursor + 1}/${queue.length}] ${item.campus} / ${item.name} / ${item.svgElementId}`
    );
  };

  const advance = async (direction) => {
    if (direction === "next") {
      if (queueCursor < queue.length - 1) {
        queueCursor += 1;
        await syncState();
      } else {
        await page.evaluate(() => {
          window.__SHUMAP_setState({
            position: "完成",
            total: "完成",
            campus: "全部已完成",
            name: "可以关闭浏览器了",
            svgElementId: "-",
            category: "-",
            query: "",
            existingLongitude: null,
            existingLatitude: null,
          });
          document.getElementById("shumap-status").textContent = "所有待处理建筑都已经保存。";
        });
        console.log(`已全部处理完成，结果已写入 ${outputPath}`);
      }
    } else if (direction === "prev" && queueCursor > 0) {
      queueCursor -= 1;
      await syncState();
    }
  };

  await page.exposeBinding("shuMapSavePoint", async (_source, payload) => {
    actionLock = actionLock.then(async () => {
      const index = queue[queueCursor];
      const item = items[index];
      item.navigation = {
        ...(item.navigation || {}),
        coordSystem: "gcj02",
        longitude: Number(payload.longitude),
        latitude: Number(payload.latitude),
        address: buildAddress(item),
        mapDisplayName: buildMapDisplayName(item),
        source: "opengps-playwright",
        verified: true,
        geocodeStatus: "manual-picked",
        pickedAt: new Date().toISOString(),
        pickerSource: payload.source || "page-detected",
      };
      await persist();
      console.log(
        `已保存 ${item.name}: ${formatCoordinate(item.navigation.longitude)}, ${formatCoordinate(item.navigation.latitude)}`
      );
      await advance("next");
    });
    return actionLock;
  });

  await page.exposeBinding("shuMapSkipPoint", async () => {
    actionLock = actionLock.then(async () => {
      const index = queue[queueCursor];
      const item = items[index];
      console.log(`已跳过 ${item.campus} / ${item.name}`);
      await advance("next");
    });
    return actionLock;
  });

  await page.exposeBinding("shuMapPrevPoint", async () => {
    actionLock = actionLock.then(async () => {
      await advance("prev");
    });
    return actionLock;
  });

  await page.goto(args.siteUrl, { waitUntil: "domcontentloaded" });
  await installOverlay(page);
  await syncState();

  page.on("close", () => {
    console.log("页面已关闭。");
  });
  browser.on("disconnected", () => {
    console.log("浏览器已关闭。");
  });

  console.log(`已从 ${sourcePath} 载入 ${items.length} 条记录，当前待处理 ${queue.length} 条。`);
  console.log(`结果会持续写入 ${outputPath}`);

  await page.waitForEvent("close", { timeout: 0 });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
