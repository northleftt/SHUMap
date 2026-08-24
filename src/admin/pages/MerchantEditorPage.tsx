import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import * as admin from "../../lib/api/admin";
import {
  arrayValue,
  jsonObject,
  nullableSingleTextObject,
  nullableString,
  objectValue,
  oneOf,
  optionalString,
  requiredString,
} from "../../lib/dataContract";
import type { MerchantMenuItem } from "../../lib/types";
import type { MerchantDetailResponse, PlaceListItem, ReferenceDataResponse, SpacesResponse } from "../adminTypes";
import {
  EditorialPill,
  ErrorBanner,
  Field,
  GhostButton,
  InfoNote,
  LoadingState,
  Panel,
  PrimaryButton,
  SelectField,
  MarkerScaleField,
  TextArea,
  errorMessage,
  useAsyncData,
} from "../components/primitives";

import { MediaPanel, readMedia, type MediaRow } from "../components/MediaPanel";
import { LocationEditor, locationDraftFromApi, locationInput, type LocationDraft } from "../components/LocationEditor";
import { markerScaleFromContent } from "../../lib/map/markerScale";
import type { MerchantContent } from "../../../shared/revision-contract";

function parseMenu(value: unknown): MerchantMenuItem[] {
  if (value === undefined) return [];
  return arrayValue(value, "merchant_revisions.content_json.menu").map((raw, index) => {
    const field = `merchant_revisions.content_json.menu[${index}]`;
    const record = objectValue(raw, field);
    return {
      name: requiredString(record.name, `${field}.name`),
      price: optionalString(record.price, `${field}.price`) ?? "",
      description: optionalString(record.description, `${field}.description`) ?? "",
    };
  });
}

interface MerchantEditorRevision {
  displayName: string;
  organizationId: string;
  hostPlaceId: string;
  floorId: string;
  indoorSpaceId: string;
  businessType: string;
  openingHours: string;
  phone: string;
  content: MerchantContent;
  media: MediaRow[];
  avgPrice: string;
  stallCode: string;
  summary: string;
  menu: MerchantMenuItem[];
  sourceId: string;
  editorialStatus: "draft" | "in_review" | "approved" | "rejected" | "superseded";
  locations: LocationDraft[];
  /** 门店营业状态。不进修订流，改完即时生效（见下方 LifecyclePanel）。 */
  lifecycleStatus: admin.MerchantLifecycle;
}

const MERCHANT_LIFECYCLES = ["planned", "active", "temporarily_closed", "retired"] as const;

const LIFECYCLE_LABELS: Record<admin.MerchantLifecycle, string> = {
  planned: "筹备中",
  active: "营业中",
  temporarily_closed: "暂停营业",
  retired: "已撤店",
};

function parseMerchantEditorRevision(response: MerchantDetailResponse): MerchantEditorRevision {
  const merchant = objectValue(response.merchant, "merchant");
  const structure = jsonObject(merchant.structure_json, "merchant_revisions.structure_json");
  const content = jsonObject(merchant.content_json, "merchant_revisions.content_json");
  const locations = arrayValue(structure.locations, "merchant_revisions.structure_json.locations")
    .map((location, index) => locationDraftFromApi(objectValue(location, `merchant_revisions.structure_json.locations[${index}]`), index));
  return {
    displayName: requiredString(merchant.display_name, "merchant_revisions.display_name"),
    organizationId: nullableString(structure.organizationId, "merchant_revisions.structure_json.organizationId") ?? "",
    hostPlaceId: nullableString(structure.hostPlaceId, "merchant_revisions.structure_json.hostPlaceId") ?? "",
    floorId: nullableString(structure.floorId, "merchant_revisions.structure_json.floorId") ?? "",
    indoorSpaceId: nullableString(structure.indoorSpaceId, "merchant_revisions.structure_json.indoorSpaceId") ?? "",
    businessType: nullableString(merchant.business_type, "merchant_revisions.business_type") ?? "",
    openingHours: nullableSingleTextObject(merchant.opening_hours_json, "merchant_revisions.opening_hours_json", "text"),
    phone: nullableSingleTextObject(merchant.contact_json, "merchant_revisions.contact_json", "phone"),
    content: content as MerchantContent,
    media: readMedia(content.media),
    avgPrice: optionalString(content.avgPrice, "merchant_revisions.content_json.avgPrice") ?? "",
    stallCode: optionalString(content.stallCode, "merchant_revisions.content_json.stallCode") ?? "",
    summary: optionalString(content.summary, "merchant_revisions.content_json.summary") ?? "",
    menu: parseMenu(content.menu),
    sourceId: nullableString(merchant.source_id, "merchant_revisions.source_id") ?? "",
    editorialStatus: oneOf(
      merchant.editorial_status,
      "merchant_revisions.editorial_status",
      ["draft", "in_review", "approved", "rejected", "superseded"] as const,
    ),
    locations,
    lifecycleStatus: oneOf(merchant.lifecycle_status, "merchant_outlets.lifecycle_status", MERCHANT_LIFECYCLES),
  };
}

