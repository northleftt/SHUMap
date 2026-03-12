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
      host: "127.0.0.1",
      port: 5173,
    },
  };
});
