import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" keeps the bundle relocatable: the dist folder is served by the
// studio server (finetune/recorder/server.py) and may live at any path.
// Dev mode proxies the API to the server on :8082.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../dist",
    sourcemap: true,
  },
  server: {
    proxy: {
      "/batches": "http://127.0.0.1:8082",
      "/batch": "http://127.0.0.1:8082",
      "/noise": "http://127.0.0.1:8082",
    },
  },
});
