import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1];
  const githubPagesBase =
    process.env.GITHUB_ACTIONS === "true" && repositoryName
      ? `/${repositoryName}/`
      : "/";

  return {
    base: env.VITE_BASE_PATH || githubPagesBase,
    plugins: [react(), tailwindcss()],
    server: {
      host: true,
      port: 5173,
      // Lody 等本地预览工具经代理转发时 Host 头非 localhost，
      // 默认的 DNS rebinding 检查会 403 → 预览白屏；仅 dev 生效
      allowedHosts: true,
      proxy: {
        // 本地 HMR 预览直连线上 v2 API（仅 dev，构建产物不受影响）
        "/api": {
          target: env.VITE_API_PROXY_TARGET || "https://map.shutf.com",
          changeOrigin: true,
        },
      },
    },
  };
});
