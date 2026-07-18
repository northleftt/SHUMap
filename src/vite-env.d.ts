/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BASE_PATH?: string;
  readonly VITE_ROUTER_MODE?: "browser" | "hash";
  readonly VITE_TENCENT_MAP_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.svg?raw" {
  const value: string;
  export default value;
}
