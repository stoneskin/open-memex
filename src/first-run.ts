/**
 * D50: first-run init offer. `npm install -g open-memex` only puts the CLI on
 * PATH — the editor wiring is `init`'s job, and a clean reinstall wipes it.
 * When bare `open-memex` runs on a machine where init never completed, offer
 * to run it instead of just printing usage.
 *
 * The "asked" state is a marker file at the data root (`init` writes it on
 * success, a declined offer writes it too), so the question is asked exactly
 * once. `uninstall` removes it — unwiring is the reverse of init, so the next
 * bare run offers to wire again. The marker is a dotfile: export builds from
 * DB rows, never by walking the data root, so it can't leak into bundles.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { dataRootPath } from "./paths.ts";

const MARKER = ".init.json";

export type FirstRunState = "initialized" | "declined";

export function firstRunMarkerPath(root: string = dataRootPath()): string {
  return path.join(root, MARKER);
}

/** True when init has neither run nor been declined on this machine. */
export function isFirstRun(root?: string): boolean {
  return !fs.existsSync(firstRunMarkerPath(root ?? dataRootPath()));
}

/** Record the outcome — best effort; a missing marker just asks again next time. */
export function markFirstRunDone(state: FirstRunState): void {
  const file = firstRunMarkerPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ v: 1, state, at: new Date().toISOString() }) + "\n");
  } catch {
    /* ignore */
  }
}

export function clearFirstRunMarker(): void {
  try {
    fs.rmSync(firstRunMarkerPath(), { force: true });
  } catch {
    /* ignore */
  }
}

export interface TtyProbe {
  stdinTTY: boolean | undefined;
  stdoutTTY: boolean | undefined;
}

/** Pure decision, kept separate for tests: prompt only on an interactive
 *  terminal — scripts, CI and piped runs never get the question. */
export function shouldOfferFirstRun(
  tty: TtyProbe = { stdinTTY: process.stdin.isTTY, stdoutTTY: process.stdout.isTTY },
  firstRun: boolean = isFirstRun(),
): boolean {
  return firstRun && !!tty.stdinTTY && !!tty.stdoutTTY;
}

function askYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(!/^\s*(n|no)\s*$/i.test(ans));
    });
  });
}

export type FirstRunOutcome = "initialized" | "declined" | "skipped";

/**
 * Bare-`open-memex` first-run flow. `runInit` is injected so tests don't need
 * the real init. Returns "skipped" when there's nothing to ask (already set
 * up, or non-interactive) — the caller then prints usage as before.
 */
export async function offerFirstRunInit(
  runInit: () => Promise<void>,
): Promise<FirstRunOutcome> {
  if (!shouldOfferFirstRun()) return "skipped";
  console.log(
    `It looks like open-memex hasn't been set up on this machine yet.\n` +
      "`open-memex init` wires it into your editors (auto-detects VS Code, Cursor and opencode — and Visual Studio for solution projects).\n",
  );
  if (await askYesNo("Run it now? [Y/n] ")) {
    await runInit();
    return "initialized";
  }
  markFirstRunDone("declined");
  console.log("No problem — run `open-memex init` any time.");
  return "declined";
}
