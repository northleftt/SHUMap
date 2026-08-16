import { Copy, Download, MapPin, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fitGeoTransform,
  geoTransformResiduals,
  type GeoTransform,
} from "../../../shared/geo-transform.mjs";
import {
  isCenterEcho,
  isTencentOrigin,
  locpickerUrl,
  readLocationPickerMessage,
} from "../../../shared/tencent-locpicker.mjs";
import * as admin from "../../lib/api/admin";
import { CAMPUS_GEO_TRANSFORMS } from "../../lib/release/mapData";
import type { CampusKey } from "../../lib/types";
import type { Campus } from "../adminTypes";
import { CampusMapCanvas, type CanvasGeometry } from "./CampusMapCanvas";
import {
  EmptyState,
  ErrorBanner,
  Field,
  GhostButton,
  InfoNote,
  LoadingState,
  Panel,
  PrimaryButton,
  useAsyncData,
} from "./primitives";

// ---------------------------------------------------------------------------
// 坐标校准器：产出 gcj02 ↔ viewBox 仿射变换的控制点。
//
// 为什么需要外部真值：拟合仿射要的是成对的量（GCJ02, viewBox）。viewBox 那半可以
// 从底图上点出来，GCJ02 那半推不出来——用「画布选点 + 逆变换」去取等于拿变换的
// 输出拟合变换本身，参数会锁死在当前误差上且完全不可见。所以左边嵌腾讯选点器
// （独立的地面真值，coordtype=5 默认就是 GCJ02），右边点同一个特征的底图位置，
// 一次产出一对。
//
// 控制点只用来拟合变换，不是业务数据，因此不进库：存 localStorage 防手滑，
// 定稿后导出 JSON 收进 data/geo-control-points.json。这也顺带把控制点与地点数据
// 解耦——从前两者是同一份 campus-buildings.picked.json，改地点会悄悄改变拟合输入。
// ---------------------------------------------------------------------------

const STORAGE_KEY = "shumap.geo-control-points.v1";
const TENCENT_KEY = import.meta.env.VITE_TENCENT_MAP_KEY ?? "";

/** 选点器初始视野中心。只影响打开时看哪儿，不参与任何计算。 */
const CAMPUS_CENTER: Record<CampusKey, { longitude: number; latitude: number }> = {
  baoshan: { longitude: 121.3945, latitude: 31.3164 },
  jiading: { longitude: 121.2487, latitude: 31.377 },
  yanchang: { longitude: 121.4582, latitude: 31.2752 },
};

const CAMPUS_LABEL: Record<CampusKey, string> = {
  baoshan: "宝山校区",
  jiading: "嘉定校区",
  yanchang: "延长校区",
};

/** 控制点该选什么：点状、在卫星/矢量图和底图上都能钉准的特征。 */
const PICK_HINTS = [
  "路口道路中线的交叉点",
  "操场跑道 / 球场的角",
  "校门中线",
  "轮廓清晰的小建筑的角",
];

interface ControlPoint {
  id: string;
  campusKey: CampusKey;
  label: string;
  longitude: number;
  latitude: number;
  x: number;
  y: number;
  pickedAt: string;
}

interface TencentPick {
  longitude: number;
  latitude: number;
  name: string;
  address: string;
}

function isCampusKey(value: unknown): value is CampusKey {
  return value === "baoshan" || value === "jiading" || value === "yanchang";
}

/** 只接受形状完全正确的点，坏数据宁可丢掉也不要污染拟合。 */
function readControlPoint(raw: unknown): ControlPoint | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const longitude = num(item.longitude);
  const latitude = num(item.latitude);
  const x = num(item.x);
  const y = num(item.y);
  if (longitude === null || latitude === null || x === null || y === null) return null;
  if (!isCampusKey(item.campusKey)) return null;
  return {
    id: typeof item.id === "string" && item.id ? item.id : crypto.randomUUID(),
    campusKey: item.campusKey,
    label: typeof item.label === "string" ? item.label : "",
    longitude,
    latitude,
    x,
    y,
    pickedAt: typeof item.pickedAt === "string" ? item.pickedAt : new Date().toISOString(),
  };
}

