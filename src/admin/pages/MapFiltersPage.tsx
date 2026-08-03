import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import * as admin from "../../lib/api/admin";
import {
  ErrorBanner,
  Field,
  GhostButton,
  LoadingState,
  Panel,
  Pill,
  PrimaryButton,
  SelectField,
  errorMessage,
  useAsyncData,
} from "../components/primitives";

type MemberTarget = "placeKind" | "facilityType" | "merchants";

export function MapFiltersPage() {
  const { state, reload } = useAsyncData((signal) => admin.listMapFilters(signal), []);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [addingCategory, setAddingCategory] = useState(false);
  const [categoryKey, setCategoryKey] = useState("");
  const [categoryLabel, setCategoryLabel] = useState("");
  const [categoryOrder, setCategoryOrder] = useState("100");
  const [editingCategoryId, setEditingCategoryId] = useState("");
  const [editCategoryLabel, setEditCategoryLabel] = useState("");
  const [editCategoryOrder, setEditCategoryOrder] = useState("100");
  const [memberCategoryId, setMemberCategoryId] = useState("");
  const [memberTarget, setMemberTarget] = useState<MemberTarget>("placeKind");
  const [memberValue, setMemberValue] = useState("");
  const [addingKind, setAddingKind] = useState(false);
  const [kindId, setKindId] = useState("");
  const [kindName, setKindName] = useState("");
  const [kindOrder, setKindOrder] = useState("100");
  const [kindCategoryId, setKindCategoryId] = useState("");
  const [editingKindId, setEditingKindId] = useState("");
  const [editKindName, setEditKindName] = useState("");
  const [editKindOrder, setEditKindOrder] = useState("100");

  if (state.status === "loading") return <LoadingState label="加载地图标签…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const data = state.data!;
  const categoryOptions = data.items.map((item) => ({ value: item.id, label: item.label }));
  const activeCategoryOptions = data.items.filter((item) => item.active).map((item) => ({ value: item.id, label: item.label }));
  const categoryById = new Map(data.items.map((item) => [item.id, item]));
  const kindCategoryLabel = (categoryId: string | null): string => {
    if (categoryId === null) return "未归属";
    const category = categoryById.get(categoryId);
    if (!category) throw new Error(`地点类型引用了不存在的地图标签：${categoryId}`);
    return category.label;
  };
  const unassignedTargets = memberTarget === "placeKind"
    ? data.unassigned.placeKinds
    : memberTarget === "facilityType"
      ? data.unassigned.facilityTypes
      : [];

  async function mutate(action: () => Promise<unknown>, failureMessage: string) {
    setBusy(true);
    setError("");
    try {
      await action();
      reload();
    } catch (reason) {
      setError(errorMessage(reason, failureMessage));
    } finally {
      setBusy(false);
    }
  }

  async function createCategory() {
    if (!categoryKey.trim() || !categoryLabel.trim()) {
      setError("请填写标签键和名称");
      return;
    }
    await mutate(
      () => admin.createMapFilter({
        key: categoryKey.trim(),
        label: categoryLabel.trim(),
        sortOrder: Number(categoryOrder),
      }),
      "新增标签失败",
    );
    setAddingCategory(false);
    setCategoryKey("");
    setCategoryLabel("");
  }

  async function addMember(categoryId: string) {
    if (memberTarget !== "merchants" && !memberValue) {
      setError("请选择成员");
      return;
    }
    const body = memberTarget === "placeKind"
      ? { placeKindId: memberValue }
      : memberTarget === "facilityType"
        ? { facilityTypeId: memberValue }
        : { includesMerchants: true as const };
    await mutate(() => admin.createMapFilterMember(categoryId, body), "添加成员失败");
    setMemberCategoryId("");
    setMemberValue("");
  }

  async function createKind() {
    if (!kindId.trim() || !kindName.trim() || !kindCategoryId) {
      setError("请填写地点类型 ID、名称并选择归属标签");
      return;
    }
    await mutate(
      () => admin.createPlaceKind({
        id: kindId.trim(),
        name: kindName.trim(),
        sortOrder: Number(kindOrder),
        isSearchable: true,
        categoryId: kindCategoryId,
      }),
      "新增地点类型失败",
    );
    setAddingKind(false);
    setKindId("");
    setKindName("");
    setKindCategoryId("");
  }

  return (
    <div className="space-y-4">
      <ErrorBanner message={error} />

      <Panel
        title="地图标签"
        action={<GhostButton onClick={() => setAddingCategory((value) => !value)}><Plus size={14} />新增标签</GhostButton>}
      >
        <div className="space-y-4">
          {addingCategory ? (
            <div className="grid grid-cols-[1fr_1fr_120px_auto] items-end gap-3 rounded-xl bg-page p-4">
              <Field label="键" onChange={setCategoryKey} placeholder="dining" value={categoryKey} />
              <Field label="名称" onChange={setCategoryLabel} placeholder="餐饮" value={categoryLabel} />
              <Field label="排序" onChange={setCategoryOrder} type="number" value={categoryOrder} />
              <div className="flex gap-2"><PrimaryButton disabled={busy} onClick={() => void createCategory()}>保存</PrimaryButton><GhostButton onClick={() => setAddingCategory(false)}>取消</GhostButton></div>
            </div>
          ) : null}

          <div className="space-y-3">
            {data.items.map((category) => (
              <div className="rounded-xl border border-line p-4" key={category.id}>
                {editingCategoryId === category.id ? (
                  <div className="grid grid-cols-[1fr_120px_auto] items-end gap-3">
                    <Field label="名称" onChange={setEditCategoryLabel} value={editCategoryLabel} />
                    <Field label="排序" onChange={setEditCategoryOrder} type="number" value={editCategoryOrder} />
                    <div className="flex gap-2">
                      <GhostButton disabled={busy} onClick={() => void mutate(async () => {
                        await admin.updateMapFilter(category.id, { label: editCategoryLabel.trim(), sortOrder: Number(editCategoryOrder) });
                        setEditingCategoryId("");
                      }, "保存标签失败")}><Check size={14} />保存</GhostButton>
                      <GhostButton onClick={() => setEditingCategoryId("")}><X size={14} /></GhostButton>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <span className="font-semibold text-ink">{category.label}</span>
                    <code className="text-aux text-sub">{category.key}</code>
                    <span className="text-aux text-sub">排序 {category.sortOrder}</span>
                    <span className="flex-1" />
                    <Pill tone={category.active ? "ok" : "neutral"}>{category.active ? "启用" : "停用"}</Pill>
                    <GhostButton onClick={() => { setEditingCategoryId(category.id); setEditCategoryLabel(category.label); setEditCategoryOrder(String(category.sortOrder)); }}><Pencil size={14} />编辑</GhostButton>
                    <GhostButton disabled={busy} onClick={() => void mutate(() => admin.updateMapFilter(category.id, { active: !category.active }), "更新状态失败")}>{category.active ? "停用" : "启用"}</GhostButton>
                    <GhostButton danger disabled={busy || category.members.length > 0} onClick={() => void mutate(() => admin.deleteMapFilter(category.id), "删除标签失败")}><Trash2 size={14} />删除</GhostButton>
                  </div>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  {category.members.map((member) => (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-page py-1 pl-3 pr-1 text-aux" key={member.id}>
                      {member.targetLabel}
                      <select
                        aria-label="移动成员"
                        className="rounded border border-line bg-surface px-1 py-0.5"
                        disabled={busy}
                        onChange={(event) => void mutate(() => admin.updateMapFilterMember(member.id, { categoryId: event.target.value }), "移动成员失败")}
                        value={category.id}
                      >
                        {categoryOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                      <button aria-label={`删除 ${member.targetLabel}`} className="grid h-6 w-6 place-items-center rounded-full text-sub hover:bg-line" disabled={busy} onClick={() => void mutate(() => admin.deleteMapFilterMember(member.id), "删除成员失败")} type="button"><X size={13} /></button>
                    </span>
                  ))}
                  {category.members.length === 0 ? <span className="text-aux text-sub">暂无成员</span> : null}
                </div>

                {memberCategoryId === category.id ? (
                  <div className="mt-3 grid grid-cols-[140px_1fr_auto] items-end gap-2 rounded-lg bg-page p-3">
                    <SelectField
                      label="成员类型"
                      onChange={(value) => { setMemberTarget(value as MemberTarget); setMemberValue(""); }}
                      options={[{ value: "placeKind", label: "地点类型" }, { value: "facilityType", label: "设施类型" }, { value: "merchants", label: "包含商户" }]}
                      value={memberTarget}
                    />
                    {memberTarget === "merchants" ? <div className="pb-2 text-body text-sub">将包含商户的楼宇纳入此标签</div> : (
                      <SelectField label="成员" onChange={setMemberValue} options={unassignedTargets.map((row) => ({ value: row.id, label: row.name }))} placeholder="选择成员" value={memberValue} />
                    )}
                    <div className="flex gap-2"><PrimaryButton disabled={busy || (memberTarget === "merchants" && !data.unassigned.includesMerchants)} onClick={() => void addMember(category.id)}>添加</PrimaryButton><GhostButton onClick={() => setMemberCategoryId("")}>取消</GhostButton></div>
                  </div>
                ) : (
                  <button className="mt-3 text-aux font-medium text-primary" onClick={() => { setMemberCategoryId(category.id); setMemberValue(""); }} type="button">+ 添加成员</button>
                )}
              </div>
            ))}
          </div>
        </div>
      </Panel>

      <Panel
        title="地点类型"
        action={<GhostButton onClick={() => setAddingKind((value) => !value)}><Plus size={14} />新增地点类型</GhostButton>}
      >
        <div className="space-y-3">
          {addingKind ? (
            <div className="grid grid-cols-[1fr_1fr_100px_1fr_auto] items-end gap-3 rounded-xl bg-page p-4">
              <Field label="ID" onChange={setKindId} placeholder="library" value={kindId} />
              <Field label="名称" onChange={setKindName} placeholder="图书馆" value={kindName} />
              <Field label="排序" onChange={setKindOrder} type="number" value={kindOrder} />
              <SelectField label="归属标签" onChange={setKindCategoryId} options={activeCategoryOptions} placeholder="选择标签" value={kindCategoryId} />
              <div className="flex gap-2"><PrimaryButton disabled={busy || !kindCategoryId} onClick={() => void createKind()}>保存</PrimaryButton><GhostButton onClick={() => setAddingKind(false)}>取消</GhostButton></div>
            </div>
          ) : null}
          <div className="divide-y divide-line">
            {data.placeKinds.map((kind) => editingKindId === kind.id ? (
              <div className="grid grid-cols-[1fr_120px_auto] items-end gap-3 py-3" key={kind.id}>
                <Field label="名称" onChange={setEditKindName} value={editKindName} />
                <Field label="排序" onChange={setEditKindOrder} type="number" value={editKindOrder} />
                <div className="flex gap-2"><GhostButton disabled={busy} onClick={() => void mutate(async () => { await admin.updatePlaceKind(kind.id, { name: editKindName.trim(), sortOrder: Number(editKindOrder) }); setEditingKindId(""); }, "保存地点类型失败")}><Check size={14} />保存</GhostButton><GhostButton onClick={() => setEditingKindId("")}><X size={14} /></GhostButton></div>
              </div>
            ) : (
              <div className="flex items-center gap-3 py-3" key={kind.id}>
                <span className="w-40 font-medium text-ink">{kind.name}</span>
                <code className="w-32 text-aux text-sub">{kind.id}</code>
                <span className="flex-1 text-aux text-sub">排序 {kind.sortOrder} · {kind.placeCount} 个地点 · {kindCategoryLabel(kind.categoryId)}</span>
                <GhostButton onClick={() => { setEditingKindId(kind.id); setEditKindName(kind.name); setEditKindOrder(String(kind.sortOrder)); }}><Pencil size={14} />编辑</GhostButton>
                <GhostButton danger disabled={busy || kind.placeCount > 0} onClick={() => void mutate(() => admin.deletePlaceKind(kind.id), "删除地点类型失败")}><Trash2 size={14} />删除</GhostButton>
              </div>
            ))}
          </div>
        </div>
      </Panel>
    </div>
  );
}
