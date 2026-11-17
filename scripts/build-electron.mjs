import { build } from "esbuild";
import { rm } from "node:fs/promises";

await rm("dist/electron", { recursive: true, force: true });
await build({
  entryPoints: ["electron/main.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile: "dist/electron/main.cjs",
  external: ["electron"],
  sourcemap: true,
  logLevel: "info"
});
