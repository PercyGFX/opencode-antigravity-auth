#!/usr/bin/env node
/**
 * Compiles tui.tsx to dist/tui.js for the npm package.
 *
 * opencode compiles a TUI plugin's Solid JSX itself only for files outside node_modules, so an
 * installed package has to ship plain JS. This runs the same transform opencode uses (Solid's
 * universal renderer on @opentui/solid); opencode then maps the @opentui/solid, solid-js and
 * @opencode/plugin/tui imports to its own copies. A local checkout keeps loading tui.tsx.
 *
 *   node scripts/build-tui.mjs   # run by `npm run build`, after tsc has written dist/
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { transformAsync } from "@babel/core";
import presetTypescript from "@babel/preset-typescript";
import presetSolid from "babel-preset-solid";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "tui.tsx");
const output = join(root, "dist", "tui.js");

const result = await transformAsync(readFileSync(source, "utf8"), {
  filename: source,
  configFile: false,
  babelrc: false,
  // Presets run last to first: strip TypeScript, then compile the JSX.
  presets: [
    [presetSolid, { moduleName: "@opentui/solid", generate: "universal" }],
    [presetTypescript, { onlyRemoveTypeImports: false }],
  ],
});
if (!result?.code) throw new Error("tui.tsx compiled to nothing");

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${result.code}\n`);
console.log(`wrote ${output}`);
