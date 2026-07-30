import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import * as admin from "../../lib/api/admin";
import type { MerchantMenuItem } from "../../lib/types";
import type { MerchantDetailResponse, MerchantListItem, PlaceListItem, ReferenceDataResponse, SpacesResponse } from "../adminTypes";
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
  TextArea,
  errorMessage,
  useAsyncData,
} from "../components/primitives";

/** content_json.menu 的宽松解析：只保留有名称的条目，价格/描述可空。 */
function parseMenu(value: unknown): MerchantMenuItem[] {
  if (!Array.isArray(value)) return [];
  const items: MerchantMenuItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    if (!name.trim()) continue;
    items.push({
      name,
      price: typeof record.price === "string" ? record.price : typeof record.price === "number" ? String(record.price) : "",
      description: typeof record.description === "string" ? record.description : "",
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// A12 商户编辑器（门店 outlet 表单；品牌信息由 organizations 维护）
// ---------------------------------------------------------------------------

export function MerchantEditorPage() {
  const { id = "" } = useParams();
  const isNew = id === "new";
  const navigate = useNavigate();

  const { state } = useAsyncData(async (signal) => {
    const [ref, spaces, places, merchants, detail] = await Promise.all([
      admin.listReferenceData<ReferenceDataResponse>(signal),
      admin.listSpaces<SpacesResponse>(signal),
      admin.listAdminPlaces<PlaceListItem>(signal),
      isNew ? Promise.resolve({ items: [] as MerchantListItem[] }) : admin.listMerchants<MerchantListItem>(signal),
      isNew ? Promise.resolve(null) : admin.getMerchant<MerchantDetailResponse>(id, signal),
    ]);
    return { ref, spaces, places: places.items, merchants: merchants.items, detail };
  }, [id, isNew]);

  const [name, setName] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [hostPlaceId, setHostPlaceId] = useState("");
  const [floorId, setFloorId] = useState("");
  const [businessType, setBusinessType] = useState("");
  const [openingHours, setOpeningHours] = useState("");
  const [phone, setPhone] = useState("");
  const [avgPrice, setAvgPrice] = useState("");
  const [stallCode, setStallCode] = useState("");
  const [summary, setSummary] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [menu, setMenu] = useState<MerchantMenuItem[]>([]);
  const [baseContent, setBaseContent] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (state.status !== "ready" || isNew) return;
    const item = state.data!.merchants.find((m) => m.id === id);
    if (!item) return;
    setName(String(item.displayName ?? ""));
    setHostPlaceId(item.hostPlaceId ? String(item.hostPlaceId) : "");
    setFloorId(item.floorId ? String(item.floorId) : "");
    setBusinessType(String(item.businessType ?? ""));
    setOrganizationId(item.organizationId ? String(item.organizationId) : "");
    const detail = state.data!.detail?.merchant;
    if (!detail) return;
    try {
      const opening = JSON.parse(String(detail.opening_hours_json ?? "null")) as { text?: unknown } | null;
      setOpeningHours(typeof opening?.text === "string" ? opening.text : "");
    } catch {
      setOpeningHours("");
    }
    try {
      const contact = JSON.parse(String(detail.contact_json ?? "null")) as { phone?: unknown } | null;
      setPhone(typeof contact?.phone === "string" ? contact.phone : "");
    } catch {
      setPhone("");
    }
    let content: Record<string, unknown> = {};
    try {
      content = JSON.parse(String(detail.content_json ?? "{}")) as Record<string, unknown>;
    } catch {
      content = {};
    }
    setBaseContent(content);
    setAvgPrice(typeof content.avgPrice === "string" ? content.avgPrice : "");
    setStallCode(typeof content.stallCode === "string" ? content.stallCode : "");
    setSummary(typeof content.summary === "string" ? content.summary : "");
    setMenu(parseMenu(content.menu));
    setSourceId(detail.source_id ? String(detail.source_id) : "");
  }, [state, id, isNew]);

  if (state.status === "loading") return <LoadingState label="加载商户…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const data = state.data!;
  const item = isNew ? null : data.merchants.find((m) => m.id === id) ?? null;
  const reviewLocked = item?.editorialStatus === "in_review";
  const floors = data.spaces.floors.filter((f) => !hostPlaceId || f.buildingPlaceId === hostPlaceId);

  function updateMenuItem(index: number, patch: Partial<MerchantMenuItem>) {
    setMenu((items) => items.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  }

  async function save(thenSubmit: boolean) {
    if (!name.trim()) { setError("请填写名称"); return; }
    setBusy(true);
    setError("");
    // baseContent 合并：未在表单展示的扩展字段原样保留
    const content = { ...baseContent };
    for (const [key, value] of [["avgPrice", avgPrice], ["stallCode", stallCode], ["summary", summary]] as const) {
      if (value.trim()) content[key] = value.trim();
      else delete content[key];
    }
    const menuItems = menu
      .filter((entry) => entry.name.trim())
      .map((entry) => ({
        name: entry.name.trim(),
        ...(entry.price.trim() ? { price: entry.price.trim() } : {}),
        ...(entry.description.trim() ? { description: entry.description.trim() } : {}),
      }));
    if (menuItems.length) content.menu = menuItems;
    else delete content.menu;
    try {
      let revisionId = "";
      if (isNew) {
        const created = await admin.createMerchant({
          organizationId: organizationId || undefined,
          hostPlaceId: hostPlaceId || undefined,
          floorId: floorId || undefined,
          displayName: name.trim(),
          businessType: businessType.trim() || undefined,
          openingHours: openingHours.trim() ? { text: openingHours.trim() } : undefined,
          contact: phone.trim() ? { phone: phone.trim() } : undefined,
          content,
          sourceId: sourceId || undefined,
        });
        revisionId = created.revisionId;
      } else {
        // 挂接关系先落库（即时生效），再提交正文修订（走审核）。
        await admin.updateMerchant(id, {
          organizationId: organizationId || null,
          hostPlaceId: hostPlaceId || null,
          floorId: floorId || null,
        });
        const created = await admin.createMerchantRevision(id, {
          displayName: name.trim(),
          businessType: businessType.trim() || undefined,
          openingHours: openingHours.trim() ? { text: openingHours.trim() } : undefined,
          contact: phone.trim() ? { phone: phone.trim() } : undefined,
          content,
          sourceId: sourceId || undefined,
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
          {item ? <EditorialPill status={item.editorialStatus} /> : null}
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
                onChange={(value) => { setHostPlaceId(value); setFloorId(""); }}
                options={data.places.map((p) => ({ value: p.id, label: p.displayName ?? p.id }))}
                placeholder="选择地点"
                value={hostPlaceId}
              />
              <SelectField
                label="所在楼层"
                onChange={setFloorId}
                options={floors.map((f) => ({ value: f.id, label: f.displayName }))}
                placeholder={hostPlaceId ? (floors.length ? "选择楼层" : "该地点暂无楼层") : "先选地点"}
                value={floorId}
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
          <InfoNote>品牌的统一信息（标识、连锁关系）在品牌库维护；本页编辑的是单个门店，与所在地点和楼层绑定。</InfoNote>
          {!isNew ? (
            <InfoNote tone="info">
              所属品牌、所在地点和所在楼层保存后立即生效；名称、营业时间、菜单等需提交审核通过并发布后对用户可见。
            </InfoNote>
          ) : null}
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
              <InfoNote>菜单为选填内容，提交审核并发布后在门店详情中展示。</InfoNote>
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
              <InfoNote tone="info">未填名称的条目在保存时会被丢弃；价格与描述可留空。</InfoNote>
            ) : null}
          </div>
        </Panel>
      </div>
    </div>
  );
}
