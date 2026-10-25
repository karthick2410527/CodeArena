/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// In dev, the API is proxied so the browser sees a single origin: /api for
// JSON, and the two provider sign-in paths. Those keep the browser's Host
// header (no changeOrigin), so the API builds its OAuth redirect URI as
// http://localhost:5173/login/oauth2/code/{provider} and the sign-in cookies
// belong to this origin.
const apiTarget = process.env.VITE_API_PROXY_TARGET ?? "http://localhost:8080";

const resolvePath = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
      "/oauth2": { target: apiTarget },
      "/login/oauth2": { target: apiTarget },
    },
  },
  build: {
    // Monaco is ~2.3 MB (600 kB gzipped) even trimmed to the editor core plus
    // the C++ grammar, and it is loaded lazily in its own chunk — the app shell
    // is ~400 kB. The limit is set just above Monaco so the warning still fires
    // if an *application* chunk grows unexpectedly.
    chunkSizeWarningLimit: 2400,
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    // Monaco cannot run in jsdom and is far too large to transform for every
    // test run, so it is swapped for light stubs that render a textarea.
    // See src/test/stubs/. Order matters: the worker pattern must be tried
    // before the catch-all for the rest of the package.
    alias: [
      {
        find: /^monaco-editor\/.*editor\.worker\?worker$/,
        replacement: resolvePath("./src/test/stubs/monaco-worker.ts"),
      },
      {
        find: /^monaco-editor\/.*\.contribution$/,
        replacement: resolvePath("./src/test/stubs/monaco-contribution.ts"),
      },
      {
        find: /^monaco-editor(\/.*)?$/,
        replacement: resolvePath("./src/test/stubs/monaco-editor.ts"),
      },
      {
        find: "@monaco-editor/react",
        replacement: resolvePath("./src/test/stubs/monaco-react.tsx"),
      },
    ],
  },
});