// ---------------------------------------------------------------------------
// A12 商户编辑器（门店 outlet 表单；品牌信息由 organizations 维护）
// ---------------------------------------------------------------------------

/**
 * 门店能标的位置用途。
 *
 * 开在楼里的店靠上面的「所在地点 / 楼层 / 室内空间」定位，这里补的是另一半：
 * 摆在楼外的摊位、快闪车、集市档口，它们没有楼宇可挂，只能在校区图上点一个点。
 * 面积与路径类用途（impact_area / route_shape）属于运营事件，不给门店。
 * navigation_target 供导航终点用，画布选点后自动换算成 GCJ-02 经纬度。
 */
const MERCHANT_LOCATION_ROLES = ["primary_display", "main_entrance", "service_position", "navigation_target", "other"] as const;

export function MerchantEditorPage() {
  const { id = "" } = useParams();
  const isNew = id === "new";
  const navigate = useNavigate();

  const { state } = useAsyncData(async (signal) => {
    const [ref, spaces, places, detail, maps] = await Promise.all([
      admin.listReferenceData<ReferenceDataResponse>(signal),
      admin.listSpaces<SpacesResponse>(signal),
      admin.listAdminPlaces<PlaceListItem>(signal),
      isNew ? Promise.resolve(null) : admin.getMerchant<MerchantDetailResponse>(id, signal),
      admin.listMapVersions(signal),
    ]);
    return {
      ref,
      spaces,
      places: places.items,
      detail,
      editor: detail ? parseMerchantEditorRevision(detail) : null,
      maps: maps.items,
    };
  }, [id, isNew]);

  const [name, setName] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [hostPlaceId, setHostPlaceId] = useState("");
  const [floorId, setFloorId] = useState("");
  const [indoorSpaceId, setIndoorSpaceId] = useState("");
  const [businessType, setBusinessType] = useState("");
  const [openingHours, setOpeningHours] = useState("");
  const [phone, setPhone] = useState("");
  const [avgPrice, setAvgPrice] = useState("");
  const [stallCode, setStallCode] = useState("");
  const [summary, setSummary] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [menu, setMenu] = useState<MerchantMenuItem[]>([]);
  const [baseContent, setBaseContent] = useState<MerchantContent>({});
  const [markerSize, setMarkerSize] = useState(1);
  const [media, setMedia] = useState<MediaRow[]>([]);
  const [locationDrafts, setLocationDrafts] = useState<LocationDraft[]>([]);
  const [lifecycleStatus, setLifecycleStatus] = useState<admin.MerchantLifecycle>("active");
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [lifecycleNotice, setLifecycleNotice] = useState("");
  const [lifecycleError, setLifecycleError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (state.status !== "ready" || isNew) return;
    const editor = state.data!.editor;
    if (!editor) throw new Error("Merchant detail is missing");
    setName(editor.displayName);
    setHostPlaceId(editor.hostPlaceId);
    setFloorId(editor.floorId);
    setIndoorSpaceId(editor.indoorSpaceId);
    setBusinessType(editor.businessType);
    setOrganizationId(editor.organizationId);
    setOpeningHours(editor.openingHours);
    setPhone(editor.phone);
    setBaseContent(editor.content);
    setMarkerSize(markerScaleFromContent(editor.content));
    setMedia(editor.media);
    setAvgPrice(editor.avgPrice);
    setStallCode(editor.stallCode);
    setSummary(editor.summary);
    setMenu(editor.menu);
    setSourceId(editor.sourceId);
    setLocationDrafts(editor.locations);
    setLifecycleStatus(editor.lifecycleStatus);
  }, [state, id, isNew]);

  if (state.status === "loading") return <LoadingState label="加载商户…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const data = state.data!;
  const editor = data.editor;
  const reviewLocked = editor?.editorialStatus === "in_review";
  const floors = data.spaces.floors.filter((f) => !hostPlaceId || f.buildingPlaceId === hostPlaceId);
  const indoorSpaces = data.spaces.spaces.filter((space) => !floorId || space.floorId === floorId);
  // 校区跟着所在地点走：选了楼就锁在那栋楼的校区，没选楼时让用户自己在画布上切。
  const hostCampusId = data.places.find((place) => place.id === hostPlaceId)?.campusId ?? null;

  function updateMenuItem(index: number, patch: Partial<MerchantMenuItem>) {
    setMenu((items) => items.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  }

  /**
   * 营业状态即时生效，不进修订流：店今天关了就得今天在地图上关掉，等审核就晚了。
   * 与之相对，名称、菜单、位置这些要经审核，因为它们会进发布产物。
   */
  async function applyLifecycle(next: admin.MerchantLifecycle) {
    setLifecycleBusy(true);
    setLifecycleError("");
    setLifecycleNotice("");
    try {
      await admin.updateMerchantLifecycle(id, next);
      setLifecycleStatus(next);
      setLifecycleNotice(`已改为「${LIFECYCLE_LABELS[next]}」`);
    } catch (err) {
      setLifecycleError(errorMessage(err, "修改营业状态失败"));
    } finally {
      setLifecycleBusy(false);
    }
  }

  async function save(thenSubmit: boolean) {
    if (!name.trim()) { setError("请填写名称"); return; }
    if (!hostPlaceId) { setError("请选择所在地点"); return; }
    const unnamedMenuIndex = menu.findIndex((entry) => !entry.name.trim());
    if (unnamedMenuIndex !== -1) { setError(`请填写第 ${unnamedMenuIndex + 1} 个菜单条目的名称`); return; }
    setBusy(true);
    setError("");
    // baseContent 合并：未在表单展示的扩展字段原样保留
    const content = { ...baseContent };
    if (media.length) content.media = media;
    else delete content.media;
    for (const [key, value] of [["avgPrice", avgPrice], ["stallCode", stallCode], ["summary", summary]] as const) {
      if (value.trim()) content[key] = value.trim();
      else delete content[key];
    }
    const menuItems = menu.map((entry) => ({
        name: entry.name.trim(),
        ...(entry.price.trim() ? { price: entry.price.trim() } : {}),
        ...(entry.description.trim() ? { description: entry.description.trim() } : {}),
      }));
    if (menuItems.length) content.menu = menuItems;
    else delete content.menu;
    // 图钉大小：标准档不落字段；非标准写 content.marker.size。
    if (markerSize === 1) delete content.marker;
    else content.marker = { size: markerSize };
    try {
      let revisionId = "";
      if (isNew) {
        const created = await admin.createMerchant({
          displayName: name.trim(),
          businessType: businessType.trim() || null,
          openingHours: openingHours.trim() ? { text: openingHours.trim() } : null,
          contact: phone.trim() ? { phone: phone.trim() } : null,
          content,
          sourceId: sourceId || null,
          structure: {
            organizationId: organizationId || null,
            hostPlaceId,
            floorId: floorId || null,
            indoorSpaceId: indoorSpaceId || null,
            locations: locationDrafts.map(locationInput),
          },
        });
        revisionId = created.revisionId;
      } else {
        const created = await admin.createMerchantRevision(id, {
          displayName: name.trim(),
          businessType: businessType.trim() || null,
          openingHours: openingHours.trim() ? { text: openingHours.trim() } : null,
          contact: phone.trim() ? { phone: phone.trim() } : null,
          content,
          sourceId: sourceId || null,
          structure: {
            organizationId: organizationId || null,
            hostPlaceId,
            floorId: floorId || null,
            indoorSpaceId: indoorSpaceId || null,
            locations: locationDrafts.map(locationInput),
          },
        });
        revisionId = created.id;
      }
      if (thenSubmit && revisionId) await admin.submitRevision("merchant", revisionId);
      navigate("/admin/content?tab=merchants");
    } catch (err) {
      setError(errorMessage(err, "保存失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-[1fr_400px] gap-4">
      <Panel padded={false} className="self-start">
        <div className="flex items-center gap-3 p-5 pb-0">
          <input
            className="h-12 flex-1 rounded-lg border border-line px-4 text-emphasis outline-none focus:border-primary"
            onChange={(e) => setName(e.target.value)}
            placeholder="门店名称"
            value={name}
          />
          {editor ? <EditorialPill status={editor.editorialStatus} /> : null}
        </div>
        <div className="space-y-4 p-5">
          <div>
            <p className="mb-3 text-emphasis">门店信息</p>
            <div className="grid grid-cols-2 gap-3">
              <SelectField
                label="所属品牌"
                onChange={setOrganizationId}
                options={data.ref.organizations.map((o) => ({ value: o.id, label: o.name }))}
                placeholder="选择品牌 / 组织"
                value={organizationId}
              />
              <SelectField
                label="所在地点"
                onChange={(value) => { setHostPlaceId(value); setFloorId(""); setIndoorSpaceId(""); }}
                options={data.places.map((p) => ({ value: p.id, label: p.displayName ?? p.id }))}
                placeholder="选择地点"
                value={hostPlaceId}
              />
              <SelectField
                label="所在楼层"
                onChange={(value) => { setFloorId(value); setIndoorSpaceId(""); }}
                options={floors.map((f) => ({ value: f.id, label: f.displayName }))}
                placeholder={hostPlaceId ? (floors.length ? "选择楼层" : "该地点暂无楼层") : "先选地点"}
                value={floorId}
              />
              <SelectField
                label="室内空间"
                onChange={setIndoorSpaceId}
                options={indoorSpaces.map((space) => ({ value: space.id, label: space.displayName }))}
                placeholder={floorId ? "不指定" : "先选楼层"}
                value={indoorSpaceId}
              />
              <Field label="分类" onChange={setBusinessType} placeholder="如 咖啡轻食" value={businessType} />
              <Field label="营业时间" onChange={setOpeningHours} placeholder="如 08:00 - 20:00" value={openingHours} />
              <Field label="联系电话" onChange={setPhone} placeholder="如 6613 5200" value={phone} />
              <Field label="人均" onChange={setAvgPrice} placeholder="如 ¥15" value={avgPrice} />
              <Field label="档口号" onChange={setStallCode} placeholder="如 A12 档口" value={stallCode} />
            </div>
          </div>
          <TextArea label="简介" onChange={setSummary} placeholder="如 图书馆一层西侧，提供咖啡、简餐" rows={2} value={summary} />
          <SelectField
            label="数据来源"
            onChange={setSourceId}
            options={data.ref.sources.map((source) => ({ value: source.id, label: source.title }))}
            placeholder="不指定"
            value={sourceId}
          />
          <div>
            <MarkerScaleField
              onChange={setMarkerSize}
              value={markerSize}
              />
            <p className="mt-1.5 text-aux text-sub">仅对楼外图钉生效；楼内商户不出图钉。改动经审核发布后生效。</p>
          </div>
          {reviewLocked ? <InfoNote tone="warning">当前修订正在审核，处理完成后才能继续编辑。</InfoNote> : null}
          <ErrorBanner message={error} />
          <div className="flex gap-3">
            <GhostButton className="flex-1" disabled={busy || reviewLocked} onClick={() => save(false)}>保存草稿</GhostButton>
            <PrimaryButton className="flex-[2]" disabled={busy || reviewLocked} onClick={() => save(true)}>
              {busy ? "处理中…" : "提交审核 →"}
            </PrimaryButton>
          </div>
        </div>
      </Panel>

      <div className="space-y-4 self-start">
        <MediaPanel disabled={reviewLocked} media={media} onChange={setMedia} />
        <Panel
          title={`菜单 / 商品${menu.length ? `（${menu.length}）` : ""}`}
          action={
            <GhostButton
              disabled={reviewLocked}
              onClick={() => setMenu((items) => [...items, { name: "", price: "", description: "" }])}
            >
              <Plus size={14} />
              添加条目
            </GhostButton>
          }
        >
          <div className="space-y-3">
            {menu.length === 0 ? (
              <InfoNote>还没有菜单条目。</InfoNote>
            ) : (
              menu.map((entry, index) => (
                <div key={index} className="space-y-2 rounded-lg border border-line p-3">
                  <div className="flex items-start gap-2">
                    <div className="grid flex-1 grid-cols-[1fr_100px] gap-2">
                      <Field
                        onChange={(value) => updateMenuItem(index, { name: value })}
                        placeholder="条目名称，如 拿铁"
                        value={entry.name}
                      />
                      <Field
                        onChange={(value) => updateMenuItem(index, { price: value })}
                        placeholder="¥15"
                        value={entry.price}
                      />
                    </div>
                    <GhostButton
                      danger
                      disabled={reviewLocked}
                      onClick={() => setMenu((items) => items.filter((_, i) => i !== index))}
                    >
                      <Trash2 size={14} />
                    </GhostButton>
                  </div>
                  <Field
                    onChange={(value) => updateMenuItem(index, { description: value })}
                    placeholder="描述（可选）"
                    value={entry.description}
                  />
                </div>
              ))
            )}
            {menu.length > 0 ? (
              <InfoNote tone="info">每个条目都需要名称；价格与描述可留空。</InfoNote>
            ) : null}
          </div>
        </Panel>

        {/* 门店位置：开在楼里就选楼层/房间，摆在楼外（市集摊位、快闪车）就在校区图上点。 */}
        <LocationEditor
          buildingCampusId={hostCampusId}
          disabled={reviewLocked}
          entityPlaceId={hostPlaceId || null}
          mapVersions={data.maps}
          onChange={setLocationDrafts}
          roles={MERCHANT_LOCATION_ROLES}
          spaces={data.spaces}
          title="门店位置"
          value={locationDrafts}
        />

        {/* 营业状态不进修订流：店关了要能当场标记，不必等审核。改完即时生效。 */}
        {isNew ? null : (
          <Panel title="营业状态">
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {MERCHANT_LIFECYCLES.map((status) => (
                  <GhostButton
                    disabled={lifecycleBusy || status === lifecycleStatus}
                    key={status}
                    onClick={() => void applyLifecycle(status)}
                  >
                    {status === lifecycleStatus ? `当前：${LIFECYCLE_LABELS[status]}` : LIFECYCLE_LABELS[status]}
                  </GhostButton>
                ))}
              </div>
              <ErrorBanner message={lifecycleError} />
              {lifecycleNotice ? <InfoNote tone="info">{lifecycleNotice}</InfoNote> : null}
              <p className="text-label text-sub">
                「已撤店」的门店不再进入发布产物，前台地图与搜索都看不到；重新选「营业中」即可恢复。
              </p>
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}
