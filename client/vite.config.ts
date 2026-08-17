import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" keeps the bundle relocatable: the dist folder is served by a
// plain static server (python -m http.server) and may live at any path.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