function loadStored(): ControlPoint[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(readControlPoint).filter((item): item is ControlPoint => item !== null);
  } catch {
    return [];
  }
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatTransform(transform: GeoTransform): string {
  const n = (value: number) => value.toFixed(6);
  return `      a: ${n(transform.a)},\n      b: ${n(transform.b)},\n      c: ${n(transform.c)},\n`
    + `      d: ${n(transform.d)},\n      e: ${n(transform.e)},\n      f: ${n(transform.f)},`;
}

export function GeoCalibrator() {
  const { state } = useAsyncData(async (signal) => {
    const [spaces, maps] = await Promise.all([
      admin.listSpaces<{ campuses: Campus[] }>(signal),
      admin.listMapVersions(signal),
    ]);
    return { campuses: spaces.campuses, mapVersions: maps.items };
  }, []);

  const [campusKey, setCampusKey] = useState<CampusKey>("baoshan");
  const [points, setPoints] = useState<ControlPoint[]>(() => loadStored());
  const [tencentPick, setTencentPick] = useState<TencentPick | null>(null);
  const [canvasGeometry, setCanvasGeometry] = useState<CanvasGeometry | null>(null);
  const [label, setLabel] = useState("");
  const [notice, setNotice] = useState("");
  const [importError, setImportError] = useState("");
  /** 收到了选点消息、但 origin 不在白名单里。见下方 message 监听的注释。 */
  const [blockedOrigin, setBlockedOrigin] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(points));
    } catch {
      // 存不下不影响本次使用，导出仍然可用。
    }
  }, [points]);

  // 腾讯选点器通过 postMessage 回传。校验 origin —— 这是页面上唯一接受跨域消息的地方。
  //
  // 被 origin 白名单拒掉的消息要记下来并显示出来：白名单缺一个域时，
  // 现象与「根本没收到消息」完全一样（都是「还没有选点」不消失），
  // 曾经因此排查了很久。记下来之后，界面能直接告诉你「收到了但域不在白名单」。
  // campusKey 进依赖：中心随校区变，回显判据要跟着换。
  useEffect(() => {
    const center = CAMPUS_CENTER[campusKey];
    const onMessage = (event: MessageEvent) => {
      if (!isTencentOrigin(event.origin)) {
        // 只记看起来像选点消息的，避免把页面上其他第三方消息也算进来。
        if (readLocationPickerMessage(event.data)) {
          setBlockedOrigin(event.origin);
        }
        return;
      }
      const pick = readLocationPickerMessage(event.data);
      if (!pick) return;
      setBlockedOrigin("");
      // 载入回显（选点器把 URL 里的 coord 原样发回来）不是选点。收下它会凭空
      // 多出一个「经纬度是校区中心常量、底图坐标是随手点的第一处」的假控制点，
      // 残差数百米且把整套拟合参数拖偏。
      if (isCenterEcho(pick, center)) return;
      setTencentPick(pick);
      setLabel((current) => current || pick.name);
    };
    window.addEventListener("message", onMessage, false);
    return () => window.removeEventListener("message", onMessage);
  }, [campusKey]);

  // src 只随校区变：每次 setState 都重算会重载 iframe，把用户拖好的视野丢掉。
  const iframeSrc = useMemo(
    () => locpickerUrl({ key: TENCENT_KEY, ...CAMPUS_CENTER[campusKey] }),
    [campusKey],
  );

  const campusPoints = useMemo(
    () => points.filter((point) => point.campusKey === campusKey),
    [points, campusKey],
  );

  const fit = useMemo(() => {
    if (campusPoints.length < 3) return null;
    try {
      const transform = fitGeoTransform(campusPoints);
      const latitude = average(campusPoints.map((point) => point.latitude));
      const residuals = geoTransformResiduals(transform, campusPoints, latitude).map((item) => item.meters);
      const current = geoTransformResiduals(CAMPUS_GEO_TRANSFORMS[campusKey], campusPoints, latitude)
        .map((item) => item.meters);
      return {
        transform,
        residuals,
        mean: average(residuals),
        max: Math.max(...residuals),
        currentMean: average(current),
        currentMax: Math.max(...current),
      };
    } catch {
      // 控制点共线时无解；补一个不在同一直线上的点即可。
      return null;
    }
  }, [campusPoints, campusKey]);

  const pendingViewBox = canvasGeometry?.campusKey === campusKey ? canvasGeometry.point : null;
  const canAdd = tencentPick !== null && pendingViewBox !== null;

  const addPoint = useCallback(() => {
    if (!tencentPick || !pendingViewBox) return;
    setPoints((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        campusKey,
        label: label.trim(),
        longitude: tencentPick.longitude,
        latitude: tencentPick.latitude,
        x: pendingViewBox[0],
        y: pendingViewBox[1],
        pickedAt: new Date().toISOString(),
      },
    ]);
    setTencentPick(null);
    setCanvasGeometry(null);
    setLabel("");
    setNotice("已记录一对控制点，可以标下一个了。");
  }, [tencentPick, pendingViewBox, campusKey, label]);

  const exportJson = useCallback(() => {
    const grouped: Record<string, unknown> = {};
    for (const key of ["baoshan", "jiading", "yanchang"] as const) {
      const list = points.filter((point) => point.campusKey === key);
      if (list.length === 0) continue;
      const entry: Record<string, unknown> = {
        controlPoints: list.map(({ label: name, longitude, latitude, x, y, pickedAt }) => ({
          label: name,
          longitude,
          latitude,
          x,
          y,
          pickedAt,
        })),
      };
      if (list.length >= 3) {
        try {
          const transform = fitGeoTransform(list);
          const latitude = average(list.map((point) => point.latitude));
          const meters = geoTransformResiduals(transform, list, latitude).map((item) => item.meters);
          entry.transform = transform;
          entry.meanResidualMeters = Number(average(meters).toFixed(2));
          entry.maxResidualMeters = Number(Math.max(...meters).toFixed(2));
        } catch {
          // 共线：只导出控制点，不带拟合结果。
        }
      }
      grouped[key] = entry;
    }
    const payload = {
      version: 1,
      generatedAt: new Date().toISOString(),
      source: "admin/dev-tools/geo-calibrator (腾讯选点器 GCJ02 + 校园底图 viewBox)",
      campuses: grouped,
    };
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "geo-control-points.json";
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice("已导出 geo-control-points.json，放进 data/ 即可。");
  }, [points]);

  const importJson = useCallback((file: File) => {
    setImportError("");
    file
      .text()
      .then((text) => {
        const parsed = JSON.parse(text) as unknown;
        const collected: ControlPoint[] = [];
        const campuses = (parsed as { campuses?: unknown })?.campuses;
        if (campuses && typeof campuses === "object") {
          for (const [key, value] of Object.entries(campuses as Record<string, unknown>)) {
            if (!isCampusKey(key)) continue;
            const list = (value as { controlPoints?: unknown })?.controlPoints;
            if (!Array.isArray(list)) continue;
            for (const item of list) {
              const point = readControlPoint({ ...(item as object), campusKey: key });
              if (point) collected.push(point);
            }
          }
        } else if (Array.isArray(parsed)) {
          for (const item of parsed) {
            const point = readControlPoint(item);
            if (point) collected.push(point);
          }
        }
        if (collected.length === 0) {
          setImportError("文件里没有可用的控制点。");
          return;
        }
        setPoints(collected);
        setNotice(`已载入 ${collected.length} 个控制点（替换了当前列表）。`);
      })
      .catch(() => setImportError("文件不是合法 JSON。"));
  }, []);

  if (state.status === "loading") return <LoadingState label="正在加载校区与底图…" />;
  if (state.status === "error") return <ErrorBanner message={state.message} />;

  return (
    <div className="space-y-4">
      {!TENCENT_KEY ? (
        <InfoNote tone="warning">
          缺少 VITE_TENCENT_MAP_KEY。在项目根目录的 .env.local 里写上
          <code className="mx-1">VITE_TENCENT_MAP_KEY=…</code>
          然后重启 dev server，左侧选点器才会出现。
        </InfoNote>
      ) : null}

      <InfoNote>
        左边在腾讯地图上点地面真实位置（返回 GCJ-02），右边在校园底图上点<strong>同一个特征</strong>
        （返回 viewBox 坐标），两边都点好后记为一对控制点。适合当控制点的是：
        {PICK_HINTS.join("、")}。不要用大楼——「楼中心」本身就有歧义，这正是现在误差的来源。
        每校区约 12 个、<strong>刻意铺到四角</strong>比堆在中间管用。
      </InfoNote>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="① 地面位置（腾讯地图 · GCJ-02）" padded={false}>
          <div className="px-5 pb-4">
            {TENCENT_KEY ? (
              <iframe
                className="h-[420px] w-full rounded-lg border border-line"
                src={iframeSrc}
                title="腾讯地图选点"
              />
            ) : (
              <div className="grid h-[420px] place-items-center rounded-lg bg-page text-body text-sub">
                填好 key 后在这里选点
              </div>
            )}
            <div className="mt-3 rounded-lg bg-page p-3 text-aux">
              {tencentPick ? (
                <>
                  <p className="text-ink">
                    经度 {tencentPick.longitude.toFixed(7)} · 纬度 {tencentPick.latitude.toFixed(7)}
                  </p>
                  {tencentPick.name || tencentPick.address ? (
                    <p className="mt-1 text-sub">{tencentPick.name}{tencentPick.address ? ` · ${tencentPick.address}` : ""}</p>
                  ) : null}
                </>
              ) : blockedOrigin ? (
                /* 收到了选点消息但域不在白名单：把实际 origin 显示出来，
                   否则这个情形和「压根没收到」长得一模一样。 */
                <p className="text-error">
                  收到了选点消息，但来源域 <code>{blockedOrigin}</code> 不在白名单里，已被丢弃。
                  把它加进 shared/tencent-locpicker.mjs 的 TENCENT_MESSAGE_ORIGINS。
                </p>
              ) : (
                <p className="text-sub">还没有选点。在上面的地图上点一下，或用它自带的搜索框定位。</p>
              )}
            </div>
          </div>
        </Panel>

        <Panel title="② 底图位置（校园图 · viewBox）" padded={false}>
          <div className="px-5 pb-4">
            <CampusMapCanvas
              campuses={state.data.campuses}
              campusKey={campusKey}
              height="h-[420px]"
              labels={{ point: "控制点" }}
              mapVersions={state.data.mapVersions}
              onCampusChange={(key) => {
                setCampusKey(key);
                setCanvasGeometry(null);
              }}
              onChange={setCanvasGeometry}
              tools={["point"]}
              value={canvasGeometry}
            />
            <div className="mt-3 rounded-lg bg-page p-3 text-aux">
              {pendingViewBox ? (
                <p className="text-ink">x {pendingViewBox[0]} · y {pendingViewBox[1]}</p>
              ) : (
                <p className="text-sub">还没有标点。点上面的「点」工具再在底图上点一下；可以放大以提高精度。</p>
              )}
            </div>
          </div>
        </Panel>
      </div>

      <Panel title={`③ 记为控制点 · ${CAMPUS_LABEL[campusKey]}`}>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-64">
            <Field
              label="名称（可选，便于日后核对）"
              onChange={setLabel}
              placeholder="如：东门中线 / 操场东北角"
              value={label}
            />
          </div>
          <PrimaryButton disabled={!canAdd} onClick={addPoint}>
            <MapPin size={14} />
            记为一对控制点
          </PrimaryButton>
          {!canAdd ? (
            <span className="text-aux text-sub">
              还差：{tencentPick ? "" : "腾讯地图选点"}{!tencentPick && !pendingViewBox ? " + " : ""}
              {pendingViewBox ? "" : "底图标点"}
            </span>
          ) : null}
          {notice ? <span className="text-aux text-primary">{notice}</span> : null}
        </div>
      </Panel>

      <Panel
        title={`④ 拟合结果 · ${CAMPUS_LABEL[campusKey]}（${campusPoints.length} 个控制点）`}
        action={
          <div className="flex gap-2">
            <GhostButton onClick={() => fileRef.current?.click()}>
              <Upload size={14} />
              导入
            </GhostButton>
            <GhostButton disabled={points.length === 0} onClick={exportJson}>
              <Download size={14} />
              导出 JSON
            </GhostButton>
          </div>
        }
      >
        <input
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) importJson(file);
            event.target.value = "";
          }}
          ref={fileRef}
          type="file"
        />
        <ErrorBanner message={importError} />

        {campusPoints.length === 0 ? (
          <EmptyState label="这个校区还没有控制点" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-aux">
              <thead className="text-sub">
                <tr className="border-b border-line text-left">
                  <th className="py-2 pr-3 font-medium">#</th>
                  <th className="py-2 pr-3 font-medium">名称</th>
                  <th className="py-2 pr-3 font-medium">GCJ-02</th>
                  <th className="py-2 pr-3 font-medium">viewBox</th>
                  <th className="py-2 pr-3 font-medium">残差</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {campusPoints.map((point, index) => {
                  const meters = fit?.residuals[index];
                  return (
                    <tr className="border-b border-line/60" key={point.id}>
                      <td className="py-2 pr-3 text-sub">{index + 1}</td>
                      <td className="py-2 pr-3 text-ink">{point.label || <span className="text-sub">未命名</span>}</td>
                      <td className="py-2 pr-3 tabular-nums">
                        {point.longitude.toFixed(6)}, {point.latitude.toFixed(6)}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">
                        {point.x}, {point.y}
                      </td>
                      <td className={`py-2 pr-3 tabular-nums ${meters !== undefined && meters > 8 ? "text-error" : ""}`}>
                        {meters === undefined ? "—" : `${meters.toFixed(1)} m`}
                      </td>
                      <td className="py-2 text-right">
                        <button
                          aria-label="删除这个控制点"
                          className="text-sub hover:text-error"
                          onClick={() => setPoints((current) => current.filter((item) => item.id !== point.id))}
                          title="删除这个控制点"
                          type="button"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {campusPoints.length > 0 && campusPoints.length < 3 ? (
          <div className="mt-4">
            <InfoNote>再加 {3 - campusPoints.length} 个点才能拟合（6 参数仿射至少要 3 个不共线的点）。</InfoNote>
          </div>
        ) : null}

        {fit ? (
          <div className="mt-4 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg bg-page p-3">
                <p className="text-label text-sub">新拟合残差</p>
                <p className="mt-1 text-body text-ink tabular-nums">
                  平均 {fit.mean.toFixed(1)} m · 最大 {fit.max.toFixed(1)} m
                </p>
              </div>
              <div className="rounded-lg bg-page p-3">
                <p className="text-label text-sub">线上参数在这些点上的残差</p>
                <p className="mt-1 text-body text-ink tabular-nums">
                  平均 {fit.currentMean.toFixed(1)} m · 最大 {fit.currentMax.toFixed(1)} m
                </p>
              </div>
            </div>
            <p className="text-aux text-sub">
              残差是控制点自身的打点噪声，不等于变换的精度；但如果某一个点明显大于其余点，
              那一对大概率标错了，删掉重标。两栏对比能看出这批点相对线上参数是好是坏。
            </p>
            <div>
              <div className="flex items-center justify-between">
                <p className="text-label text-sub">
                  粘贴进 src/lib/release/mapData.ts 与 miniprogram/miniprogram/lib/release/mapData.ts 的 geoTransform
                </p>
                <GhostButton
                  onClick={() => {
                    void navigator.clipboard.writeText(formatTransform(fit.transform));
                    setNotice("参数已复制。三处硬编码（含 data/geo-transform.json）都要同步。");
                  }}
                >
                  <Copy size={14} />
                  复制
                </GhostButton>
              </div>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-page p-3 text-aux text-ink">
{formatTransform(fit.transform)}
              </pre>
            </div>
          </div>
        ) : null}

        {points.length > 0 ? (
          <div className="mt-4 flex items-center gap-3">
            <GhostButton
              danger
              onClick={() => {
                if (window.confirm(`清空全部 ${points.length} 个控制点？导出过的 JSON 不受影响。`)) {
                  setPoints([]);
                  setNotice("已清空。");
                }
              }}
            >
              <Trash2 size={14} />
              清空全部
            </GhostButton>
            <span className="text-aux text-sub">
              三校区共 {points.length} 个控制点，存在浏览器本地；换机器或清缓存前记得导出。
            </span>
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
