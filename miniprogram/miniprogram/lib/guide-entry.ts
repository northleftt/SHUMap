export const GUIDE_SLUG = "freshman-transit";
export const GUIDE_DISMISS_KEY = "shumap-guide-banner-dismissed";

export interface GuideSummary {
  title: string;
  edition: string | null;
  revisionNo: number;
}

export function parseGuideSummary(payload: unknown): GuideSummary | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (typeof value.revisionNo !== "number" || !Number.isFinite(value.revisionNo)) return null;
  if (typeof value.title !== "string" || value.title.trim() === "") return null;
  return {
    title: value.title,
    edition: typeof value.edition === "string" && value.edition !== "" ? value.edition : null,
    revisionNo: value.revisionNo,
  };
}

export function dismissStamp(revisionNo: number, slug: string = GUIDE_SLUG): string {
  return `${slug}:${revisionNo}`;
}

export function shouldShowGuideBanner(guide: GuideSummary | null, dismissed: string): boolean {
  return Boolean(guide) && dismissed !== dismissStamp(guide!.revisionNo);
}

export function guideSubtitle(guide: GuideSummary): string {
  return guide.edition ? `${guide.edition} · 查看到校路线` : "查看到校路线";
}
