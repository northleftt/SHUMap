export const PERMISSIONS = [
  "read:admin",
  "write:content",
  "write:maps",
  "write:transit",
  "review:content",
  "publish:release",
  "rollback:release",
  "manage:users",
  "collect:data",
] as const;

export type Permission = (typeof PERMISSIONS)[number] | "*";

export type EditorialStatus = "draft" | "in_review" | "approved" | "rejected" | "superseded";
export type EntityLocationType =
  | "place"
  | "facility"
  | "merchant_outlet"
  | "operational_event"
  | "campaign"
  | "transit_stop";

export interface SessionPrincipal {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
  permissions: Permission[];
}

export interface QueueJobMessage {
  jobId: string;
  jobType: "map_import";
}
