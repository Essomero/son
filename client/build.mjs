// Bundle the client into a single self-contained dist/app.js.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["src/app.js"],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: "dist/app.js",
  sourcemap: true,
  logLevel: "info",
});

copyFileSync("index.html", "dist/index.html");
console.log("Built dist/app.js + dist/index.html");
