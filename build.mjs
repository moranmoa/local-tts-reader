// Builds store-ready packages for Chrome and Firefox.
//   node build.mjs
// Output:
//   dist/chrome/   + dist/local-tts-reader-chrome-<version>.zip   (Chrome Web Store)
//   dist/firefox/  + dist/local-tts-reader-firefox-<version>.zip  (addons.mozilla.org)
// Zips from earlier versions are deleted on every build.
//
// manifest.json in the project root is the Chrome manifest (so "Load unpacked" works on
// the root folder). The Firefox manifest is derived from it here.

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// Change this before the first Firefox upload - it is the add-on's permanent ID on AMO.
const FIREFOX_ID = "local-tts-reader@local-tts.addon";

const FILES = ["background.js", "content.js", "popup.html", "popup.css", "popup.js", "icons"];
const base = JSON.parse(readFileSync("manifest.json", "utf8"));

function firefoxManifest(m) {
  const f = structuredClone(m);
  f.permissions = f.permissions.filter((p) => p !== "tts"); // Firefox has no chrome.tts
  f.background = { scripts: ["background.js"] }; // Firefox uses event pages, not service workers
  f.browser_specific_settings = {
    gecko: {
      id: FIREFOX_ID,
      strict_min_version: "140.0",
      data_collection_permissions: { required: ["none"] },
    },
    gecko_android: {
      strict_min_version: "142.0",
    },
  };
  return f;
}

function zip(dir, zipPath) {
  // Windows' bundled bsdtar writes zips with forward slashes (AMO rejects backslash paths).
  const tar = process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : "zip";
  const entries = [...FILES, "manifest.json"]; // explicit names: no "./" prefix inside the zip
  if (process.platform === "win32") execFileSync(tar, ["-a", "-c", "-f", zipPath, "-C", dir, ...entries]);
  else execFileSync(tar, ["-r", join(process.cwd(), zipPath), ...entries], { cwd: dir });
}

// Remove zips from earlier builds so only the current version is left to upload.
mkdirSync("dist", { recursive: true });
for (const f of readdirSync("dist")) {
  if (/^local-tts-reader-.*\.zip$/.test(f)) {
    rmSync(join("dist", f));
    console.log(`removed old ${f}`);
  }
}

for (const [name, manifest] of [["chrome", base], ["firefox", firefoxManifest(base)]]) {
  const dir = join("dist", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const f of FILES) cpSync(f, join(dir, f), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const zipPath = join("dist", `local-tts-reader-${name}-${base.version}.zip`);
  zip(dir, zipPath);
  console.log(`built ${zipPath}`);
}
