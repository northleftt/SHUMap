/*
 * ShuttleGuidePanel — 校车乘坐指南编辑器（校车时刻页的第五个分区）。
 *
 * 与返校指南（public/guide/editor.html）的关系：同一套 guide_documents 端点、
 * 同一条草稿→送审→发布→回滚流水线，只是 slug 不同（shuttle-ride）。
 * 内容形状薄得多——那份是 hubs × campuses × modes 的矩阵，这份就是一篇图文，
 * 所以编辑器只有「标题 + 一串块」，没有枢纽、没有校区、没有出行方式。
 *
 * 为什么「发布」是一个按钮而不是四步：D1 触发器要求只有 approved 版能上线
 * （见 0020 迁移的 guide_documents_publish_requires_approval），流程上必须
 * 保存→送审→批准→发布。这份内容一年改几次、由同一个人写完直接上，让他点四次
 * 只是把机制当流程用。所以「发布」在一次点击里串完四步；admin 角色本来就同时
 * 持有 write:content / review:content / publish:release 三个权限。
 * 权限不全的账号会在某一步 403，那时草稿已经存下，错误里说清停在哪一步。
 */
import { ArrowDown, ArrowUp, ImagePlus, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as admin from "../../lib/api/admin";
import {
  SHUTTLE_GUIDE_DEFAULT_TITLE,
  SHUTTLE_GUIDE_SLUG,
  emptyContent,
  newAssetKey,
  normalizeShuttleGuideContent,
  type ShuttleGuideBlock,
  type ShuttleGuideContent,
} from "../../../shared/shuttle-guide-contract";
import {
  Chip,
  EmptyState,
  ErrorBanner,
  Field,
  GhostButton,
  InfoNote,
  LoadingState,
  Panel,
  Pill,
  PrimaryButton,
  TextArea,
  errorMessage,
  fmtDateTime,
  useAsyncData,
} from "./primitives";

/** 浏览器侧允许选的图片类型。服务端还会按魔术字节再核一遍。 */
const IMAGE_TYPES = ["image/png", "image/jpeg"];

/** 单图上限，与 worker/modules/guide.ts 的 MAX_ASSET_BYTES 对齐。 */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const BLOCK_LABEL: Record<ShuttleGuideBlock["type"], string> = {
  heading: "小标题",
  paragraph: "段落",
  list: "要点列表",
  image: "图片",
};

/**
 * 版本状态的措辞。不用共享的 EditorialPill：它把 approved 显示成「已发布」，
 * 而这里 approved 只表示「复核通过、可发布」——线上是哪一版由 currentRevisionId
 * 单独决定。照它的措辞会出现「已发布」的版本旁边挂着「未发布」的文档状态。
 */
const REVISION_LABEL: Record<string, { label: string; tone: "ok" | "warning" | "neutral" | "error" }> = {
  draft: { label: "草稿", tone: "neutral" },
  in_review: { label: "待审核", tone: "warning" },
  approved: { label: "已批准", tone: "ok" },
  rejected: { label: "已驳回", tone: "error" },
  superseded: { label: "已取代", tone: "neutral" },
};

function RevisionPill({ status }: { status: string | null | undefined }) {
  const meta = REVISION_LABEL[status ?? "draft"] ?? { label: status ?? "草稿", tone: "neutral" as const };
  return <Pill tone={meta.tone}>{meta.label}</Pill>;
}

function newBlock(type: ShuttleGuideBlock["type"]): ShuttleGuideBlock {
  switch (type) {
    case "heading":
      return { type: "heading", text: "" };
    case "paragraph":
      return { type: "paragraph", text: "" };
    case "list":
      return { type: "list", items: [""] };
    case "image":
      return { type: "image", asset: "", caption: null };
  }
}

/** 数组内换位。越界时原样返回（调用方已按 index 禁用了按钮，这里只是兜底）。 */
function moved<T>(items: T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length) return items;
  const next = items.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function ShuttleGuidePanel() {
  const list = useAsyncData((signal) => admin.listGuideDocuments(signal), []);

  if (list.state.status === "error") return <ErrorBanner message={list.state.message} />;
  if (list.state.status !== "ready") return <LoadingState label="加载乘坐指南…" />;

  const row = list.state.data.items.find((item) => item.slug === SHUTTLE_GUIDE_SLUG) ?? null;
  if (!row) return <CreateDocument onCreated={list.reload} />;
  return <DocumentEditor reloadList={list.reload} row={row} />;
}

/**
 * 文档还不存在时的引导。不自动建：建文档会写库，静默发生的写操作在审计里
 * 看不出是谁的意图。点一下按钮，审计里就有明确的 guide.create。
 */
function CreateDocument({ onCreated }: { onCreated: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    setBusy(true);
    setError("");
    try {
      await admin.createGuideDocument({
        slug: SHUTTLE_GUIDE_SLUG,
        title: SHUTTLE_GUIDE_DEFAULT_TITLE,
        content: emptyContent() as unknown as Record<string, unknown>,
      });
      onCreated();
    } catch (err) {
      setError(errorMessage(err, "创建失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="校车乘坐指南">
      <div className="space-y-4">
        <InfoNote>
          还没有这份内容。创建后小程序校车页标题旁的「如何坐车？」才有东西可读——在发布之前，
          那个入口不会出现。
        </InfoNote>
        <ErrorBanner message={error} />
        <PrimaryButton disabled={busy} onClick={create}>
          <Plus size={16} /> 创建乘坐指南
        </PrimaryButton>
      </div>
    </Panel>
  );
}

function DocumentEditor({ row, reloadList }: { row: admin.GuideDocumentRow; reloadList: () => void }) {
  const detail = useAsyncData((signal) => admin.getGuideDocument(row.id, signal), [row.id]);

  if (detail.state.status === "error") return <ErrorBanner message={detail.state.message} />;
  if (detail.state.status !== "ready") return <LoadingState label="加载乘坐指南…" />;

  return (
    <ReadyEditor
      detail={detail.state.data}
      key={detail.state.data.working?.id ?? "none"}
      reload={() => {
        detail.reload();
        reloadList();
      }}
      row={row}
    />
  );
}

function ReadyEditor({
  row,
  detail,
  reload,
}: {
  row: admin.GuideDocumentRow;
  detail: admin.GuideDocumentDetail;
  reload: () => void;
}) {
  const initial = useMemo<ShuttleGuideContent>(
    () => (detail.working ? normalizeShuttleGuideContent(detail.working.content) : emptyContent()),
    [detail.working],
  );

  const [title, setTitle] = useState(detail.document.title || SHUTTLE_GUIDE_DEFAULT_TITLE);
  const [subtitle, setSubtitle] = useState(initial.meta.subtitle);
  const [blocks, setBlocks] = useState<ShuttleGuideBlock[]>(initial.blocks);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  /** 等图片上传完要写回哪一块。上传是异步的，期间用户可能又加了块，所以记 index 不记引用。 */
  const uploadTarget = useRef<number | null>(null);

  const working = detail.working;
  const locked = working?.editorialStatus === "in_review";
  const published = detail.document.lifecycleStatus === "published";

  /** 送审中不能改：服务端会 409，界面上直接把编辑区禁掉，不让人白写一遍。 */
  useEffect(() => {
    if (locked) setNotice("这一版正在送审，内容已冻结。撤回或等审核结果后才能继续编辑。");
  }, [locked]);

  function content(): ShuttleGuideContent {
    return normalizeShuttleGuideContent({ meta: { title, subtitle }, blocks });
  }

  /** 保存草稿。返回新草稿的 revisionId（发布链要用），失败返回 null。 */
  async function persist(): Promise<string | null> {
    const saved = await admin.saveGuideRevision(detail.document.id, {
      title: title.trim() || SHUTTLE_GUIDE_DEFAULT_TITLE,
      content: content() as unknown as Record<string, unknown>,
    });
    return saved.id;
  }

  async function run(action: () => Promise<string>, fallback: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setNotice(await action());
      reload();
    } catch (err) {
      setError(errorMessage(err, fallback));
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      await persist();
      return "草稿已保存。线上内容不变，点「发布」才会更新。";
    }, "保存失败");

  /**
   * 发布：保存 → 送审 → 批准 → 上线，一次点完。
   *
   * 每一步的失败都停在原处并保留已完成的部分——草稿一定存住了，
   * 所以最坏情况是「内容没丢，只是没上线」，重试或换个有权限的人接着点即可。
   */
  const publish = () =>
    run(async () => {
      const revisionId = await persist();
      if (!revisionId) throw new Error("保存后未拿到版本号");
      await admin.submitGuideRevision(revisionId, "校车乘坐指南更新");
      await admin.reviewGuideRevision(revisionId, "approve");
      await admin.publishGuideRevision(detail.document.id, revisionId);
      return "已发布。小程序校车页的「如何坐车？」现在读到的是这一版。";
    }, "发布失败（草稿已保存）");

  const unpublish = () =>
    run(async () => {
      await admin.unpublishGuideDocument(detail.document.id);
      return "已下线。小程序里的「如何坐车？」入口随之消失，内容与历史版本都留着。";
    }, "下线失败");

  const rollback = (revisionId: string, revisionNo: number) =>
    run(async () => {
      await admin.publishGuideRevision(detail.document.id, revisionId);
      return `已回滚到第 ${revisionNo} 版。`;
    }, "回滚失败");

  function patch(index: number, next: ShuttleGuideBlock) {
    setBlocks((prev) => prev.map((block, i) => (i === index ? next : block)));
  }

  function pickImage(index: number) {
    uploadTarget.current = index;
    fileInput.current?.click();
  }

  async function onFileChosen(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const index = uploadTarget.current;
    // input 不重置的话，选同一个文件第二次不触发 change。
    event.target.value = "";
    uploadTarget.current = null;
    if (!file || index === null) return;

    if (!IMAGE_TYPES.includes(file.type)) {
      setError("只支持 PNG 与 JPEG。小程序端画不出 SVG，矢量图请先导出成位图。");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError(`图片 ${(file.size / 1024 / 1024).toFixed(1)}MB，超过 4MB 上限，请先压缩。`);
      return;
    }

    setBusy(true);
    setError("");
    setNotice("");
    try {
      const existing = blocks[index];
      // 已有图就复用它的 key（同键上传即替换，内容不用改）；新图才申请新键。
      const key = existing?.type === "image" && existing.asset ? existing.asset : newAssetKey();
      await admin.uploadGuideAsset(key, file, "figure_png", file.type);
      setBlocks((prev) =>
        prev.map((block, i) =>
          i === index && block.type === "image" ? { ...block, asset: key } : block,
        ),
      );
      setNotice("图片已上传。记得点「保存草稿」或「发布」，否则内容里还没引用它。");
    } catch (err) {
      setError(errorMessage(err, "图片上传失败"));
    } finally {
      setBusy(false);
    }
  }

  const publishedRevision = detail.revisions.find((item) => item.id === detail.document.currentRevisionId) ?? null;

  return (
    <div className="space-y-4">
      <input
        accept={IMAGE_TYPES.join(",")}
        className="hidden"
        onChange={onFileChosen}
        ref={fileInput}
        type="file"
      />

      <Panel
        action={
          <div className="flex items-center gap-2">
            {published ? <Pill tone="ok">已发布</Pill> : <Pill tone="neutral">未发布</Pill>}
            {working ? <RevisionPill status={working.editorialStatus} /> : null}
          </div>
        }
        title="校车乘坐指南"
      >
        <div className="space-y-4">
          <InfoNote tone={published ? "neutral" : "warning"}>
            {published
              ? `线上是第 ${row.publishedRevisionNo ?? "?"} 版，更新于 ${fmtDateTime(detail.document.updatedAt)}。小程序校车页标题旁显示「如何坐车？」。`
              : "还没发布。在发布之前，小程序校车页不会出现「如何坐车？」入口。"}
          </InfoNote>

          <ErrorBanner message={error} />
          {notice ? <InfoNote tone="info">{notice}</InfoNote> : null}

          <div className="grid gap-4 md:grid-cols-2">
            <Field disabled={locked} label="标题" onChange={setTitle} placeholder="校车乘坐指南" value={title} />
            <Field
              disabled={locked}
              label="副标题（可空）"
              onChange={setSubtitle}
              placeholder="如「上车前先看这里」"
              value={subtitle}
            />
          </div>
        </div>
      </Panel>

      <Panel
        action={
          locked ? null : (
            <div className="flex flex-wrap items-center gap-2">
              {(["heading", "paragraph", "list", "image"] as const).map((type) => (
                <Chip key={type} onClick={() => setBlocks((prev) => [...prev, newBlock(type)])}>
                  <Plus className="mr-1" size={14} /> {BLOCK_LABEL[type]}
                </Chip>
              ))}
            </div>
          )
        }
        title="正文"
      >
        <div className="space-y-3">
          {blocks.length === 0 ? (
            <EmptyState label="还没有内容。用右上角的按钮加小标题、段落、要点或图片。" />
          ) : null}

          {blocks.map((block, index) => (
            <BlockEditor
              block={block}
              busy={busy}
              index={index}
              key={index}
              locked={locked}
              onChange={(next) => patch(index, next)}
              onMove={(delta) => setBlocks((prev) => moved(prev, index, index + delta))}
              onPickImage={() => pickImage(index)}
              onRemove={() => setBlocks((prev) => prev.filter((_, i) => i !== index))}
              total={blocks.length}
            />
          ))}
        </div>
      </Panel>

      <Panel title="发布">
        <div className="flex flex-wrap items-center gap-3">
          <GhostButton disabled={busy || locked} onClick={save}>
            保存草稿
          </GhostButton>
          <PrimaryButton disabled={busy || locked} onClick={publish}>
            发布
          </PrimaryButton>
          {published ? (
            <GhostButton danger disabled={busy} onClick={unpublish}>
              下线
            </GhostButton>
          ) : null}
        </div>
      </Panel>

      {detail.revisions.length > 1 ? (
        <Panel title="版本历史">
          <div className="space-y-2">
            {detail.revisions.map((revision) => {
              const isLive = revision.id === detail.document.currentRevisionId;
              return (
                <div
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-page px-4 py-3"
                  key={revision.id}
                >
                  <div className="flex items-center gap-3">
                    <span className="text-body font-semibold text-ink">第 {revision.revisionNo} 版</span>
                    <RevisionPill status={revision.editorialStatus} />
                    {isLive ? <Pill tone="ok">线上</Pill> : null}
                    <span className="text-aux text-sub">{fmtDateTime(revision.createdAt)}</span>
                    {revision.authorName ? <span className="text-aux text-sub">{revision.authorName}</span> : null}
                  </div>
                  {!isLive && revision.editorialStatus === "approved" ? (
                    <GhostButton disabled={busy} onClick={() => rollback(revision.id, revision.revisionNo)}>
                      回滚到这一版
                    </GhostButton>
                  ) : null}
                </div>
              );
            })}
          </div>
          {publishedRevision ? null : (
            <InfoNote>当前没有线上版本，上面任一「已发布」状态的版本都可以直接发上去。</InfoNote>
          )}
        </Panel>
      ) : null}
    </div>
  );
}

function BlockEditor({
  block,
  index,
  total,
  locked,
  busy,
  onChange,
  onMove,
  onRemove,
  onPickImage,
}: {
  block: ShuttleGuideBlock;
  index: number;
  total: number;
  locked: boolean;
  busy: boolean;
  onChange: (next: ShuttleGuideBlock) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
  onPickImage: () => void;
}) {
  return (
    <div className="rounded-lg border border-line p-4">
      <header className="mb-3 flex items-center justify-between gap-2">
        <span className="text-label text-sub">{BLOCK_LABEL[block.type]}</span>
        {locked ? null : (
          <div className="flex items-center gap-1">
            <GhostButton disabled={index === 0} onClick={() => onMove(-1)} title="上移">
              <ArrowUp size={15} />
            </GhostButton>
            <GhostButton disabled={index === total - 1} onClick={() => onMove(1)} title="下移">
              <ArrowDown size={15} />
            </GhostButton>
            <GhostButton danger onClick={onRemove} title="删除这一块">
              <Trash2 size={15} />
            </GhostButton>
          </div>
        )}
      </header>

      {block.type === "heading" ? (
        <Field
          disabled={locked}
          onChange={(text) => onChange({ type: "heading", text })}
          placeholder="如「候车与上车」"
          value={block.text}
        />
      ) : null}

      {block.type === "paragraph" ? (
        <TextArea
          disabled={locked}
          onChange={(text) => onChange({ type: "paragraph", text })}
          placeholder="一段正文。换行会原样保留。"
          rows={4}
          value={block.text}
        />
      ) : null}

      {block.type === "list" ? (
        <div className="space-y-2">
          {block.items.map((item, itemIndex) => (
            <div className="flex items-center gap-2" key={itemIndex}>
              <span className="w-5 text-center text-aux text-sub">{itemIndex + 1}</span>
              <div className="flex-1">
                <Field
                  disabled={locked}
                  onChange={(text) =>
                    onChange({
                      type: "list",
                      items: block.items.map((old, i) => (i === itemIndex ? text : old)),
                    })
                  }
                  placeholder="一条要点"
                  value={item}
                />
              </div>
              {locked ? null : (
                <GhostButton
                  danger
                  disabled={block.items.length === 1}
                  onClick={() =>
                    onChange({ type: "list", items: block.items.filter((_, i) => i !== itemIndex) })
                  }
                  title="删除这条"
                >
                  <Trash2 size={15} />
                </GhostButton>
              )}
            </div>
          ))}
          {locked ? null : (
            <GhostButton onClick={() => onChange({ type: "list", items: [...block.items, ""] })}>
              <Plus size={15} /> 加一条
            </GhostButton>
          )}
        </div>
      ) : null}

      {block.type === "image" ? (
        <div className="space-y-3">
          {block.asset ? (
            <img
              alt={block.caption ?? "指南图片"}
              className="max-h-72 rounded-lg border border-line object-contain"
              src={admin.guideAssetUrl(block.asset)}
            />
          ) : (
            <EmptyState label="还没选图片。" />
          )}
          {locked ? null : (
            <div className="flex flex-wrap items-center gap-3">
              <GhostButton disabled={busy} onClick={onPickImage}>
                <ImagePlus size={15} /> {block.asset ? "换一张" : "选择图片"}
              </GhostButton>
              <span className="text-aux text-sub">PNG / JPEG，4MB 以内</span>
            </div>
          )}
          <Field
            disabled={locked}
            label="图注（可空）"
            onChange={(caption) => onChange({ ...block, caption: caption || null })}
            placeholder="图下面的一行说明"
            value={block.caption ?? ""}
          />
        </div>
      ) : null}
    </div>
  );
}
