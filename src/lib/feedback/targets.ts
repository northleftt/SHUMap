import type { TransitStop } from "../api/types";
import type { MapPoi } from "../types";

// 反馈目标选择的纯逻辑：校区过滤 + 关键词搜索 + 排序。
//
// 小程序端镜像 miniprogram/miniprogram/lib/feedback-targets.ts：两份从下面这行标记注释起
// 逐字相同，只有文件顶部的 import 因两端类型模块布局不同而有别。
// tests/feedback-target-picker.test.mjs 断言两份不漂移。
// ---- shared-from-here ----
//
// 为什么目标只能是「地点」：worker 的 validateFeedbackTarget 明确拒绝
// facility / merchant_outlet 作为反馈目标（worker/modules/submissions.ts）。
// 所以楼内设施与商户不做独立目标，而是挂到宿主楼宇的搜索关键词上——
// 搜「自助洗衣机」应当找到它所在的楼，而不是无结果。
//
// 站点（校车反馈）没有修订号，revisionId 恒为 null；提交时 baseRevisionId 必须传 null。

/** 一次最多返回多少条候选。超出时提示继续输入，避免长列表滑不到底。 */
export const FEEDBACK_TARGET_LIMIT = 50;

/** 关键词条目：楼内设施 / 商户 / 别名，命中后用于生成「为什么这条被搜出来」。 */
export interface FeedbackTargetKeyword {
  name: string;
  normalized: string;
  /** 分类名（设施类型 / 商户业态 / 「别名」），本身也参与匹配。 */
  kind: string;
  kindNormalized: string;
}

export interface FeedbackTargetOption {
  /** 提交给 API 的 targetId（place 的裸 id 或 transit_stop 的 id）。 */
  targetId: string;
  name: string;
  normalizedName: string;
  campusKey: string;
  campusLabel: string;
  kindName: string;
  /** place 目标的 baseRevisionId；站点为 null。 */
  revisionId: string | null;
  aliases: FeedbackTargetKeyword[];
  contents: FeedbackTargetKeyword[];
}

export interface FeedbackTargetResult {
  targetId: string;
  name: string;
  campusLabel: string;
  kindName: string;
  revisionId: string | null;
  /** 命中的不是名字本身时的说明，如「内含 自助洗衣机」；直接命中名字则为空串。 */
  matchHint: string;
}

export interface FeedbackTargetPage {
  items: FeedbackTargetResult[];
  total: number;
  truncated: boolean;
}

export interface FeedbackCampusOption {
  key: string;
  label: string;
}

