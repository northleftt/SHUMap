import { KeyRound, UserPlus } from "lucide-react";
import { useState } from "react";
import * as admin from "../../lib/api/admin";
import { ApiError } from "../../lib/api/client";
import type { AccountRoleOption, AccountRow } from "../adminTypes";
import { useAuth } from "../AuthContext";
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
  fmtDateTime,
  useAsyncData,
} from "../components/primitives";
import type { Tone } from "../components/primitives";

// ---------------------------------------------------------------------------
// 账户管理：账户列表 + 新建账户 + 行内启停 / 改角色 / 重置密码
// ---------------------------------------------------------------------------

/** 接口返回的提示是英文的，按错误码翻成给管理员看的中文。 */
const ERROR_TEXT: Record<string, string> = {
  email_taken: "这个邮箱已经有账户了，换一个再试。",
  weak_password: "密码太短，至少需要 12 位。",
  validation_error: "填写的内容不完整或不正确，请检查后重试。",
  role_not_assignable: "超级管理员不能在这里分配。",
  self_disable_forbidden: "不能停用自己的账户。",
  self_role_change_forbidden: "不能修改自己的角色。",
  last_owner_protected: "系统里必须保留一位可用的超级管理员，这个账户不能停用或降级。",
  forbidden: "当前账号没有管理账户的权限。",
  unauthorized: "登录状态已失效，请重新登录。",
  not_found: "账户不存在，可能已被其他人改动，刷新后再试。",
};

function accountError(err: unknown, defaultMessage: string): string {
  if (err instanceof ApiError) {
    const mapped = ERROR_TEXT[err.code];
    if (mapped) return mapped;
    return defaultMessage;
  }
  return errorMessage(err, defaultMessage);
}

const ROLE_LABELS: Record<string, string> = {
  owner: "超级管理员",
  volunteer: "志愿者",
  viewer: "只读成员",
  content_editor: "内容编辑",
  map_editor: "地图编辑",
  transit_editor: "校车编辑",
  reviewer: "审核员",
  publisher: "发布负责人",
};

const ROLE_TONE: Record<string, Tone> = {
  owner: "error",
  volunteer: "info",
};

const MIN_PASSWORD_LENGTH = 12;

function roleLabel(id: string, roles: AccountRoleOption[]): string {
  return ROLE_LABELS[id] ?? roles.find((role) => role.id === id)?.name ?? id;
}

function RolePills({ ids, roles }: { ids: string[]; roles: AccountRoleOption[] }) {
  if (!ids.length) return <span className="text-aux text-sub">未分配</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {ids.map((id) => (
        <Pill key={id} tone={ROLE_TONE[id] ?? "neutral"}>
          {roleLabel(id, roles)}
        </Pill>
      ))}
    </span>
  );
}

/** 密码输入框。primitives 的 Field 不带受控密码语义，这里单独包一层。 */
function PasswordField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-label text-sub">{label}</span>
      <input
        autoComplete="new-password"
        className="h-9 w-full rounded-lg border border-line bg-surface px-3 text-body text-ink outline-none placeholder:text-sub focus:border-primary"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type="password"
        value={value}
      />
    </label>
  );
}

