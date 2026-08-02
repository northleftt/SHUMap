export type SubmissionTargetType =
  | "place"
  | "facility"
  | "merchant_outlet"
  | "transit_stop"
  | "new_place";

export type FeedbackType = "correction" | "new_place" | "shuttle" | "other";

export interface FeedbackSubmissionPayload {
  submissionKind: "feedback";
  feedbackType: FeedbackType;
  description: string;
}

export interface CollectedFacility {
  id: string;
  typeCode: string;
  name: string;
  locationText: string;
}

export interface CollectedFloor {
  id: string;
  levelCode: string;
  note: string;
  facilities: CollectedFacility[];
  photoMediaIds: string[];
}

export interface CollectionPayload {
  openHours: string;
  phone: string;
  organization: string;
  floors: CollectedFloor[];
  photoMediaIds: string[];
}

export interface CollectionSubmissionPayload {
  submissionKind: "collection";
  collection: CollectionPayload;
}

export type SubmissionPayload = FeedbackSubmissionPayload | CollectionSubmissionPayload;

export interface FeedbackSubmissionInput {
  targetType: SubmissionTargetType;
  targetId: string | null;
  baseRevisionId: string | null;
  payload: FeedbackSubmissionPayload;
  submitterName: string | null;
  submitterContact: string | null;
  photoMediaIds: string[];
}

export type SubmissionDecision = "accept" | "partial" | "reject";
export type SubmissionFieldDecision = "adopt" | "skip";
export type SubmissionFieldKey =
  | "description"
  | "collection.openHours"
  | "collection.phone"
  | "collection.organization"
  | "collection.floors"
  | "photos";

export type SubmissionFieldDecisions = Partial<Record<SubmissionFieldKey, SubmissionFieldDecision>>;

export interface SubmissionReviewInput {
  decision: SubmissionDecision;
  note: string | null;
  fieldDecisions: SubmissionFieldDecisions;
}

export function submissionContentFieldKeys(payload: SubmissionPayload): SubmissionFieldKey[] {
  if (payload.submissionKind === "feedback") return ["description"];
  const keys: SubmissionFieldKey[] = [];
  if (payload.collection.openHours.length > 0) keys.push("collection.openHours");
  if (payload.collection.phone.length > 0) keys.push("collection.phone");
  if (payload.collection.organization.length > 0) keys.push("collection.organization");
  if (payload.collection.floors.length > 0) keys.push("collection.floors");
  return keys;
}

export function submissionReviewFieldKeys(
  payload: SubmissionPayload,
  targetType: SubmissionTargetType,
  attachedPhotoCount: number,
): SubmissionFieldKey[] {
  const keys = submissionContentFieldKeys(payload);
  const directPhotoCount = payload.submissionKind === "feedback"
    ? attachedPhotoCount
    : payload.collection.photoMediaIds.length;
  if (targetType === "place" && directPhotoCount > 0) keys.push("photos");
  return keys;
}

export function collectionPhotoMediaIds(collection: CollectionPayload): string[] {
  return [
    ...collection.photoMediaIds,
    ...collection.floors.flatMap((floor) => floor.photoMediaIds),
  ];
}

export function adoptedSubmissionPhotoMediaIds(
  payload: SubmissionPayload,
  attachedPhotoMediaIds: readonly string[],
  adoptedFields: ReadonlySet<SubmissionFieldKey>,
): string[] {
  if (payload.submissionKind === "feedback") {
    return adoptedFields.has("photos") ? [...attachedPhotoMediaIds] : [];
  }
  return [
    ...(adoptedFields.has("photos") ? payload.collection.photoMediaIds : []),
    ...(adoptedFields.has("collection.floors")
      ? payload.collection.floors.flatMap((floor) => floor.photoMediaIds)
      : []),
  ];
}
