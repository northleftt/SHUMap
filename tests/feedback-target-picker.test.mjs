// 反馈目标选择器（校区过滤 + 搜索）的纯逻辑自验，直接在 node 里跑。
//
// 背景：原来两端都是一个把全部 219 个地点铺平的 picker/下拉，没有校区、没有搜索，
// 要在几百项里滑。改成「校区档 + 搜索框 + 截断候选列表」后，判定逻辑落在
// miniprogram/miniprogram/lib/feedback-targets.ts，Web 端镜像 src/lib/feedback/targets.ts。
//
// 断言四组：
// 1. 两端镜像文件从 ---- shared-from-here ---- 起逐字相同（防漂移）；
// 2. buildPlaceTargets 只收 place/building、用 entityId 而非 poiKey、剔掉无 revisionId 的项；
// 3. 搜索命中优先级（名字 > 别名 > 楼内设施/商户）、校区过滤、截断与 total；
// 4. 提交契约：place 目标带 revisionId，站点目标 revisionId 恒为 null。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "tmp/feedback-target-test");
mkdirSync(outDir, { recursive: true });

const MP_SOURCE = join(repoRoot, "miniprogram/miniprogram/lib/feedback-targets.ts");
const WEB_SOURCE = join(repoRoot, "src/lib/feedback/targets.ts");
const MARKER = "---- shared-from-here ----";

// ---------------------------------------------------------------------------
// 1. 两端镜像不漂移
// ---------------------------------------------------------------------------
{
  const shared = (path) => {
    const text = readFileSync(path, "utf8");
    const index = text.indexOf(MARKER);
    assert.ok(index > 0, `${path} 必须带 ${MARKER} 标记`);
    return text.slice(index + MARKER.length);
  };
  assert.equal(
    shared(MP_SOURCE),
    shared(WEB_SOURCE),
    "反馈目标选择逻辑两端必须逐字一致（改一端就要同步另一端）",
  );

  // Web 端不能引到小程序的类型模块，反之亦然。
  const webHead = readFileSync(WEB_SOURCE, "utf8").slice(0, readFileSync(WEB_SOURCE, "utf8").indexOf(MARKER));
  assert.ok(!webHead.includes("./release/types"), "Web 镜像不应引用小程序的 release/types");
  assert.match(webHead, /from "\.\.\/types"/, "Web 镜像应从 src/lib/types 取 MapPoi");
}

// ---------------------------------------------------------------------------
// 编译小程序端实现（Web 端与之逐字相同，上面已断言）
// ---------------------------------------------------------------------------
execFileSync(join(repoRoot, "node_modules/.bin/esbuild"), [
  MP_SOURCE,
  "--bundle",
  "--format=cjs",
  "--platform=node",
  `--outfile=${join(outDir, "targets.cjs")}`,
]);

const require = createRequire(import.meta.url);
const targets = require(join(outDir, "targets.cjs"));

const CAMPUSES = [
  { id: "campus_baoshan", key: "baoshan", label: "宝山校区" },
  { id: "campus_jiading", key: "jiading", label: "嘉定校区" },
  { id: "campus_yanchang", key: "yanchang", label: "延长校区" },
];

