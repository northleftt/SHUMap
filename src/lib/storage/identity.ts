import { useLocalStore } from "./localStore";

export interface Identity {
  name: string;
  /** 脱敏学号，如 21****32 */
  studentId: string;
}

const KEY = "shumap.identity";

export const DEFAULT_IDENTITY: Identity = { name: "张同学", studentId: "21****32" };

/** 公共用户无登录体系——身份仅本地 mock，编辑存 localStorage。 */
export function useIdentity(): [Identity, (next: Identity | ((prev: Identity) => Identity)) => void] {
  return useLocalStore<Identity>(KEY, DEFAULT_IDENTITY);
}
