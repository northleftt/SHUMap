// 小程序底部 tabBar 端到端验证（对照 Web 端 BottomTabBar 的 4 个 Tab）。
// 用法：
//   1) cli auto --project miniprogram --auto-port 9420
//   2) node scripts/miniprogram-tabs-automator.mjs
// 校验：四个 tab 页 switchTab 可达、页面无运行时异常，并逐页截图到 tmp/tab-test/。
// 注意：Skyline 页面（map/shuttle）元素选择不可用，截图与 console/exception 监听可用（见 miniprogram/AGENTS.md 坑 #5）。

import path from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import automator from "miniprogram-automator";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "tmp/tab-test");
mkdirSync(OUT_DIR, { recursive: true });

const TABS = [
  { url: "/pages/map/map", name: "map" },
  { url: "/pages/shuttle/shuttle", name: "shuttle" },
  { url: "/pages/offcampus/offcampus", name: "offcampus" },
  { url: "/pages/profile/profile", name: "profile" },
];

const problems = [];
const miniProgram = await automator.connect({ wsEndpoint: "ws://localhost:9420" });

miniProgram.on("console", (msg) => {
  if (msg.type === "error" || msg.type === "warn") {
    console.log(`[console.${msg.type}]`, msg.text);
  }
});
miniProgram.on("exception", (err) => {
  problems.push(`exception: ${err.message ?? err}`);
  console.log("[exception]", err.message ?? err);
});

try {
  for (const tab of TABS) {
    const page = await miniProgram.switchTab(tab.url);
    await page.waitFor(1500);
    const current = await miniProgram.currentPage();
    const currentPath = current.path.split("?")[0];
    const ok = currentPath === tab.url.replace(/^\//, "");
    console.log(`${ok ? "✓" : "✗"} switchTab ${tab.url} → ${currentPath}`);
    if (!ok) problems.push(`switchTab ${tab.url} 落点异常: ${currentPath}`);
    await miniProgram.screenshot({ path: path.join(OUT_DIR, `${tab.name}.png`) });
  }
} finally {
  await miniProgram.disconnect();
}

if (problems.length > 0) {
  console.error("\nFAIL:\n" + problems.map((p) => `- ${p}`).join("\n"));
  process.exit(1);
}
console.log(`\nOK: 4 个 tab 页全部可达，无运行时异常。截图在 tmp/tab-test/`);
