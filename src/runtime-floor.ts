/**
 * Runtime floor for the native SQLite driver (D74).
 *
 * `better-sqlite3` 13 is built against Node-API 10, and Node only gained
 * Node-API 10 in **22.14.0**. On an older Node the module registers and then
 * dies with a segmentation fault inside `new Database(...)` — no message, no
 * stack, exit 139 on macOS/Linux and `0xC0000005` on Windows. Upstream:
 * WiseLibs/better-sqlite3#1514 (open; reproduces on win32-x64 and
 * darwin-arm64, Node 20 and 22; `v12.11.1` is unaffected). Node 20 can never
 * work with v13 — Node-API 10 never landed on that line — and it is EoL.
 *
 * So the floor is not "whatever `engines` claimed" (it said >=22.6, which was
 * the `--experimental-strip-types` floor, not the driver's) but the exact
 * Node-API 10 boundary. Below it we refuse loudly instead of segfaulting.
 *
 * Pure module — no imports, no db — so the comparison is unit-testable.
 */

export const MIN_NODE_VERSION = "22.14.0";

export interface NodeFloor {
  major: number;
  minor: number;
  patch: number;
}

export const NODE_FLOOR: NodeFloor = { major: 22, minor: 14, patch: 0 };

/** Parse `major.minor.patch`, ignoring any prerelease suffix (`23.1.0-nightly`). */
export function parseNodeVersion(version: string): NodeFloor | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** True when `version` is at or above the Node-API 10 floor. */
export function nodeSupportsNativeDriver(version: string): boolean {
  const v = parseNodeVersion(version);
  if (!v) return false;
  const f = NODE_FLOOR;
  if (v.major !== f.major) return v.major > f.major;
  if (v.minor !== f.minor) return v.minor > f.minor;
  return v.patch >= f.patch;
}

/** The actionable message used by the driver guard and `doctor`. */
export function nativeDriverFloorMessage(version: string = process.versions.node): string {
  return (
    `better-sqlite3 13 needs Node >= ${MIN_NODE_VERSION} (it is built against ` +
    `Node-API 10), but this runtime is v${version}. On older Node the driver ` +
    `segfaults on the first database open, which is why open-memex refuses to ` +
    `load it. Upgrade Node (nvm install ${MIN_NODE_VERSION.split(".").slice(0, 2).join(".")} ` +
    `&& nvm use ${MIN_NODE_VERSION.split(".").slice(0, 2).join(".")}), or pin the driver ` +
    `down with: npm install better-sqlite3@^12.11.1`
  );
}
