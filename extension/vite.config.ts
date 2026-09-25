import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Two entries, one loadable folder:
//   - sidepanel.html — the React window the user talks to (side panel AND the
//     popped-out floating window are the same document)
//   - src/background.ts — the MV3 service worker
// public/ (manifest.json, icons/) is copied verbatim, so `dist/` is exactly
// what chrome://extensions "Load unpacked" points at.
//
// Names are unhashed on purpose: manifest.json names the files, and a loaded
// extension that doesn't change filenames every build is far easier to debug
// from devtools.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidepanel: new URL("./sidepanel.html", import.meta.url).pathname,
        background: new URL("./src/background.ts", import.meta.url).pathname,
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
