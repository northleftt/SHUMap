import { apiPost } from "../../lib/api";
import {
  buildPlaceTargets,
  buildStopTargets,
  feedbackCampusOptions,
  feedbackTargetLabel,
  filterFeedbackTargets,
  type FeedbackCampusOption,
  type FeedbackTargetOption,
  type FeedbackTargetResult,
} from "../../lib/feedback-targets";
import { uploadPublicPhoto } from "../../lib/photo-upload";
import { loadReleaseWithCache } from "../../lib/release/loader";
import type { LoadedRelease } from "../../lib/release/mapData";
import { addSubmission } from "../../lib/submissions-log";
import type { MapBuilding, TransitStop } from "../../lib/release/types";
import { APP_SHARE_TITLE, enableShareMenus, sharePath } from "../../lib/share";

type FeedbackType = "correction" | "new_place" | "shuttle" | "other";
type PhotoStatus = "uploading" | "done" | "error";

interface FeedbackPhoto {
  key: string;
  path: string;
  status: PhotoStatus;
  mediaId: string | null;
  error: string;
}

interface TypeRow {
  key: FeedbackType;
  label: string;
  targetType: "place" | "new_place" | "transit_stop";
  active: boolean;
}

const TYPE_CONFIG: Array<Omit<TypeRow, "active">> = [
  { key: "correction", label: "信息纠错", targetType: "place" },
  { key: "new_place", label: "新增地点", targetType: "new_place" },
  { key: "shuttle", label: "校车问题", targetType: "transit_stop" },
  { key: "other", label: "其他", targetType: "place" },
];

const MAX_PHOTOS = 3;
let photoSequence = 0;

function nextPhotoKey(): string {
  photoSequence += 1;
  return `feedback-photo-${Date.now().toString(36)}-${photoSequence}`;
}

