import { apiPost } from "../../lib/api";
import { uploadPublicPhoto } from "../../lib/photo-upload";
import { loadReleaseWithCache } from "../../lib/release/loader";
import type { LoadedRelease } from "../../lib/release/mapData";
import { addSubmission } from "../../lib/submissions-log";
import type { MapBuilding, TransitStop } from "../../lib/release/types";

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
    targetPlaceholder: "选择地点",
    targetId: "",
    targetName: "",
    targetNames: [] as string[],
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
    this.loadedRelease = null as LoadedRelease | null;
    this.buildings = [] as MapBuilding[];
    this.stops = [] as TransitStop[];
    this.syncTypes("correction");
    this.loadTargets();
  },

  async loadTargets() {
    try {
      const loaded = await loadReleaseWithCache();
      this.loadedRelease = loaded;
      this.buildings = loaded.buildings;
      this.stops = loaded.manifest.transit.stops;
      this.setData({ loading: false, loadError: "" });
      this.syncTargetOptions();
    } catch (error) {
      this.setData({
        loading: false,
        loadError: error instanceof Error ? error.message : "反馈目标加载失败",
      });
    }
  },

  syncTypes(type: FeedbackType) {
    const targetRequired = type !== "new_place";
    this.setData({
      type,
      types: TYPE_CONFIG.map((item) => ({ ...item, active: item.key === type })),
      targetRequired,
      targetLabel: type === "shuttle" ? "关联站点" : "关联地点",
      targetPlaceholder: type === "shuttle" ? "选择站点" : "选择地点",
      targetId: "",
      targetName: "",
      submitError: "",
    });
    this.syncTargetOptions();
    this.updateCanSubmit();
  },

  syncTargetOptions() {
    const rows = this.data.type === "shuttle" ? this.stops : this.buildings;
    this.setData({ targetNames: rows.map((item: TransitStop | MapBuilding) => item.name) });
  },

  selectType(e: any) {
    const type = String(e.currentTarget.dataset.key) as FeedbackType;
    if (TYPE_CONFIG.some((item) => item.key === type)) this.syncTypes(type);
  },

  onTargetChange(e: any) {
    const index = Number(e.detail.value);
    if (this.data.type === "shuttle") {
      const stop = this.stops[index];
      if (stop) this.setData({ targetId: stop.id, targetName: stop.name });
    } else {
      const building = this.buildings[index];
      if (building) this.setData({ targetId: building.poiKey, targetName: building.name });
    }
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
    const building = config.targetType === "place"
      ? this.buildings.find((item) => item.poiKey === this.data.targetId)
      : null;
    if (config.targetType === "place" && !building) {
      this.setData({ submitError: "所选地点已不在当前发布版本中，请重新选择" });
      return;
    }
    this.setData({ submitting: true, submitError: "", canSubmit: false });
    const description = this.data.content.trim();
    try {
      const result = await apiPost<{ id: string }>("/api/public/submissions", {
        targetType: config.targetType,
        targetId: this.data.targetRequired ? this.data.targetId : null,
        baseRevisionId: building?.revisionId ?? null,
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
