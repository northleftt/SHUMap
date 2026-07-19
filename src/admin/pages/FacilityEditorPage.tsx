import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import * as admin from "../../lib/api/admin";
import type { FacilityListItem, PlaceListItem, ReferenceDataResponse, SpacesResponse } from "../adminTypes";
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
// A11 设施编辑器（无详情接口：从列表项初始化，修订历史暂不可查）
// ---------------------------------------------------------------------------

export function FacilityEditorPage() {
  const { id = "" } = useParams();
  const isNew = id === "new";
  const navigate = useNavigate();

  const { state } = useAsyncData(async (signal) => {
    const [ref, spaces, places, facilities] = await Promise.all([
      admin.listReferenceData<ReferenceDataResponse>(signal),
      admin.listSpaces<SpacesResponse>(signal),
      admin.listAdminPlaces<PlaceListItem>(signal),
      isNew ? Promise.resolve({ items: [] as FacilityListItem[] }) : admin.listFacilities<FacilityListItem>(signal),
    ]);
    return { ref, spaces, places: places.items, facilities: facilities.items };
  }, [id, isNew]);

  const [name, setName] = useState("");
  const [typeId, setTypeId] = useState("");
  const [hostPlaceId, setHostPlaceId] = useState("");
  const [floorId, setFloorId] = useState("");
  const [hours, setHours] = useState("");
  const [fee, setFee] = useState("");
  const [locationText, setLocationText] = useState("");
  const [note, setNote] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (state.status !== "ready" || isNew) return;
    const item = state.data!.facilities.find((f) => f.id === id);
    if (!item) return;
    setName(String(item.displayName ?? ""));
    setTypeId(String(item.facilityTypeId ?? ""));
    setHostPlaceId(item.hostPlaceId ? String(item.hostPlaceId) : "");
    setFloorId(item.floorId ? String(item.floorId) : "");
  }, [state, id, isNew]);

  if (state.status === "loading") return <LoadingState label="加载设施…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const data = state.data!;
  const item = isNew ? null : data.facilities.find((f) => f.id === id) ?? null;
  const floors = data.spaces.floors.filter((f) => !hostPlaceId || f.buildingPlaceId === hostPlaceId);

  async function save(thenSubmit: boolean) {
    if (!name.trim()) { setError("请填写名称"); return; }
    if (isNew && !typeId) { setError("请选择设施类型"); return; }
    setBusy(true);
    setError("");
    const content = {
      ...(fee.trim() ? { fee: fee.trim() } : {}),
      ...(locationText.trim() ? { locationDescription: locationText.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    try {
      let revisionId = "";
      if (isNew) {
        const created = await admin.createFacility({
          facilityTypeId: typeId,
          hostPlaceId: hostPlaceId || undefined,
          floorId: floorId || undefined,
          displayName: name.trim(),
          serviceHours: hours.trim() ? { text: hours.trim() } : undefined,
          content,
          sourceId: sourceId || undefined,
        });
        revisionId = created.id;
        // createFacility 返回实例 id；草稿修订需经列表取 currentRevisionId 提交
        if (thenSubmit) {
          const list = await admin.listFacilities<FacilityListItem>();
          const created2 = list.items.find((f) => f.id === created.id);
          revisionId = String(created2?.currentRevisionId ?? "");
        }
      } else {
        const created = await admin.createFacilityRevision(id, {
          displayName: name.trim(),
          serviceHours: hours.trim() ? { text: hours.trim() } : undefined,
          content,
          sourceId: sourceId || undefined,
        });
        revisionId = created.id;
      }
      if (thenSubmit && revisionId) await admin.submitRevision("facility", revisionId);
      navigate("/admin/content?tab=facilities");
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
            placeholder="设施名称"
            value={name}
          />
          {item ? <EditorialPill status={item.editorialStatus} /> : null}
        </div>
        <div className="space-y-4 p-5">
          <div>
            <p className="mb-3 text-emphasis">挂接位置</p>
            <div className="grid grid-cols-2 gap-3">
              <SelectField
                label="设施类型"
                onChange={setTypeId}
                options={data.ref.facilityTypes.map((t) => ({ value: t.id, label: t.name }))}
                placeholder="选择类型"
                value={typeId}
              />
              <SelectField
                label="所属楼宇"
                onChange={(v) => { setHostPlaceId(v); setFloorId(""); }}
                options={data.places.map((p) => ({ value: p.id, label: p.displayName ?? p.id }))}
                placeholder="选择楼宇"
                value={hostPlaceId}
              />
              <SelectField
                label="楼层"
                onChange={setFloorId}
                options={floors.map((f) => ({ value: f.id, label: f.displayName }))}
                placeholder={hostPlaceId ? "选择楼层" : "先选楼宇"}
                value={floorId}
              />
            </div>
          </div>
          <div>
            <p className="mb-3 text-emphasis">服务内容</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="服务时间" onChange={setHours} placeholder="如 与楼宇一致 08:00-22:00" value={hours} />
              <Field label="收费标准" onChange={setFee} placeholder="如 黑白 0.3 元/页" value={fee} />
            </div>
          </div>
          <TextArea label="位置描述（用户看到的文字引导）" onChange={setLocationText} placeholder="如 2 层服务台旁" rows={2} value={locationText} />
          <TextArea label="备注" onChange={setNote} rows={2} value={note} />
          <SelectField
            label="数据来源"
            onChange={setSourceId}
            options={data.ref.sources.map((s) => ({ value: s.id, label: s.title }))}
            placeholder="不指定"
            value={sourceId}
          />
          <ErrorBanner message={error} />
          <div className="flex gap-3">
            <GhostButton className="flex-1" disabled={busy} onClick={() => save(false)}>保存草稿</GhostButton>
            <PrimaryButton className="flex-[2]" disabled={busy} onClick={() => save(true)}>
              {busy ? "处理中…" : "提交审核 →"}
            </PrimaryButton>
          </div>
        </div>
      </Panel>

      <div className="space-y-4 self-start">
        <Panel title="服务位置">
          <InfoNote>
            设施实例 = facility_instances（楼宇 + 楼层 + 空间）；位置锚点 role = service_position；无平面图阶段仅文字引导。
          </InfoNote>
        </Panel>
        <Panel title="修订历史">
          <InfoNote tone="warning">
            设施详情接口暂未提供修订列表；保存草稿 / 提交审核后可在审核中心处理。
          </InfoNote>
        </Panel>
      </div>
    </div>
  );
}