Page({
  data: {
    loading: true,
    loadError: "",
    type: "correction" as FeedbackType,
    types: [] as TypeRow[],
    targetRequired: true,
    targetLabel: "关联地点",
    targetPlaceholder: "搜索并选择地点",
    /** 提交用的 targetId 与 baseRevisionId；站点没有修订号，恒为空串。 */
    targetId: "",
    targetName: "",
    targetRevisionId: "",
    /** 选中项的展示文案（含校区），空串表示还没选。 */
    targetSummary: "",
    pickerOpen: false,
    campusKey: "",
    campusOptions: [] as Array<FeedbackCampusOption & { active: boolean }>,
    query: "",
    results: [] as FeedbackTargetResult[],
    resultTotal: 0,
    resultTruncated: false,
    content: "",
    nickname: "",
    contact: "",
    photos: [] as FeedbackPhoto[],
    canChoosePhotos: true,
    uploadingPhotoCount: 0,
    failedPhotoCount: 0,
    submitting: false,
    submitError: "",
    canSubmit: false,
    done: false,
  },

  onLoad() {
    enableShareMenus();
    this.loadedRelease = null as LoadedRelease | null;
    // buildings / stops 保留给回归脚本与旧调用点；选择器本身走下面两个目标集合。
    this.buildings = [] as MapBuilding[];
    this.stops = [] as TransitStop[];
    this.placeTargets = [] as FeedbackTargetOption[];
    this.stopTargets = [] as FeedbackTargetOption[];
    this.syncTypes("correction");
    this.loadTargets();
  },

  /** 转发：反馈内容是本人填写的草稿，卡片一律落到地图首页，不带表单状态。 */
  onShareAppMessage() {
    return {
      title: APP_SHARE_TITLE,
      path: sharePath("/pages/map/map"),
    };
  },

  onShareTimeline() {
    return { title: APP_SHARE_TITLE };
  },

  async loadTargets() {
    this.setData({ loading: true, loadError: "" });
    try {
      const loaded = await loadReleaseWithCache();
      this.loadedRelease = loaded;
      this.buildings = loaded.buildings;
      this.stops = loaded.manifest.transit.stops;
      // 别名进搜索：搜「乐乎新楼」应当命中它的正式名。
      const aliases = new Map(loaded.manifest.places.map((place) => [place.id, place.aliases]));
      this.placeTargets = buildPlaceTargets(loaded.pois, aliases);
      this.stopTargets = buildStopTargets(loaded.manifest.transit.stops, loaded.campuses);
      this.setData({ loading: false, loadError: "" });
      this.syncTargetOptions();
    } catch (error) {
      this.setData({
        loading: false,
        loadError: error instanceof Error ? error.message : "反馈目标加载失败",
      });
    }
  },

  /** 当前反馈类型对应的目标集合（校车问题选站点，其余选地点）。 */
  currentTargets(): FeedbackTargetOption[] {
    return (this.data.type === "shuttle" ? this.stopTargets : this.placeTargets) as FeedbackTargetOption[];
  },

  syncTypes(type: FeedbackType) {
    const targetRequired = type !== "new_place";
    this.setData({
      type,
      types: TYPE_CONFIG.map((item) => ({ ...item, active: item.key === type })),
      targetRequired,
      targetLabel: type === "shuttle" ? "关联站点" : "关联地点",
      targetPlaceholder: type === "shuttle" ? "搜索并选择站点" : "搜索并选择地点",
      targetId: "",
      targetName: "",
      targetRevisionId: "",
      targetSummary: "",
      pickerOpen: false,
      campusKey: "",
      query: "",
      submitError: "",
    });
    this.syncTargetOptions();
    this.updateCanSubmit();
  },

  /** 重算校区筛选项与候选列表。任何影响候选的输入变化后都要调它。 */
  syncTargetOptions() {
    const options = this.currentTargets();
    const campuses = this.loadedRelease ? this.loadedRelease.campuses : [];
    const campusOptions = feedbackCampusOptions(options, campuses).map((campus) => ({
      ...campus,
      active: campus.key === this.data.campusKey,
    }));
    const page = filterFeedbackTargets(options, {
      campusKey: this.data.campusKey,
      query: this.data.query,
    });
    this.setData({
      campusOptions,
      results: page.items,
      resultTotal: page.total,
      resultTruncated: page.truncated,
    });
  },

  selectType(e: any) {
    const type = String(e.currentTarget.dataset.key) as FeedbackType;
    if (TYPE_CONFIG.some((item) => item.key === type)) this.syncTypes(type);
  },

  togglePicker() {
    const pickerOpen = !this.data.pickerOpen;
    this.setData({ pickerOpen });
    if (pickerOpen) this.syncTargetOptions();
  },

  onQueryInput(e: any) {
    this.setData({ query: String(e.detail.value ?? "") });
    this.syncTargetOptions();
  },

  clearQuery() {
    this.setData({ query: "" });
    this.syncTargetOptions();
  },

  selectCampus(e: any) {
    const campusKey = String(e.currentTarget.dataset.key ?? "");
    this.setData({ campusKey });
    this.syncTargetOptions();
  },

  /** 选定候选项：连 revisionId 一起记下，提交时不必再回查列表。 */
  chooseTarget(e: any) {
    const targetId = String(e.currentTarget.dataset.id ?? "");
    const target = (this.data.results as FeedbackTargetResult[]).find((item) => item.targetId === targetId);
    if (!target) return;
    this.setData({
      targetId: target.targetId,
      targetName: target.name,
      targetRevisionId: target.revisionId ?? "",
      targetSummary: feedbackTargetLabel(target),
      pickerOpen: false,
      query: "",
      submitError: "",
    });
    this.syncTargetOptions();
    this.updateCanSubmit();
  },

  onContentInput(e: any) {
    this.setData({ content: String(e.detail.value ?? ""), submitError: "" });
    this.updateCanSubmit();
  },

  onNicknameInput(e: any) {
    this.setData({ nickname: String(e.detail.value ?? "") });
  },

  onContactInput(e: any) {
    this.setData({ contact: String(e.detail.value ?? "") });
  },

  updateCanSubmit() {
    const contentReady = this.data.content.trim().length >= 5;
    const targetReady = !this.data.targetRequired || Boolean(this.data.targetId);
    const photosReady = this.data.uploadingPhotoCount === 0;
    this.setData({ canSubmit: contentReady && targetReady && photosReady && !this.data.submitting });
  },

  syncPhotoState(photos: FeedbackPhoto[]) {
    this.setData({
      photos,
      canChoosePhotos: photos.length < MAX_PHOTOS,
      uploadingPhotoCount: photos.filter((photo) => photo.status === "uploading").length,
      failedPhotoCount: photos.filter((photo) => photo.status === "error").length,
    });
    this.updateCanSubmit();
  },

  choosePhotos() {
    const room = Math.max(0, MAX_PHOTOS - this.data.photos.length);
    if (!room) return;
    wx.chooseMedia({
      count: room,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: (result: any) => {
        const added = (result.tempFiles ?? [])
          .slice(0, room)
          .map((file: any): FeedbackPhoto => ({
            key: nextPhotoKey(),
            path: String(file.tempFilePath ?? ""),
            status: "uploading",
            mediaId: null,
            error: "",
          }))
          .filter((photo: FeedbackPhoto) => photo.path !== "");
        if (!added.length) return;
        this.syncPhotoState([...this.data.photos, ...added]);
        for (const photo of added) void this.uploadPhoto(photo.key, photo.path);
      },
      fail: (error: any) => {
        if (!String(error.errMsg ?? "").includes("cancel")) {
          wx.showToast({ title: "照片选择失败", icon: "none" });
        }
      },
    });
  },

  async uploadPhoto(key: string, path: string) {
    try {
      const result = await uploadPublicPhoto(path);
      const photos = (this.data.photos as FeedbackPhoto[]).map((photo) => (
        photo.key === key
          ? { ...photo, status: "done" as const, mediaId: result.mediaId, error: "" }
          : photo
      ));
      if (photos.some((photo) => photo.key === key)) this.syncPhotoState(photos);
    } catch (error) {
      const photos = (this.data.photos as FeedbackPhoto[]).map((photo) => (
        photo.key === key
          ? {
              ...photo,
              status: "error" as const,
              mediaId: null,
              error: error instanceof Error ? error.message : "上传失败",
            }
          : photo
      ));
      if (photos.some((photo) => photo.key === key)) this.syncPhotoState(photos);
    }
  },

  retryPhoto(e: any) {
    const key = String(e.currentTarget.dataset.key ?? "");
    const target = (this.data.photos as FeedbackPhoto[]).find((photo) => photo.key === key);
    if (!target || target.status === "uploading") return;
    const photos = (this.data.photos as FeedbackPhoto[]).map((photo) => (
      photo.key === key ? { ...photo, status: "uploading" as const, mediaId: null, error: "" } : photo
    ));
    this.syncPhotoState(photos);
    void this.uploadPhoto(key, target.path);
  },

  removePhoto(e: any) {
    const key = String(e.currentTarget.dataset.key ?? "");
    this.syncPhotoState((this.data.photos as FeedbackPhoto[]).filter((photo) => photo.key !== key));
  },

  previewFeedbackPhoto(e: any) {
    const current = String(e.currentTarget.dataset.path ?? "");
    const urls = (this.data.photos as FeedbackPhoto[]).map((photo) => photo.path).filter(Boolean);
    if (urls.length) wx.previewImage({ current: urls.includes(current) ? current : urls[0], urls });
  },

  async submitFeedback() {
    if (!this.data.canSubmit || this.data.submitting) return;
    const config = TYPE_CONFIG.find((item) => item.key === this.data.type)!;
    // place 目标必须带 baseRevisionId，否则服务端 400；发布版本换过之后选中项会失效。
    if (config.targetType === "place" && !this.data.targetRevisionId) {
      this.setData({ submitError: "所选地点已不在当前发布版本中，请重新选择" });
      return;
    }
    this.setData({ submitting: true, submitError: "", canSubmit: false });
    const description = this.data.content.trim();
    try {
      const result = await apiPost<{ id: string }>("/api/public/submissions", {
        targetType: config.targetType,
        targetId: this.data.targetRequired ? this.data.targetId : null,
        baseRevisionId: config.targetType === "place" ? this.data.targetRevisionId : null,
        payload: {
          submissionKind: "feedback",
          feedbackType: this.data.type,
          description,
        },
        submitterName: this.data.nickname.trim() || null,
        submitterContact: this.data.contact.trim() || null,
        photoMediaIds: (this.data.photos as FeedbackPhoto[])
          .filter((photo) => photo.status === "done" && photo.mediaId)
          .map((photo) => photo.mediaId),
      });
      addSubmission({
        id: result.id,
        targetType: config.targetType,
        targetId: this.data.targetId || undefined,
        targetName: this.data.targetName || undefined,
        title: description.split("\n")[0].slice(0, 30) || "反馈",
      });
      this.setData({ done: true, submitting: false });
    } catch (error) {
      this.setData({
        submitting: false,
        submitError: error instanceof Error ? error.message : "提交失败，请稍后重试",
      });
      this.updateCanSubmit();
    }
  },

  goProfile() {
    wx.switchTab({ url: "/pages/profile/profile" });
  },
});