function CreateForm({
  roles,
  onCreated,
}: {
  roles: AccountRoleOption[];
  onCreated: () => void;
}) {
  const assignable = roles.filter((role) => role.assignable);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [roleId, setRoleId] = useState(assignable.some((r) => r.id === "volunteer") ? "volunteer" : assignable[0]?.id ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready =
    email.trim().length > 0 &&
    displayName.trim().length > 0 &&
    roleId.length > 0 &&
    password.length >= MIN_PASSWORD_LENGTH &&
    confirm === password;

  async function submit() {
    setBusy(true);
    setError("");
    setDone("");
    try {
      const created = await admin.createAdminUser({
        email: email.trim(),
        displayName: displayName.trim(),
        password,
        roleId,
      });
      setDone(`已创建账户 ${created.displayName}`);
      setEmail("");
      setDisplayName("");
      setPassword("");
      setConfirm("");
      onCreated();
    } catch (err) {
      setError(accountError(err, "创建失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title={roleId === "volunteer" ? "加入志愿者名单" : "新建账户"}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="邮箱" onChange={setEmail} placeholder="name@example.com" type="email" value={email} />
        <Field label="姓名" onChange={setDisplayName} placeholder="真实姓名或昵称" value={displayName} />
        <SelectField
          label="角色"
          onChange={setRoleId}
          options={assignable.map((role) => ({ value: role.id, label: roleLabel(role.id, roles) }))}
          value={roleId}
        />
        <div />
        <PasswordField label="初始密码" onChange={setPassword} placeholder={`至少 ${MIN_PASSWORD_LENGTH} 位`} value={password} />
        <PasswordField label="确认密码" onChange={setConfirm} placeholder="再输入一次" value={confirm} />
      </div>
      <p className="mt-3 text-label text-sub">
        初始密码至少 {MIN_PASSWORD_LENGTH} 位，请通过安全渠道告知本人，并提醒尽快自行更换。
      </p>
      {tooShort ? <p className="mt-2 text-aux text-warning">密码还不够长，至少需要 {MIN_PASSWORD_LENGTH} 位。</p> : null}
      {mismatch ? <p className="mt-2 text-aux text-warning">两次输入的密码不一致。</p> : null}
      {error ? <div className="mt-3"><ErrorBanner message={error} /></div> : null}
      {done ? <p className="mt-3 rounded-lg bg-success-bg px-4 py-3 text-body font-medium text-success">{done}</p> : null}
      <div className="mt-4">
        <PrimaryButton disabled={!ready || busy} onClick={submit}>
          <UserPlus size={16} />
          {busy ? "创建中…" : "创建账户"}
        </PrimaryButton>
      </div>
    </Panel>
  );
}

function ResetPasswordDialog({
  user,
  onClose,
  onDone,
}: {
  user: AccountRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const ready = password.length >= MIN_PASSWORD_LENGTH && confirm === password;

  async function submit() {
    setBusy(true);
    setError("");
    try {
      await admin.updateAdminUser(user.id, { password });
      onDone();
      onClose();
    } catch (err) {
      setError(accountError(err, "重置失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-8" role="presentation">
      <div className="w-[420px] rounded-xl bg-surface p-6 shadow-card" role="dialog" aria-modal="true" aria-label="重置密码">
        <p className="text-emphasis">重置密码</p>
        <p className="mt-1.5 text-aux text-sub">
          {user.displayName} · {user.email}
        </p>
        <div className="mt-5 space-y-4">
          <PasswordField label="新密码" onChange={setPassword} placeholder={`至少 ${MIN_PASSWORD_LENGTH} 位`} value={password} />
          <PasswordField label="确认新密码" onChange={setConfirm} placeholder="再输入一次" value={confirm} />
          {confirm.length > 0 && confirm !== password ? (
            <p className="text-aux text-warning">两次输入的密码不一致。</p>
          ) : null}
          <p className="text-label text-sub">重置后该账户当前的登录状态会失效，需要用新密码重新登录。</p>
          <ErrorBanner message={error} />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <GhostButton disabled={busy} onClick={onClose}>
            取消
          </GhostButton>
          <PrimaryButton disabled={!ready || busy} onClick={submit}>
            {busy ? "提交中…" : "确认重置"}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

function UserRow({
  user,
  roles,
  isSelf,
  onChanged,
  onResetPassword,
}: {
  user: AccountRow;
  roles: AccountRoleOption[];
  isSelf: boolean;
  onChanged: () => void;
  onResetPassword: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editingRole, setEditingRole] = useState(false);
  const assignable = roles.filter((role) => role.assignable);
  const isOwner = user.roles.includes("owner");
  const isVolunteer = user.roles.includes("volunteer");
  const active = user.status === "active";

  async function patch(body: { status?: "active" | "disabled"; roleId?: string }) {
    setBusy(true);
    setError("");
    try {
      await admin.updateAdminUser(user.id, body);
      setEditingRole(false);
      onChanged();
    } catch (err) {
      setError(accountError(err, "操作失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className="border-t border-line align-top">
      <td className="px-4 py-3">
        <p className="text-body font-medium text-ink">
          {user.displayName}
          {isSelf ? <span className="ml-2 text-label text-sub">（当前登录）</span> : null}
        </p>
        <p className="mt-0.5 text-aux text-sub">{user.email}</p>
        {error ? <p className="mt-1.5 text-label text-error">{error}</p> : null}
      </td>
      <td className="px-4 py-3">
        {editingRole ? (
          <div className="w-[168px]">
            <SelectField
              disabled={busy}
              onChange={(value) => void patch({ roleId: value })}
              options={assignable.map((role) => ({ value: role.id, label: roleLabel(role.id, roles) }))}
              placeholder="选择新角色"
              value=""
            />
          </div>
        ) : (
          <RolePills ids={user.roles} roles={roles} />
        )}
      </td>
      <td className="px-4 py-3">
        <Pill tone={active ? "ok" : "neutral"}>{active ? "启用中" : "已停用"}</Pill>
      </td>
      <td className="px-4 py-3 text-aux text-sub">{fmtDateTime(user.createdAt)}</td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap justify-end gap-2">
          <button
            className="h-8 rounded-lg border border-line px-3 text-aux font-medium text-ink disabled:opacity-40"
            disabled={busy || isSelf || isOwner}
            onClick={() => setEditingRole((value) => !value)}
            title={isOwner ? "超级管理员的角色不在此处调整" : isSelf ? "不能修改自己的角色" : "更换角色"}
            type="button"
          >
            {editingRole ? "取消" : isVolunteer ? "调整权限" : "改角色"}
          </button>
          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-aux font-medium text-ink disabled:opacity-40"
            disabled={busy}
            onClick={onResetPassword}
            type="button"
          >
            <KeyRound size={13} />
            重置密码
          </button>
          {active ? (
            <button
              className="h-8 rounded-lg border border-error/40 px-3 text-aux font-medium text-error disabled:opacity-40"
              disabled={busy || isSelf}
              onClick={() => void patch({ status: "disabled" })}
              title={isSelf ? "不能停用自己的账户" : "停用后无法登录"}
              type="button"
            >
              {isVolunteer ? "移出名单" : "停用"}
            </button>
          ) : (
            <button
              className="h-8 rounded-lg border border-line px-3 text-aux font-medium text-ink disabled:opacity-40"
              disabled={busy}
              onClick={() => void patch({ status: "active" })}
              type="button"
            >
              {isVolunteer ? "加入名单" : "启用"}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

export function UsersPage() {
  const { auth } = useAuth();
  const { state, reload } = useAsyncData((signal) => admin.listAdminUsers(signal), []);
  const [filter, setFilter] = useState("all");
  const [resetting, setResetting] = useState<AccountRow | null>(null);
  const [notice, setNotice] = useState("");

  if (state.status === "loading") return <LoadingState label="加载账户…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const data = state.data!;
  const roles = data.roles;

  const countOf = (key: string) => {
    if (key === "all") return data.items.length;
    if (key === "active" || key === "disabled") return data.items.filter((u) => u.status === key).length;
    return data.items.filter((u) => u.roles.includes(key)).length;
  };
  const visible = data.items.filter((user) => {
    if (filter === "all") return true;
    if (filter === "active" || filter === "disabled") return user.status === filter;
    return user.roles.includes(filter);
  });

  const filters: Array<{ key: string; label: string }> = [
    { key: "all", label: "全部" },
    { key: "active", label: "启用中" },
    { key: "disabled", label: "已停用" },
    { key: "volunteer", label: "志愿者" },
  ];

  return (
    <div className="space-y-4">
      {notice ? (
        <p className="rounded-lg bg-success-bg px-4 py-3 text-body font-medium text-success">{notice}</p>
      ) : null}

      <CreateForm
        onCreated={() => {
          setNotice("");
          reload();
        }}
        roles={roles}
      />

      <Panel
        action={
          <div className="flex gap-2">
            {filters.map((item) => (
              <Chip active={filter === item.key} key={item.key} onClick={() => setFilter(item.key)}>
                {item.label} {countOf(item.key)}
              </Chip>
            ))}
          </div>
        }
        padded={false}
        title="账户列表"
      >
        {visible.length === 0 ? (
          <div className="p-5">
            <EmptyState label="没有符合条件的账户" />
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left text-label text-sub">
                <th className="px-4 pb-2 pt-3 font-medium">成员</th>
                <th className="px-4 pb-2 pt-3 font-medium">角色</th>
                <th className="px-4 pb-2 pt-3 font-medium">状态</th>
                <th className="px-4 pb-2 pt-3 font-medium">加入时间</th>
                <th className="px-4 pb-2 pt-3 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((user) => (
                <UserRow
                  isSelf={user.id === auth?.user.id}
                  key={user.id}
                  onChanged={() => {
                    setNotice("");
                    reload();
                  }}
                  onResetPassword={() => setResetting(user)}
                  roles={roles}
                  user={user}
                />
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {resetting ? (
        <ResetPasswordDialog
          onClose={() => setResetting(null)}
          onDone={() => {
            setNotice("密码已重置，该账户需要用新密码重新登录。");
            reload();
          }}
          user={resetting}
        />
      ) : null}
    </div>
  );
}