function poi(overrides) {
  return {
    id: "x",
    poiKey: "x",
    revisionId: "prev_x",
    entityType: "building",
    entityId: "place_x",
    name: "某楼",
    campusKey: "baoshan",
    campusLabel: "宝山校区",
    kindName: "教学楼",
    facilities: [],
    merchants: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 2. buildPlaceTargets 的取舍
// ---------------------------------------------------------------------------
{
  const options = targets.buildPlaceTargets([
    poi({ entityId: "place_a", name: "A 楼", revisionId: "prev_a" }),
    // 独立地点：poiKey 带 place: 前缀，targetId 必须是裸 entityId，否则服务端 404。
    poi({ entityType: "place", poiKey: "place:place_b", entityId: "place_b", name: "操场", revisionId: "prev_b" }),
    // 站点/设施/商户不是合法的反馈目标（worker validateFeedbackTarget 直接拒）。
    poi({ entityType: "facility", entityId: "fac_1", name: "洗衣机", revisionId: "frev_1" }),
    poi({ entityType: "merchant", entityId: "mer_1", name: "小卖部", revisionId: "mrev_1" }),
    poi({ entityType: "transit_stop", entityId: "stop_1", name: "北门站", revisionId: null }),
    // place 提交必须带 baseRevisionId，没有修订号的地点提交必被拒，先剔掉。
    poi({ entityType: "place", entityId: "place_c", name: "无修订", revisionId: null }),
  ]);

  assert.deepEqual(
    options.map((option) => option.targetId),
    ["place_a", "place_b"],
    "只保留 building/place 且有 revisionId 的目标，且用 entityId",
  );
  assert.equal(options[1].targetId, "place_b", "独立地点不能带 place: 前缀");
}

// ---------------------------------------------------------------------------
// 3. 搜索优先级 / 校区过滤 / 截断
// ---------------------------------------------------------------------------
{
  const options = targets.buildPlaceTargets(
    [
      poi({ entityId: "place_lehu", name: "乐乎楼", revisionId: "prev_1" }),
      poi({
        entityId: "place_dorm",
        name: "东区宿舍 3 号",
        revisionId: "prev_2",
        facilities: [{ displayName: "自助洗衣机", typeName: "洗衣" }],
      }),
      poi({
        entityId: "place_cantean",
        name: "第四食堂",
        revisionId: "prev_3",
        campusKey: "jiading",
        campusLabel: "嘉定校区",
        merchants: [{ name: "兰州拉面", businessType: "面食" }],
      }),
    ],
    new Map([["place_lehu", ["乐乎新楼", "乐乎楼"]]]),
  );

  // 名字直接命中，无 hint
  const byName = targets.filterFeedbackTargets(options, { query: "乐乎" });
  assert.equal(byName.items[0].targetId, "place_lehu");
  assert.equal(byName.items[0].matchHint, "", "名字直接命中不需要解释");

  // 别名命中：带「别名 …」说明；与名字相同的别名不重复收
  const byAlias = targets.filterFeedbackTargets(options, { query: "新楼" });
  assert.equal(byAlias.items.length, 1);
  assert.equal(byAlias.items[0].matchHint, "别名 乐乎新楼");

  // 楼内设施命中宿主楼宇——用户反馈的正是这一条（搜设施不该无结果）
  const byFacility = targets.filterFeedbackTargets(options, { query: "洗衣机" });
  assert.equal(byFacility.items.length, 1);
  assert.equal(byFacility.items[0].targetId, "place_dorm");
  assert.equal(byFacility.items[0].matchHint, "内含 自助洗衣机");

  // 商户同理
  const byMerchant = targets.filterFeedbackTargets(options, { query: "拉面" });
  assert.equal(byMerchant.items[0].targetId, "place_cantean");
  assert.equal(byMerchant.items[0].matchHint, "内含 兰州拉面");

  // 类别名兜底：按业态/设施类型搜也要命中，店名与类别不同名时尤其重要
  // （线上就有「星巴克」属「咖啡」这类情形，搜类别不该无结果）。
  const byCategory = targets.filterFeedbackTargets(options, { query: "面食" });
  assert.equal(byCategory.items.length, 1);
  assert.equal(byCategory.items[0].targetId, "place_cantean");
  assert.equal(byCategory.items[0].matchHint, "内含 兰州拉面（面食）");

  // 类别命中排在具体名字命中之后：按类别搜通常一大片，不该压过精确命中
  const nameBeatsCategory = targets.buildPlaceTargets([
    poi({ entityId: "place_named", name: "面食楼", revisionId: "prev_n" }),
    poi({
      entityId: "place_cat",
      name: "某楼",
      revisionId: "prev_c",
      merchants: [{ name: "兰州拉面", businessType: "面食" }],
    }),
  ]);
  assert.deepEqual(
    targets.filterFeedbackTargets(nameBeatsCategory, { query: "面食" })
      .items.map((item) => item.targetId),
    ["place_named", "place_cat"],
    "名字命中排在类别命中之前",
  );

  // 校区过滤
  const jiading = targets.filterFeedbackTargets(options, { campusKey: "jiading" });
  assert.deepEqual(jiading.items.map((item) => item.targetId), ["place_cantean"]);

  // 空 query 列全部（首次展开不该是空面板）
  assert.equal(targets.filterFeedbackTargets(options, {}).items.length, 3);

  // 校区筛选项只列真有候选的校区 + 全部
  assert.deepEqual(
    targets.feedbackCampusOptions(options, CAMPUSES).map((campus) => campus.key),
    ["", "baoshan", "jiading"],
    "延长校区没有候选，不出现在档位里",
  );

  // 截断与 total
  const many = targets.buildPlaceTargets(
    Array.from({ length: 60 }, (_, index) =>
      poi({ entityId: `place_${index}`, name: `楼 ${String(index).padStart(2, "0")}`, revisionId: `prev_${index}` })),
  );
  const page = targets.filterFeedbackTargets(many, {});
  assert.equal(page.items.length, targets.FEEDBACK_TARGET_LIMIT);
  assert.equal(page.total, 60);
  assert.equal(page.truncated, true, "超出上限要告诉用户还有更多");
  assert.equal(targets.filterFeedbackTargets(many, { limit: 60 }).truncated, false);

  // 前缀命中排在包含命中之前
  const ordered = targets.filterFeedbackTargets(
    targets.buildPlaceTargets([
      poi({ entityId: "p1", name: "东门快递驿站", revisionId: "r1" }),
      poi({ entityId: "p2", name: "快递中心", revisionId: "r2" }),
    ]),
    { query: "快递" },
  );
  assert.deepEqual(ordered.items.map((item) => item.name), ["快递中心", "东门快递驿站"]);
}

// ---------------------------------------------------------------------------
// 4. 站点目标与提交契约
// ---------------------------------------------------------------------------
{
  const stops = targets.buildStopTargets(
    [
      { id: "stop_1", campus_id: "campus_jiading", name: "嘉定-北门" },
      { id: "stop_2", campus_id: null, name: "无校区站" },
    ],
    CAMPUSES,
  );
  assert.equal(stops[0].campusLabel, "嘉定校区", "站点校区名从 campuses 反查");
  assert.equal(stops[0].revisionId, null, "站点没有修订号，baseRevisionId 必须传 null");
  assert.equal(stops[1].campusLabel, "", "无校区站点不显示校区");
  assert.equal(stops[0].kindName, "校车站点");

  const page = targets.filterFeedbackTargets(stops, { query: "北门" });
  assert.equal(page.items[0].targetId, "stop_1");
  assert.equal(page.items[0].revisionId, null);

  assert.equal(targets.feedbackTargetLabel(page.items[0]), "嘉定-北门 · 嘉定校区");
  assert.equal(targets.feedbackTargetLabel(stops[1]), "无校区站");
  assert.equal(targets.feedbackTargetLabel(null), "");
}

// ---------------------------------------------------------------------------
// 5. 真实 release 快照：搜索能覆盖全部三校区，且每条 place 目标都能提交
// ---------------------------------------------------------------------------
{
  const manifestPath = join(repoRoot, "tests/fixtures/release-manifest-live.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const places = manifest.places ?? [];
  assert.ok(places.length > 100, "快照应含全部地点");

  // 直接用 manifest.places 造最小 POI 形状（装配整张地图要 SVG，此处不需要）。
  const campusById = new Map(CAMPUSES.map((campus) => [campus.id, campus]));
  const pois = places
    .filter((place) => place.lifecycleStatus !== "retired")
    .map((place) => poi({
      entityType: place.isBuilding ? "building" : "place",
      entityId: place.id,
      poiKey: place.isBuilding ? place.id : `place:${place.id}`,
      name: place.displayName,
      revisionId: place.revisionId,
      campusKey: campusById.get(place.campusId)?.key ?? "",
      campusLabel: campusById.get(place.campusId)?.label ?? "",
    }));

  const options = targets.buildPlaceTargets(
    pois,
    new Map(places.map((place) => [place.id, place.aliases ?? []])),
  );
  assert.ok(options.length > 100, `真实快照应产出大量候选，实际 ${options.length}`);
  for (const option of options) {
    assert.ok(option.revisionId, `${option.name} 缺 revisionId，提交必被拒`);
    assert.ok(!option.targetId.startsWith("place:"), `${option.targetId} 不应带 place: 前缀`);
  }

  // 每个候选都必须能被自己的完整名字搜到（否则用户按名字搜会找不到）。
  for (const option of options.slice(0, 40)) {
    const page = targets.filterFeedbackTargets(options, { query: option.name });
    assert.ok(
      page.items.some((item) => item.targetId === option.targetId),
      `按名字「${option.name}」应能搜到自己`,
    );
  }
}

console.log("[ok] 反馈目标选择器：两端镜像一致、目标取舍/搜索优先级/校区过滤/截断/提交契约全部通过");
