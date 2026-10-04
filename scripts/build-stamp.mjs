#!/usr/bin/env node
/**
 * Dist freshness stamp (D67).
 *
 * scripts/test-full.ts runs the *built* dist/cli.js, so a stale dist turns src
 * fixes into phantom product failures. An mtime comparison is not enough:
 * `git checkout` rewrites src mtimes, so switching branches can leave an
 * older-branch dist looking newer than the branch's own src. So the build
 * records a content fingerprint of every .ts file under src/ and the test
 * compares that.
 *
 *   node scripts/build-stamp.mjs           # write dist/.build-stamp
 *   node scripts/build-stamp.mjs --check   # verify, exit 1 when stale
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(REPO, "src");
const STAMP = path.join(REPO, "dist", ".build-stamp");

function tsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out.sort();
}

/** Hash of every .ts path + content under src/: stable across checkouts, exact. */
export function srcFingerprint() {
  const h = createHash("sha256");
  for (const file of tsFiles(SRC)) {
    h.update(path.relative(REPO, file).replace(/\\/g, "/"));
    h.update(readFileSync(file));
  }
  return h.digest("hex");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const want = srcFingerprint();
  if (process.argv.includes("--check")) {
    const have = existsSync(STAMP) ? readFileSync(STAMP, "utf8").trim() : "";
    if (have !== want) {
      console.error(
        `dist/ is stale (build stamp ${have ? have.slice(0, 12) : "missing"} != src ${want.slice(0, 12)}) - run \`npm run build\` before scripts/test-full.ts`,
      );
      process.exit(1);
    }
    console.log(`dist/ build stamp ok (${want.slice(0, 12)})`);
  } else {
    if (!existsSync(path.join(REPO, "dist"))) {
      console.error("dist/ not found - run `npm run build` first");
      process.exit(1);
    }
    writeFileSync(STAMP, want + "\n", "utf8");
    console.log(`wrote dist/.build-stamp (${want.slice(0, 12)})`);
  }
}