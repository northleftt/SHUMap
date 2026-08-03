import { Building2, Check, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import * as admin from "../../lib/api/admin";
import type { OrganizationRow } from "../../lib/api/admin";
import { ApiError } from "../../lib/api/client";
import {
  Chip,
  EmptyState,
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

// ---------------------------------------------------------------------------
// 品牌与机构管理。商户的「所属品牌」、数据来源的提供方、楼宇的管理单位、
// 运营事件的责任方、校车线路的运营方都从这里取。
//
// 「不要某个品牌了」分两种情况：
//   · 还有内容引用 → 只能停用。停用后不再出现在新建时的可选项里，既有关联照常。
//   · 没有任何引用 → 可以直接删除。
// ---------------------------------------------------------------------------

const ERROR_TEXT: Record<string, string> = {
  organization_in_use: "这个品牌 / 机构还有内容在引用，不能删除。可以先把它停用，停用后不再出现在新建时的可选项里。",
  validation_error: "填写的内容不完整或不正确，请检查后重试。",
  forbidden: "当前账号没有维护品牌与机构的权限。",
  unauthorized: "登录状态已失效，请重新登录。",
  not_found: "这个品牌 / 机构不存在，可能已被其他人改动，刷新后再试。",
};

function orgError(err: unknown, defaultMessage: string): string {
  if (err instanceof ApiError) return ERROR_TEXT[err.code] ?? defaultMessage;
  return errorMessage(err, defaultMessage);
}

/** 类型的中文名在这里定；接口给的是英文键，没收录的直接显示原值。 */
const KIND_LABELS: Record<string, string> = {
  department: "校内部门",
  school: "院系",
  company: "企业",
  vendor: "商户品牌",
  government: "政府机构",
  operator: "运营单位",
  other: "其他",
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

const USAGE_LABELS: Array<{ key: keyof OrganizationRow["usage"]; label: string }> = [
  { key: "merchants", label: "商户" },
  { key: "buildings", label: "楼宇" },
  { key: "events", label: "运营事件" },
  { key: "transit", label: "校车线路" },
  { key: "sources", label: "数据来源" },
];

function usageTotal(row: OrganizationRow): number {
  return USAGE_LABELS.reduce((sum, item) => sum + row.usage[item.key], 0);
}

function usageText(row: OrganizationRow): string {
  const parts = USAGE_LABELS.filter((item) => row.usage[item.key] > 0).map(
    (item) => `${row.usage[item.key]} 个${item.label}`,
  );
  return parts.length ? `被 ${parts.join(" · ")} 引用` : "暂无引用";
}

export function OrganizationsPage() {
  const { state, reload } = useAsyncData((signal) => admin.listOrganizations(signal), []);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("all");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState("");
  const [editingId, setEditingId] = useState("");
  const [editName, setEditName] = useState("");
  const [editKind, setEditKind] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState("");

  if (state.status === "loading") return <LoadingState label="加载品牌与机构…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const data = state.data!;

  const kindOptions = data.kinds.map((kind) => ({ value: kind, label: kindLabel(kind) }));
  const countOf = (key: string) => {
    if (key === "active") return data.items.filter((item) => item.status === "active").length;
    if (key === "retired") return data.items.filter((item) => item.status === "retired").length;
    if (key === "empty") return data.items.filter((item) => usageTotal(item) === 0).length;
    return data.items.length;
  };
  const visible = data.items.filter((item) => {
    if (filter === "active") return item.status === "active";
    if (filter === "retired") return item.status === "retired";
    if (filter === "empty") return usageTotal(item) === 0;
    return true;
  });
  const filters = [
    { key: "all", label: "全部" },
    { key: "active", label: "启用中" },
    { key: "retired", label: "已停用" },
    { key: "empty", label: "可删除" },
  ];

  async function mutate(action: () => Promise<unknown>, failureMessage: string) {
    setBusy(true);
    setError("");
    try {
      await action();
      reload();
    } catch (reason) {
      setError(orgError(reason, failureMessage));
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!newName.trim() || !newKind) {
      setError("请填写名称并选择类型");
      return;
    }
    await mutate(() => admin.createOrganization({ name: newName.trim(), kind: newKind }), "新增失败");
    setCreating(false);
    setNewName("");
    setNewKind("");
  }

  return (
    <div className="space-y-4">
      <ErrorBanner message={error} />

      <Panel
        action={
          <div className="flex flex-wrap items-center gap-2">
            {filters.map((item) => (
              <Chip active={filter === item.key} key={item.key} onClick={() => setFilter(item.key)}>
                {item.label} {countOf(item.key)}
              </Chip>
            ))}
            <PrimaryButton className="h-8" onClick={() => setCreating((value) => !value)}>
              <Plus size={15} />
              新增品牌 / 机构
            </PrimaryButton>
          </div>
        }
        title={
          <span className="inline-flex items-center gap-2">
            <Building2 size={16} className="text-sub" />
            品牌与机构
          </span>
        }
      >
        <div className="space-y-4">
          {creating ? (
            <div className="grid grid-cols-[1fr_220px_auto] items-end gap-3 rounded-xl bg-page p-4">
              <Field label="名称" onChange={setNewName} placeholder="如 蜜雪冰城" value={newName} />
              <SelectField label="类型" onChange={setNewKind} options={kindOptions} placeholder="选择类型" value={newKind} />
              <div className="flex gap-2">
                <PrimaryButton disabled={busy} onClick={() => void create()}>保存</PrimaryButton>
                <GhostButton onClick={() => setCreating(false)}>取消</GhostButton>
              </div>
            </div>
          ) : null}

          {visible.length === 0 ? (
            <EmptyState label={filter === "all" ? "暂无品牌 / 机构" : "暂无符合条件的品牌 / 机构"} />
          ) : (
            <div className="divide-y divide-line">
              {visible.map((org) => {
                const removable = usageTotal(org) === 0;
                return editingId === org.id ? (
                  <div className="grid grid-cols-[1fr_220px_auto] items-end gap-3 py-3" key={org.id}>
                    <Field label="名称" onChange={setEditName} value={editName} />
                    <SelectField label="类型" onChange={setEditKind} options={kindOptions} value={editKind} />
                    <div className="flex gap-2">
                      <GhostButton
                        disabled={busy || !editName.trim()}
                        onClick={() => void mutate(async () => {
                          await admin.updateOrganization(org.id, { name: editName.trim(), kind: editKind });
                          setEditingId("");
                        }, "保存失败")}
                      >
                        <Check size={14} />保存
                      </GhostButton>
                      <GhostButton onClick={() => setEditingId("")}>取消</GhostButton>
                    </div>
                  </div>
                ) : (
                  <div key={org.id}>
                    <div className="flex items-center gap-3 py-3">
                      <span className="min-w-0 flex-1 truncate font-medium text-ink">{org.name}</span>
                      <span className="w-24 shrink-0 text-aux text-sub">{kindLabel(org.kind)}</span>
                      <span className="w-72 shrink-0 text-aux text-sub">{usageText(org)}</span>
                      <Pill tone={org.status === "active" ? "ok" : "neutral"}>{org.status === "active" ? "启用中" : "已停用"}</Pill>
                      <button
                        aria-label={`编辑 ${org.name}`}
                        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 text-aux font-medium text-ink disabled:opacity-40"
                        disabled={busy}
                        onClick={() => { setEditingId(org.id); setEditName(org.name); setEditKind(org.kind); setConfirmDeleteId(""); }}
                        type="button"
                      >
                        <Pencil size={13} />
                        编辑
                      </button>
                      <button
                        aria-label={org.status === "active" ? `停用 ${org.name}` : `启用 ${org.name}`}
                        className={`h-8 shrink-0 rounded-lg border px-3 text-aux font-medium disabled:opacity-40 ${
                          org.status === "active" ? "border-error/40 text-error" : "border-line text-ink"
                        }`}
                        disabled={busy}
                        onClick={() => void mutate(
                          () => admin.updateOrganization(org.id, { status: org.status === "active" ? "retired" : "active" }),
                          "更新状态失败",
                        )}
                        title={org.status === "active" ? "停用后不再作为新建时的可选项，已有关联不受影响" : "重新作为可选项"}
                        type="button"
                      >
                        {org.status === "active" ? "停用" : "启用"}
                      </button>
                      <button
                        aria-label={`删除 ${org.name}`}
                        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-error/40 px-3 text-aux font-medium text-error disabled:opacity-40"
                        disabled={busy || !removable}
                        onClick={() => setConfirmDeleteId(org.id)}
                        title={removable ? "彻底删除" : "还有内容在引用，只能停用"}
                        type="button"
                      >
                        <Trash2 size={13} />
                        删除
                      </button>
                    </div>
                    {confirmDeleteId === org.id ? (
                      <div className="mb-3 rounded-lg bg-error-bg px-4 py-3">
                        <p className="text-body font-medium text-error">确认删除「{org.name}」？删除后不可恢复。</p>
                        <div className="mt-2.5 flex gap-2">
                          <button
                            className="h-8 rounded-lg bg-error px-3 text-aux font-semibold text-white disabled:opacity-40"
                            disabled={busy}
                            onClick={() => void mutate(async () => {
                              await admin.deleteOrganization(org.id);
                              setConfirmDeleteId("");
                            }, "删除失败")}
                            type="button"
                          >
                            {busy ? "删除中…" : "确认删除"}
                          </button>
                          <button
                            className="h-8 rounded-lg border border-line bg-surface px-3 text-aux font-medium text-ink"
                            disabled={busy}
                            onClick={() => setConfirmDeleteId("")}
                            type="button"
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