/** 与服务端 normalizeSearchText 同式（NFKC + 小写 + 折叠空白）。 */
export function normalizeFeedbackQuery(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function keyword(name: string, kind: string): FeedbackTargetKeyword {
  return {
    name,
    normalized: normalizeFeedbackQuery(name),
    kind,
    kindNormalized: normalizeFeedbackQuery(kind),
  };
}

/**
 * 可作为反馈目标的地点：楼宇 + 独立地点。
 *
 * 用 entityId 而不是 poiKey——独立地点的 poiKey 带 `place:` 前缀，直接提交会 404。
 * 没有 revisionId 的地点提交必然被拒（place 必须带 baseRevisionId），先剔掉。
 */
export function buildPlaceTargets(
  pois: readonly MapPoi[],
  aliasesByPlaceId?: ReadonlyMap<string, readonly string[]>,
): FeedbackTargetOption[] {
  const options: FeedbackTargetOption[] = [];
  for (const poi of pois) {
    if (poi.entityType !== "building" && poi.entityType !== "place") continue;
    if (poi.revisionId === null) continue;
    const contents: FeedbackTargetKeyword[] = [];
    const seen = new Set<string>();
    for (const facility of poi.facilities) {
      const name = (facility.displayName || facility.typeName || "").trim();
      if (name === "" || seen.has(name)) continue;
      seen.add(name);
      contents.push(keyword(name, facility.typeName || "设施"));
    }
    for (const merchant of poi.merchants) {
      const name = (merchant.name || "").trim();
      if (name === "" || seen.has(name)) continue;
      seen.add(name);
      contents.push(keyword(name, merchant.businessType || "商户"));
    }
    const aliases: FeedbackTargetKeyword[] = [];
    for (const alias of aliasesByPlaceId?.get(poi.entityId) ?? []) {
      const name = alias.trim();
      if (name === "" || name === poi.name) continue;
      aliases.push(keyword(name, "别名"));
    }
    options.push({
      targetId: poi.entityId,
      name: poi.name,
      normalizedName: normalizeFeedbackQuery(poi.name),
      campusKey: poi.campusKey,
      campusLabel: poi.campusLabel,
      kindName: poi.kindName,
      revisionId: poi.revisionId,
      aliases,
      contents,
    });
  }
  return options;
}

/** 校车站点目标。站点自身不带校区名，从 campuses 反查。 */
export function buildStopTargets(
  stops: readonly TransitStop[],
  campuses: readonly { id: string; key: string; label: string }[],
): FeedbackTargetOption[] {
  const byId = new Map(campuses.map((campus) => [campus.id, campus]));
  return stops.map((stop) => {
    const campus = stop.campus_id === null ? undefined : byId.get(stop.campus_id);
    return {
      targetId: stop.id,
      name: stop.name,
      normalizedName: normalizeFeedbackQuery(stop.name),
      campusKey: campus?.key ?? "",
      campusLabel: campus?.label ?? "",
      kindName: "校车站点",
      revisionId: null,
      aliases: [],
      contents: [],
    };
  });
}

/**
 * 校区筛选项：只列出当前目标集合里真有候选的校区，外加「全部」。
 * 顺序跟随传入的 campuses（release 里的校区顺序），不重排。
 */
export function feedbackCampusOptions(
  options: readonly FeedbackTargetOption[],
  campuses: readonly { key: string; label: string }[],
): FeedbackCampusOption[] {
  const present = new Set(options.map((option) => option.campusKey));
  const result: FeedbackCampusOption[] = [{ key: "", label: "全部校区" }];
  for (const campus of campuses) {
    if (present.has(campus.key)) result.push({ key: campus.key, label: campus.label });
  }
  return result;
}

interface Match {
  score: number;
  hint: string;
}

/** 名字直接命中优先于别名，别名优先于楼内设施 / 商户。不命中返回 null。 */
function matchTarget(option: FeedbackTargetOption, query: string): Match | null {
  if (option.normalizedName === query) return { score: 0, hint: "" };
  if (option.normalizedName.startsWith(query)) return { score: 1, hint: "" };
  if (option.normalizedName.includes(query)) return { score: 2, hint: "" };
  for (const alias of option.aliases) {
    if (alias.normalized.includes(query)) return { score: 3, hint: `别名 ${alias.name}` };
  }
  for (const content of option.contents) {
    if (content.normalized.includes(query)) return { score: 4, hint: `内含 ${content.name}` };
  }
  // 类别名兜底：搜「咖啡」应当找到里面有咖啡店的楼，即便店名叫「星巴克」。
  // 排在具体名字之后，因为按类别搜通常命中很多条，不该压过精确的名字命中。
  for (const content of option.contents) {
    if (content.kindNormalized !== "" && content.kindNormalized.includes(query)) {
      return { score: 5, hint: `内含 ${content.name}（${content.kind}）` };
    }
  }
  return null;
}

/**
 * 过滤 + 排序 + 截断。空 query 时按名字列全部（受 limit 截断），
 * 所以第一次展开就能看到东西，而不是一个空面板。
 */
export function filterFeedbackTargets(
  options: readonly FeedbackTargetOption[],
  params: { campusKey?: string; query?: string; limit?: number } = {},
): FeedbackTargetPage {
  const campusKey = params.campusKey ?? "";
  const query = normalizeFeedbackQuery(params.query ?? "");
  const limit = params.limit ?? FEEDBACK_TARGET_LIMIT;
  const matched: Array<{ score: number; hint: string; option: FeedbackTargetOption }> = [];
  for (const option of options) {
    if (campusKey !== "" && option.campusKey !== campusKey) continue;
    if (query === "") {
      matched.push({ score: 0, hint: "", option });
      continue;
    }
    const match = matchTarget(option, query);
    if (match !== null) matched.push({ score: match.score, hint: match.hint, option });
  }
  matched.sort((left, right) =>
    left.score - right.score
    || (left.option.name < right.option.name ? -1 : left.option.name > right.option.name ? 1 : 0));
  const items = matched.slice(0, Math.max(0, limit)).map(({ option, hint }) => ({
    targetId: option.targetId,
    name: option.name,
    campusLabel: option.campusLabel,
    kindName: option.kindName,
    revisionId: option.revisionId,
    matchHint: hint,
  }));
  return { items, total: matched.length, truncated: matched.length > items.length };
}

/** 选中项的展示名（含校区），两端的按钮标题共用。 */
export function feedbackTargetLabel(option: FeedbackTargetResult | null): string {
  if (option === null) return "";
  return option.campusLabel === "" ? option.name : `${option.name} · ${option.campusLabel}`;
}
