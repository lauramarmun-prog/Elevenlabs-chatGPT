import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = resolve(projectRoot, "public/audio-widget.html");
const entryPath = resolve(projectRoot, "public/audio-widget-bridge.js");
const outputPath = resolve(projectRoot, "dist/audio-widget.html");
const marker = "/* __ELEVENLABS_WIDGET_BUNDLE__ */";

const [template, bundle] = await Promise.all([
  readFile(templatePath, "utf8"),
  build({
    entryPoints: [entryPath],
    bundle: true,
    format: "esm",
    minify: true,
    platform: "browser",
    target: ["safari16"],
    write: false,
  }),
]);

if (!template.includes(marker)) {
  throw new Error(`Widget template marker ${marker} was not found.`);
}

const javascript = bundle.outputFiles?.[0]?.text;
if (!javascript) {
  throw new Error("The widget bridge bundle was empty.");
}

const htmlSafeJavaScript = javascript.replace(/<\/script/gi, "<\\/script");
await writeFile(outputPath, template.replace(marker, () => htmlSafeJavaScript), "utf8");
