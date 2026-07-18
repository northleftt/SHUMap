import { useEffect, useMemo, useState } from "react";
import { createSubmission, listPlaces } from "../lib/api/public";
import { ApiError } from "../lib/api/client";
import type { PublicPlaceListItem } from "../lib/api/types";

interface FactItem {
  id: string;
  label: string;
  value: string;
}

function makeId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const DEFAULT_FACTS: FactItem[] = [
  { id: makeId("fact"), label: "所属单位", value: "" },
  { id: makeId("fact"), label: "进入方式", value: "" },
  { id: makeId("fact"), label: "开放时间", value: "" },
  { id: makeId("fact"), label: "联系电话", value: "" },
];

type PlacesState =
  | { status: "loading" }
  | { status: "ready"; items: PublicPlaceListItem[] }
  | { status: "empty" }
  | { status: "error"; message: string };

export function PoiCollectPage() {
  const [placesState, setPlacesState] = useState<PlacesState>({ status: "loading" });
  const [placeId, setPlaceId] = useState("");
  const [query, setQuery] = useState("");
  const [submitterName, setSubmitterName] = useState("");
  const [submitterContact, setSubmitterContact] = useState("");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [facts, setFacts] = useState<FactItem[]>(DEFAULT_FACTS);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const places = placesState.status === "ready" ? placesState.items : [];
  const selectedPlace = places.find((place) => place.id === placeId) ?? null;

  const filteredPlaces = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return places.slice(0, 50);
    return places.filter((place) => place.displayName.toLowerCase().includes(keyword)).slice(0, 50);
  }, [places, query]);

  useEffect(() => {
    const controller = new AbortController();
    listPlaces(controller.signal)
      .then((response) => {
        if (response.releaseId === null || response.items.length === 0) {
          setPlacesState({ status: "empty" });
          return;
        }
        setPlacesState({ status: "ready", items: response.items });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.isReleaseUnavailable) {
          setPlacesState({ status: "empty" });
          return;
        }
        setPlacesState({ status: "error", message: error instanceof Error ? error.message : "加载点位数据失败" });
      });
    return () => controller.abort();
  }, []);

  function resetForm() {
    setSummary("");
    setDescription("");
    setFacts([
      { id: makeId("fact"), label: "所属单位", value: "" },
      { id: makeId("fact"), label: "进入方式", value: "" },
      { id: makeId("fact"), label: "开放时间", value: "" },
      { id: makeId("fact"), label: "联系电话", value: "" },
    ]);
  }

  async function submit() {
    if (!selectedPlace) {
      setMessage("请先选择点位");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const cleanFacts = facts.filter((fact) => fact.label.trim() && fact.value.trim());
      // New v2 submission contract: target a place with a free-form payload.
      // Media upload UX is intentionally not exposed yet — text-only submission.
      await createSubmission({
        targetType: "place",
        targetId: selectedPlace.id,
        submitterName: submitterName.trim() || null,
        submitterContact: submitterContact.trim() || null,
        payload: {
          detail: {
            summary: summary.trim(),
            description: description.trim(),
            facts: cleanFacts.map((fact) => ({ label: fact.label.trim(), value: fact.value.trim() })),
          },
        },
      });
      setMessage("已提交，等待后台审核。");
      resetForm();
    } catch (err) {
      if (err instanceof ApiError) {
        setMessage(err.message);
      } else {
        setMessage(err instanceof Error ? err.message : "提交失败");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#f5f8fb] px-4 py-5 text-[var(--color-text)]">
      <div className="mx-auto max-w-[480px]">
        <header className="mb-5">
          <h1 className="text-[24px] font-semibold">点位信息采集</h1>
          <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">提交后会进入后台审核，通过后才会发布到地图。</p>
        </header>

        {placesState.status === "empty" ? (
          <section className="rounded-[8px] border border-[var(--color-border)] bg-white p-6 text-center">
            <p className="text-[14px] font-medium">点位数据尚未发布</p>
            <p className="mt-1.5 text-[13px] text-[var(--color-text-muted)]">当前没有已发布的地图版本，暂时无法采集信息，请稍后再试。</p>
          </section>
        ) : placesState.status === "error" ? (
          <section className="rounded-[8px] border border-[var(--color-border)] bg-white p-6 text-center">
            <p className="text-[14px] font-medium">加载失败</p>
            <p className="mt-1.5 text-[13px] text-[var(--color-text-muted)]">{placesState.message}</p>
          </section>
        ) : (
          <>
            <section className="rounded-[8px] border border-[var(--color-border)] bg-white p-4">
              <Field label="搜索点位" value={query} onChange={setQuery} placeholder="输入点位名称" />
              <div className="mt-3 max-h-56 overflow-y-auto rounded-[8px] border border-[var(--color-border)]">
                {placesState.status === "loading" ? (
                  <p className="px-3 py-6 text-center text-[13px] text-[var(--color-text-muted)]">正在加载点位…</p>
                ) : filteredPlaces.length === 0 ? (
                  <p className="px-3 py-6 text-center text-[13px] text-[var(--color-text-muted)]">没有匹配的点位</p>
                ) : (
                  filteredPlaces.map((place) => (
                    <button
                      className={`block w-full border-b border-[var(--color-border)] px-3 py-3 text-left last:border-b-0 ${place.id === placeId ? "bg-[var(--color-primary-soft)]" : "bg-white"}`}
                      key={place.id}
                      onClick={() => setPlaceId(place.id)}
                      type="button"
                    >
                      <span className="block text-[14px] font-semibold">{place.displayName}</span>
                      {place.summary ? <span className="text-[12px] text-[var(--color-text-muted)]">{place.summary}</span> : null}
                    </button>
                  ))
                )}
              </div>
            </section>

            <section className="mt-4 space-y-4 rounded-[8px] border border-[var(--color-border)] bg-white p-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="采集人" value={submitterName} onChange={setSubmitterName} placeholder="姓名" />
                <Field label="联系方式" value={submitterContact} onChange={setSubmitterContact} placeholder="手机号或微信" />
              </div>
              <Field label="简介" value={summary} onChange={setSummary} placeholder="一句话介绍" />
              <Field label="描述详情" value={description} onChange={setDescription} placeholder="补充开放情况、使用说明等" multiline />

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-[12px] font-semibold text-[var(--color-text-muted)]">信息字段</p>
                  <button className="rounded-full bg-[var(--color-primary-soft)] px-3 py-1.5 text-[12px] font-semibold text-[var(--color-primary)]" onClick={() => setFacts((current) => [...current, { id: makeId("fact"), label: "", value: "" }])} type="button">
                    新增
                  </button>
                </div>
                <div className="space-y-2">
                  {facts.map((fact) => (
                    <div key={fact.id} className="grid grid-cols-[110px_1fr] gap-2">
                      <input className="h-10 rounded-[8px] border border-[var(--color-border)] px-3 text-[13px]" value={fact.label} onChange={(event) => setFacts((current) => current.map((item) => item.id === fact.id ? { ...item, label: event.target.value } : item))} placeholder="字段名" />
                      <input className="h-10 rounded-[8px] border border-[var(--color-border)] px-3 text-[13px]" value={fact.value} onChange={(event) => setFacts((current) => current.map((item) => item.id === fact.id ? { ...item, value: event.target.value } : item))} placeholder="内容" />
                    </div>
                  ))}
                </div>
              </div>

              <p className="rounded-[8px] bg-[var(--color-surface-muted)] px-3 py-2 text-[12px] text-[var(--color-text-muted)]">
                当前仅支持提交文字信息。图片采集功能会在后续开放。
              </p>

              {message ? <p className="rounded-[8px] bg-[var(--color-surface-muted)] px-3 py-2 text-[13px] font-semibold">{message}</p> : null}
              <button className="h-12 w-full rounded-[8px] bg-[var(--color-primary)] text-[15px] font-semibold text-white disabled:opacity-50" disabled={busy || !selectedPlace} onClick={submit} type="button">
                {busy ? "处理中..." : "提交采集信息"}
              </button>
            </section>
          </>
        )}
      </div>
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-semibold text-[var(--color-text-muted)]">{label}</span>
      {multiline ? (
        <textarea className="min-h-28 w-full rounded-[8px] border border-[var(--color-border)] px-3 py-2 text-[13px] outline-none focus:border-[var(--color-primary)]" onChange={(event) => onChange(event.target.value)} placeholder={placeholder} value={value} />
      ) : (
        <input className="h-10 w-full rounded-[8px] border border-[var(--color-border)] px-3 text-[13px] outline-none focus:border-[var(--color-primary)]" onChange={(event) => onChange(event.target.value)} placeholder={placeholder} value={value} />
      )}
    </label>
  );
}
