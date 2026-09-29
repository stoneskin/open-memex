/**
 * GitProvider — the git transport for repo-synced shared scopes (§9, D12).
 *
 * Git is a transport, not the product boundary: this provider moves the
 * in-repo memory dir (`.ai/open-memex/`) between the local checkout and the
 * remote. It never touches the appdata outbox, never force-pushes, never
 * auto-merges a divergence — those are human decisions.
 *
 * Hard rules (from §9 / D12 / D36):
 * - pull is explicit (`open-memex pull`); pull = fetch + fast-forward only.
 * - push is explicit (`open-memex push`); the tool never pushes on its own.
 * - a failed pull/push fails with a clear message and leaves no broken state.
 */
import { execFileSync } from "node:child_process";

function fail(msg: string): never {
  throw new Error(`[open-memex] ${msg}`);
}

/** Run git, raising a readable error. `timeoutMs` guards network calls. */
function git(root: string, args: string[], timeoutMs = 0): string {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
    }).trim();
  } catch (e) {
    const err = e as { stderr?: string; message?: string; code?: string };
    if (err.code === "ETIMEDOUT") fail(`git ${args.join(" ")} timed out — remote unreachable?`);
    const detail = (err.stderr ?? err.message ?? "").trim().split("\n")[0];
    fail(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Provider capability model (§2) — every provider declares what it can do.
// ---------------------------------------------------------------------------

export interface MemoryProviderCapabilities {
  read: boolean;
  write: boolean;
  delete: boolean;
  /** version / audit trail */
  history: boolean;
  sync: "none" | "pull" | "push" | "bidirectional";
}

export interface MemoryProvider {
  readonly name: string;
  readonly capabilities: MemoryProviderCapabilities;
}

export interface PullReceipt {
  at: string; // RFC 3339
  branch: string;
  remote: string;
  before: string; // HEAD sha before the pull
  after: string; // HEAD sha after the pull
  fastForwarded: boolean;
}

export interface PushReceipt {
  at: string; // RFC 3339
  branch: string;
  remote: string;
  head: string; // sha pushed
}

export interface GitSyncStatus {
  branch: string;
  upstream: string | null;
  remote: string | null;
  ahead: number;
  behind: number;
}

const FETCH_TIMEOUT_MS = 30_000;

export class GitProvider implements MemoryProvider {
  readonly name = "git";
  readonly capabilities: MemoryProviderCapabilities = {
    read: true,
    write: true,
    delete: false,
    history: true,
    sync: "bidirectional",
  };

  /** Current branch + upstream, or a clear failure when git can't answer. */
  status(root: string): GitSyncStatus {
    git(root, ["rev-parse", "--git-dir"]);
    const branch =
      git(root, ["branch", "--show-current"]) ||
      git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    let upstream: string | null = null;
    try {
      upstream = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    } catch {
      upstream = null;
    }
    let ahead = 0;
    let behind = 0;
    if (upstream) {
      const counts = git(root, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`]);
      const [a, b] = counts.split(/\s+/).map((n) => parseInt(n, 10));
      ahead = Number.isFinite(a) ? a : 0;
      behind = Number.isFinite(b) ? b : 0;
    }
    const remote = upstream ? upstream.split("/")[0] : null;
    return { branch, upstream, remote, ahead, behind };
  }

  /**
   * Explicit pull: fetch + fast-forward only (§9).
   * Diverged branches are NOT merged — the user resolves them by hand.
   */
  pull(root: string): PullReceipt {
    const st = this.status(root);
    if (!st.upstream || !st.remote) {
      fail(
        `branch ${st.branch} has no upstream — set one with ` +
          `\`git push -u <remote> ${st.branch}\`, then pull again`,
      );
    }
    git(root, ["fetch", st.remote], FETCH_TIMEOUT_MS);
    const before = git(root, ["rev-parse", "HEAD"]);
    const remoteSha = git(root, ["rev-parse", st.upstream]);
    if (before === remoteSha) {
      return {
        at: new Date().toISOString(),
        branch: st.branch,
        remote: st.remote,
        before,
        after: before,
        fastForwarded: false,
      };
    }
    // Fast-forward is possible iff HEAD is an ancestor of the upstream.
    let ffPossible = false;
    try {
      git(root, ["merge-base", "--is-ancestor", "HEAD", st.upstream]);
      ffPossible = true;
    } catch {
      ffPossible = false;
    }
    if (!ffPossible) {
      fail(
        `branch ${st.branch} has diverged from ${st.upstream} — ` +
          `open-memex never force-merges; resolve it by hand ` +
          `(rebase or merge), then pull again`,
      );
    }
    git(root, ["merge", "--ff-only", st.upstream]);
    const after = git(root, ["rev-parse", "HEAD"]);
    return {
      at: new Date().toISOString(),
      branch: st.branch,
      remote: st.remote,
      before,
      after,
      fastForwarded: true,
    };
  }

  /** Explicit push of the current branch. Never called automatically. */
  push(root: string): PushReceipt {
    const st = this.status(root);
    if (!st.remote) {
      // No upstream yet: push explicitly sets it (-u), still user-invoked.
      const remotes = git(root, ["remote"]);
      const remote = remotes.split("\n").map((r) => r.trim()).filter(Boolean)[0];
      if (!remote) fail("no git remote configured — add one before pushing");
      git(root, ["push", "-u", remote, st.branch], FETCH_TIMEOUT_MS);
      return {
        at: new Date().toISOString(),
        branch: st.branch,
        remote,
        head: git(root, ["rev-parse", "HEAD"]),
      };
    }
    git(root, ["push", st.remote, st.branch], FETCH_TIMEOUT_MS);
    return {
      at: new Date().toISOString(),
      branch: st.branch,
      remote: st.remote,
      head: git(root, ["rev-parse", "HEAD"]),
    };
  }
}
