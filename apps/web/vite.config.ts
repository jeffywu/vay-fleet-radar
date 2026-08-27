import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, repositoryRoot, "");
  const browserToken = environment.VITE_MAPBOX_ACCESS_TOKEN || environment.MAPBOX_TOKEN || "";
  const apiProxyTarget = environment.VITE_API_PROXY_TARGET || "http://127.0.0.1:3000";
  if (browserToken && !browserToken.startsWith("pk.")) {
    throw new Error("The browser map requires a public Mapbox token beginning with pk.; never expose a secret token through Vite");
  }
  return {
    plugins: [react()],
    publicDir: fileURLToPath(new URL("../../assets", import.meta.url)),
    define: {
      "import.meta.env.VITE_MAPBOX_ACCESS_TOKEN": JSON.stringify(browserToken),
    },
    server: {
      fs: { allow: [repositoryRoot] },
      proxy: {
        "/api": { target: apiProxyTarget },
        "/health": { target: apiProxyTarget },
      },
    },
  };
});
