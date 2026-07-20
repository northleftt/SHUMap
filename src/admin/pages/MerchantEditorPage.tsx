import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import * as admin from "../../lib/api/admin";
import type { MerchantDetailResponse, MerchantListItem, PlaceListItem, ReferenceDataResponse } from "../adminTypes";
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

// ---------------------------------------------------------------------------
// A12 商户编辑器（门店 outlet 表单；品牌信息由 organizations 维护）
// ---------------------------------------------------------------------------

export function MerchantEditorPage() {
  const { id = "" } = useParams();
  const isNew = id === "new";
  const navigate = useNavigate();

  const { state } = useAsyncData(async (signal) => {
    const [ref, places, merchants, detail] = await Promise.all([
      admin.listReferenceData<ReferenceDataResponse>(signal),
      admin.listAdminPlaces<PlaceListItem>(signal),
      isNew ? Promise.resolve({ items: [] as MerchantListItem[] }) : admin.listMerchants<MerchantListItem>(signal),
      isNew ? Promise.resolve(null) : admin.getMerchant<MerchantDetailResponse>(id, signal),
    ]);
    return { ref, places: places.items, merchants: merchants.items, detail };
  }, [id, isNew]);

  const [name, setName] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [hostPlaceId, setHostPlaceId] = useState("");
  const [businessType, setBusinessType] = useState("");
  const [openingHours, setOpeningHours] = useState("");
  const [phone, setPhone] = useState("");
  const [avgPrice, setAvgPrice] = useState("");
  const [summary, setSummary] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [baseContent, setBaseContent] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (state.status !== "ready" || isNew) return;
    const item = state.data!.merchants.find((m) => m.id === id);
    if (!item) return;
    setName(String(item.displayName ?? ""));
    setHostPlaceId(item.hostPlaceId ? String(item.hostPlaceId) : "");
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
    setSummary(typeof content.summary === "string" ? content.summary : "");
    setSourceId(detail.source_id ? String(detail.source_id) : "");
  }, [state, id, isNew]);

  if (state.status === "loading") return <LoadingState label="加载商户…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const data = state.data!;
  const item = isNew ? null : data.merchants.find((m) => m.id === id) ?? null;
  const reviewLocked = item?.editorialStatus === "in_review";

  async function save(thenSubmit: boolean) {
    if (!name.trim()) { setError("请填写名称"); return; }
    setBusy(true);
    setError("");
    const content = { ...baseContent };
    for (const [key, value] of [["avgPrice", avgPrice], ["summary", summary]] as const) {
      if (value.trim()) content[key] = value.trim();
      else delete content[key];
    }
    try {
      let revisionId = "";
      if (isNew) {
        const created = await admin.createMerchant({
          organizationId: organizationId || undefined,
          hostPlaceId: hostPlaceId || undefined,
          displayName: name.trim(),
          businessType: businessType.trim() || undefined,
          openingHours: openingHours.trim() ? { text: openingHours.trim() } : undefined,
          contact: phone.trim() ? { phone: phone.trim() } : undefined,
          content,
          sourceId: sourceId || undefined,
        });
        revisionId = created.revisionId;
      } else {
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
            <p className="mb-3 text-emphasis">门店信息（merchant_outlets）</p>
            <div className="grid grid-cols-2 gap-3">
              <SelectField
                label="所属品牌"
                disabled={!isNew}
                onChange={setOrganizationId}
                options={data.ref.organizations.map((o) => ({ value: o.id, label: o.name }))}
                placeholder="选择品牌 / 组织"
                value={organizationId}
              />
              <SelectField
                label="所在地点"
                disabled={!isNew}
                onChange={setHostPlaceId}
                options={data.places.map((p) => ({ value: p.id, label: p.displayName ?? p.id }))}
                placeholder="选择地点"
                value={hostPlaceId}
              />
              <Field label="分类" onChange={setBusinessType} placeholder="如 咖啡轻食" value={businessType} />
              <Field label="营业时间" onChange={setOpeningHours} placeholder="如 08:00 - 20:00" value={openingHours} />
              <Field label="联系电话" onChange={setPhone} placeholder="如 6613 5200" value={phone} />
              <Field label="人均" onChange={setAvgPrice} placeholder="如 ¥15" value={avgPrice} />
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
          <InfoNote>品牌信息（LOGO、连锁门店）在商户库维护；本页编辑的是门店 outlet —— 与地点/楼层绑定，前端复用 POI 详情页展示。</InfoNote>
          {!isNew ? <InfoNote tone="info">所属品牌和所在地点属于门店结构字段，当前页面仅支持在新建门店时设置。</InfoNote> : null}
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
        <Panel title="菜单 / 商品">
          <InfoNote>菜单为商户的可选扩展字段（content.menu）；本轮编辑器不含菜单子表，可在简介中说明。</InfoNote>
        </Panel>
        <Panel title="修订历史">
          <InfoNote tone="info">保存时会保留当前修订中未在表单展示的扩展字段。</InfoNote>
        </Panel>
      </div>
    </div>
  );
}
