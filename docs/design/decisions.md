## Decisions (append-only)

- **D1** — Markdown as source of truth, index rebuildable. *Rationale: human-editable, git-friendly,
  no lock-in; the single decision that makes team sharing trivial.*
  *Status (2026-11-02): 已实现 — `src/store/sync.ts:124` `syncScope()`.*
- **D2** — Instruction/data separation via `role` gate (iron rule 1). *Rationale: the #1 failure mode
  of memory systems is history being mistaken for current rules.*
  *Status (2026-11-02): 部分实现 — 铁律 1 的三元门（`role` + `instruction_state: approved` + `trust_level`）无代码执行：`instruction_state` / `trust_level` 字段在 `src/` 中不存在.*
- **D3** — `personal` scope never syncs. *Rationale: the trust anchor of the whole project.*
  *Status (2026-11-02): 已实现 — `docs/SCOPES.md:11,15`（"`personal` never leaves the machine. No sync, no upload, no exceptions."）.*
- **D4** — MCP is an interface, not the product identity. *Rationale: transports evolve; the protocol
  must outlive them.*
  *Status (2026-11-02): 已实现 — 共享 host-agnostic 层 `src/tools/ops.ts`，两适配器同引：`src/mcp.ts:57`、`src/tools/memory.ts:20`.*
- **D5** — Git is transport, local index is query layer. *Rationale: answers the "git can't do
  semantic search" objection by separating the two layers.*
  *Status (2026-11-02): 已实现 — 传输：`src/providers/git.ts:2,82`（GitProvider）.*
- **D6** — Promotion is explicit, never automatic. *Rationale: personal → shared is a governance
  decision, not a sync event.*
  *Status (2026-11-02): 已实现 — 无自动提升代码；提升只经显式 propose/submit/promote（src/review.ts、src/submit.ts）.*
- **D7** — Embeddings are an optional capability, BM25+CJK is the default. *Rationale: zero-setup
  default; no mandatory 100MB download or native dependency.*
  *Status (2026-11-02): 部分实现 — Embeddings 作为"可选能力"未实现：`src/` 无 embedding 实现，只有 0.8.0 CHANGELOG 的离线实验（`scripts/bench-semantic.ts`，未进产品）.*
- **D8** — Contested choices become **configurable with a popular default**, not hard-coded.
  Applies to: in-repo dir name (default `.ai/open-memex/` per D23), CJK tokenizer (default bigram),
  embeddings model (default `multilingual-e5-small`). *Rationale: the five-AI review split on all
  three; maintainers shouldn't burn decision capital where config suffices.*
  *Status (2026-11-02): 部分实现 — 另外两项未落地为配置：CJK tokenizer 选择与 embeddings 模型（`multilingual-e5-small`）在 `src/config.ts` 无对应键、`src/` 全文无 `e5-small`.*
- **D9** — The LAN reference server lives at `examples/remote-server/`. *Rationale: maintainer decision
  2026-09-26; "lan" is noise for OSS users, "remote-server" names what it proves (RemoteProvider).*
  *Status (2026-11-02): 未实现 — LAN 参考服务器未写.*
- **D10** — Project renamed to **OpenMemex** (npm `open-memex`, repo `stoneskin/open-memex`).
  *Rationale: `my-o-memory` was opencode-specific; the Memory Protocol positioning needs a broader name.
  Fresh repo with no company-account commit history (see migration checklist 2026-09-26); old repo
  archived with a pointer. Trademark check on "Memex"/"OpenMemex" required before public launch
  (flagged in round-4 review).*
  *Status (2026-11-02): 部分实现 — 商标检查条款无证据：全仓唯一提及是 `docs/design/decisions.md:25` 本身（"required before public launch"），但产品已公开发布（0.1.0，0.7.2 进 MCP Registry），未见检查完成记录.*
- **D13** — Rename cascade (implements D10 in this doc, 2026-09-26): npm package `open-memex`,
  CLI `open-memex` (e.g. `open-memex pull`), config dir `~/.open-memex/`, in-repo dir default
  `.open-memex/` (**amends D8's** `.my-o-memory/` default). MCP tool name `memory_search` unchanged.
  v1→v2 migration moves legacy `.my-o-memory/` dirs and `~/.my-o-memory/` config to the new paths
  (with backup, explicit via `open-memex migrate`). *Rationale: one name everywhere; the old default
  was set before the rename decision.*
  *Status (2026-11-02): 已实现 — npm 包 open-memex、CLI、~/.open-memex/；migrate 可转 legacy my-o-memory 数据；MCP 工具名 memory_search 未变.*
- **D11** — `type` and `role` remain separate. `type` describes what a memory IS; `role`
  (`knowledge` | `instruction`, default `knowledge`) describes how it may be USED. `role: instruction`
  is an explicit, reviewable exception and may enter instruction context only when iron rule 1
  (`role` + `instruction_state: approved` + `trust_level`) passes. *Rationale: content classification
  and behavior authorization are separate concerns — the risky action is entering instruction
  context, not the content's wording. Unanimous 5/5 in round-4 AI review, 2026-09-26.*
  *Status (2026-11-02): 部分实现 — 条款级：分离已做，但 D11 的门条件（`instruction_state: approved` + `trust_level`）未实现——两字段不在 `src/` 中.*
- **D12** — Pull is explicit by default. Session start never pulls, never blocks on network, and
  shows a staleness indicator instead. `sync.autoPull` is configurable, default `false`; even with
  `autoPull: true`, a failed pull never blocks the session and every pull emits a receipt.
  *Rationale: a memory pull can change agent behavior, so it must be a deliberate, visible act —
  predictable offline-first beats silent freshness. Unanimous 5/5 in round-4 AI review, 2026-09-26.*
  *Status (2026-11-02): 已实现 — `src/config.ts:88`（`sync: { autoPull: false }`）.*
- **D14** — Secret detection masks instead of refusing. A write-path secret hit is **masked in
  place** (first 4 characters kept, the rest replaced with `x`, length-preserving) and the write
  proceeds with a notice; `<private>…</private>` spans are still stripped to `[REDACTED]`.
  Amends the v0.2 rule "secret patterns refuse the write" (§8, §11). *Rationale: a refused write
  loses the surrounding context the user asked to remember; a prefix-masked secret stays
  recognizable (which key it was) while the credential itself is not recoverable from the file.
  Supersedes the refusal behavior; applies to every write path (tools, keyword capture, CLI).
  2026-09-27.*
  *Status (2026-11-02): 已实现 — `src/redact.ts:14-17`（头注）、`:194`（`<private>` → `[REDACTED]`）、`:202-206`（`maskMatch`：保留前 4 字符、其余换 `x`、等长）.*
- **D15** — Phase 2A MCP server ships with all five tools, not read-only first. The MCP server
  (`src/mcp.ts`, stdio) exposes `memory_add` / `memory_search` / `memory_list` /
  `memory_supersede` / `memory_forget` — amends the §18 roadmap's "Read-only MCP" phasing.
  *Rationale: the write path is the same Core (redact/D14, dedup, lifecycle) already shipped and
  dogfooded in the opencode plugin, so a separate read-only stage adds process cost without
  reducing risk. Core/adapters split implemented as `src/tools/ops.ts` (host-agnostic logic +
  shared zod schemas); the opencode plugin and the MCP server are thin adapters over it.
  Query-aware injection stays host-side: MCP is request/response and offers no hooks, so
  proactive memory use depends on the host's agent instructions. 2026-09-27.*
  *Update (2026-11-02): the server now exposes 11 tools (0.4.0 added six more); D15's five are the original subset.*
  *Status (2026-11-02): 已实现 — 五个工具均在 MCP server：`src/mcp.ts:208-250`（`memory_add`/`memory_search`/`memory_list`/`memory_supersede`/`memory_forget`）.*
- **D16** — No separate LLM extraction pass; memory intelligence lives in model-driven tool
  calls. A dedicated post-session extraction (opencode `session.idle` hook → hidden session
  → host model) was evaluated and rejected: the model's own decision to call `memory_add`
  *is* the LLM judgment of "worth remembering", so a second pass is redundant and
  host-specific. Investment goes into the shared layer instead — `TOOL_DESCRIPTIONS` in
  `src/tools/ops.ts` and each host's agent instructions — so every host benefits at once.
  Native plugins (opencode now; Claude Code / Codex as Phase 2C candidates) remain as
  hook-enhanced paths, but opencode is also supported as a plain MCP consumer of
  `open-memex mcp`, keeping one unified tool surface. 2026-09-27.
  *Status (2026-11-02): 已实现 — 否定性决策：src/ 无 extraction pass；共享描述层 src/tools/ops.ts:67.*
- **D17** — `open-memex init` resolves the MCP server command at init time. A durable
  `open-memex` on PATH (outside npm's ephemeral `_npx` cache) → `command: "open-memex"`;
  otherwise (one-shot `npx open-memex@alpha init`) → `command: "npx", args: ["-y",
  "open-memex@alpha", "mcp"]` plus a hint to `npm i -g` + re-run `init --force`.
  `mcp --print-config` uses the same resolution. *Rationale: a one-shot npx run leaves
  no bin behind, so writing `command: "open-memex"` would produce a dead MCP server on
  the next editor launch; the npx fallback keeps the one-command setup actually
  one-command. 2026-09-27.*
  *Status (2026-11-02): 已实现 — `src/init.ts:43-55`（`resolveServerCommand`：PATH 外 durable bin → `command: "open-memex"`，否则 `npx -y open-memex@alpha mcp`），调用点 `src/init.ts:171,485,530`.*

- **D18** — Keyword scope routing: 我 → personal, 我们 → project. Chinese capture
  keywords are split into two pattern lists: personal patterns (`记住我`/`替我记`/
  `我觉得`/`我喜欢`, plus legacy `remember for me`/`记住（个人）`) route to the personal
  scope, while project patterns (`我们认为`/`我们决定`/`帮我们记住`, and the generic
  `记住…` for `记住我们的…`) route to the current project scope. Personal patterns are
  scanned first and *claim* the line so the generic `记住…` pattern cannot double-fire;
  `记住我` uses a `(?!们)` guard so it never swallows `记住我们…`. *Rationale: the
  user's own rule — "我" is personal, "我们" is the current project — stated 2026-09-27;
  scanning user messages (never assistant output) with personal-first claim keeps one
  utterance to one memory. README + repo AGENTS.md keyword sections updated in the same
  commit. 2026-09-27.*
  *Status (2026-11-02): 已实现 — `src/capture/keywords.ts:38,68,82`（personal patterns 先扫并 claim，防 generic `记住…` double-fire）.*
- **D19** — `open-memex init` asks setup questions; `open-memex config set` edits settings
  after install. `init` prompts on a TTY (editor: vscode/cursor/opencode; keyword
  auto-capture on/off; first-turn injection on/off), `--yes` accepts all defaults, and
  non-terminal runs never prompt (scripts keep the historical vscode default).
  Non-default answers persist to the JSONC config file; `open-memex config set <key>
  <value>` changes them later (validated keys: `maxProjectMemories`, `maxProfileItems`,
  `injectOnFirstTurn`, `keywordCaptureEnabled`, `logLevel`). `init --client opencode`
  merges a `type: "local"` MCP entry into project-level `opencode.jsonc` (v1 format).
  *Rationale: install time is the only moment the user's attention is guaranteed, and a
  print-only `config` left no path to change settings afterwards. 2026-09-27.*
  *Status (2026-11-02): 已实现 — init 提问：`src/init.ts:594-654`（readline：`promptClient` / `promptInstructionsScope` / `promptConfigLevel`）.*
- **D20** — `init` / `mcp --print-config` support Visual Studio. Writes solution-level
  `.mcp.json` with the `"servers"` section (`{ "type": "stdio", "command", "args" }`),
  per Microsoft Learn (VS 2022 17.14+ / VS 2026, Windows-only). `.github/copilot-
  instructions.md` is still written — VS's Copilot reads it too. Note VS also
  auto-discovers `.vscode/mcp.json` and `.cursor/mcp.json`, so repos already set up for
  VS Code get VS support for free; the explicit `.mcp.json` is the source-controllable
  option. 2026-09-27.*
  *Status (2026-11-02): 已实现 — `src/init.ts:503-507`（`writeVisualStudioMcpJson`，solution-level `.mcp.json`，`"servers"` section）.*
- **D21** — The published npm package ships pre-compiled JS (`tsc -p tsconfig.build.json`
  → `dist/`, via `prepublishOnly`; bin points at `dist/cli.js`). *Rationale: Node's
  `--experimental-strip-types` refuses files under `node_modules`
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so the old launcher
  (`bin/open-memex.js` re-execing `src/cli.ts`) crashed on every global install —
  reported 2026-09-27 on Node v22.12.0. Development stays build-free (`npm run cli`
  / `npm run mcp` run `src/` directly); `doctor`'s MCP self-check resolves its server
  entry the same way it is running (`dist/mcp.js` vs `src/mcp.ts`). The opencode
  native plugin still loads `src/index.ts` (Bun strips types anywhere). 2026-09-27.*
  *Status (2026-11-02): 已实现 — `package.json:43`（`prepublishOnly: npm run build`）、`:42`（`build: tsc -p tsconfig.build.json`）、`:60-61`（bin → `dist/cli.js`）.*
- **D22** — `init` writes the Copilot memory instructions to the **user level** by
  default (`~/.copilot/copilot-instructions.md`; `%USERPROFILE%\copilot-
  instructions.md` for Visual Studio 2026) instead of the repo-level
  `.github/copilot-instructions.md`. *Rationale: the repo-level file is checked in,
  so teammates without open-memex get Copilot errors about missing `memory_*`
  tools. The user-level location is GitHub's official personal-instructions slot
  (highest priority, all projects, never in a repo). `--instructions project`
  keeps the old repo-level behavior for teams where everyone uses open-memex.
  The instructions carry a guard clause ("ignore this section when the
  `open-memex` MCP server is not available") as cheap insurance. 2026-09-27.*
  *Status (2026-11-02): 已实现 — `src/init.ts:634`（"Personal (default)"）、`:555-558`（默认写 `~/.copilot/copilot-instructions.md`，VS 2026 用 `%USERPROFILE%` 下同名文件）、`:641`（`--instructions project` 保留 repo 级行为）、`:884`（flag 校验）.*
- **D23** — Default in-repo memory dir is `.ai/open-memex/` (configurable via
  `memoryDir`; rejects absolute paths and `..`). *Rationale: `.ai/` is the
  emerging convention for AI-local project state; the `open-memex/` leaf keeps
  brand clarity and avoids collisions with other tools' `.ai/` content.
  2026-09-27.*
  *Status (2026-11-02): 已实现 — `src/config.ts:87`（默认 `".ai/open-memex"`）、`:175`（拒绝绝对路径与 `..`）.*
- **D24** — Project-scope markdown lives in the repo: writes with
  `scope: project` go to `<projectRoot>/<memoryDir>/` (D23 default
  `.ai/open-memex/`); `personal` never leaves appdata. Legacy appdata project
  files are lazily migrated on first write/`syncScope` — the move is guarded by
  the appdata dir name (which *is* the scope key), so it can only ever migrate
  the current scope's files. The index's `file_path` is the single locator for
  reads/deletes (`findMemoryFile`, `forget`); on the near-impossible id
  collision between locations, the in-repo copy wins. *Rationale: one home per
  scope, no silent data loss, no repo pollution before first use.* 2026-09-27.*
  *Status (2026-11-02): 已废弃 — 被 D26 取代（Supersedes D24）；appdata project 文件不再是 legacy，而是合法 draft.*
- **D25** — Review workflow semantics (`propose` / `promote` / `resolve`,
  `src/review.ts`): (1) `review_state` frontmatter field
  (`draft → proposed → approved/rejected → published`, default `draft`) plus
  `proposed_by` / `approved_by` / `derived_from` / `review_note` provenance;
  the SQLite index carries `review_state` (schema v6, rebuilt from markdown —
  D1). (2) `propose` **copies** personal → project (new id, never moves — the
  personal original stays private); one call takes several ids (one branch,
  one PR; all-or-nothing — a bad id aborts the whole batch);
  `--local-approve` skips the PR for solo
  devs. (3) `promote` advances exactly one step up the ladder
  (`proposed → approved → published`), `--reject`s with a note (also from
  `approved`, withdrawing approval before merge), or `--resubmit`s a rejected
  memory back to `proposed` for another round; `draft` and terminal states
  refuse. (4) `resolve` lists conflicted memory files, or
  attempts a field-level 3-way merge from git stages 1/2/3 (`tags` union,
  `updated_at` takes latest, body merged only when one side changed); semantic
  conflicts (same field / body changed differently on both sides) are reported
  and the file is left untouched — **never auto-resolved**. (5) A rejection
  never deletes anything: the file stays on the author's branch; the human
  accepts (close PR, delete branch), revises + `--resubmit`s, or keeps it as
  a `[rejected]` record. (6) No git
  automation anywhere in the workflow: no branch creation, no commits, no PRs —
  the commands print the exact next steps for the human. Org-level promotion is
  Phase 4. *Rationale: the review ladder must be explicit and auditable; the
  tool assists merging but a human always decides meaning.* 2026-09-27.*
  *Update (2026-11-02): "schema v6" in this entry is now v9; clause (6) was corrected by D27.*
  *Status (2026-11-02): 已实现 — `src/review.ts` 全套：(1) `review_state` + provenance `:122-126`（`proposed_by`/`derived_from`/`review_history`）.*
- **D26** — **Supersedes D24.** Project-scope markdown has two homes, one per
  lifecycle stage — never silently moved between them. (1) `memory_add` /
  `memory_propose` with `scope: project` write to the **appdata outbox**
  (`memories/<project_key>/<id>.md`, `review_state: draft`); the outbox is
  git-invisible and branch-independent. The D24 lazy migration is deleted —
  appdata project files are legitimate drafts, not legacy. (2) `open-memex
  submit <id...>` / `memory_submit` moves user-named drafts into the repo's
  `<memoryDir>/` (D23), flipping `review_state` to `proposed`: the file now
  follows branches and PRs. `sync-status` / `memory_status` shows both sides
  (outbox drafts, repo review states, uncommitted repo files). (3) The move is
  one-stage-one-place: copy → verify hash → local commit → verify → delete
  outbox original; re-running is idempotent (identical content skips, different
  content aborts). `search` prefers the repo copy when both exist; conflicts
  (same id, different content; push rejected) stop and ask the human — never
  overwrite. *Rationale: an AI agent drafts constantly; the repo should only
  ever see what the human explicitly approved for review. The outbox is the
  agent's desk, the repo dir is the shared table. Approved 2026-09-28.*
  *Status (2026-11-02): 已实现 — 取代 D24：outbox（appdata drafts）+ `submit`（`src/submit.ts:2,82-143`，`sync-status` 双边展示）.*
- **D27** — **Revises D25 §6 (no git automation).** `submit` automates the
  *local* half of the git workflow: create `mem/sync-<timestamp>` (or
  `--onto` the current branch for code+memory PRs), copy, `git add` only the
  memory files, local commit, verify. It prints the push + `gh pr create`
  commands for the human — but an agent that already holds the user's Yes for
  this sync carries through push and PR creation without re-asking (each step
  is not a separate approval). Batch submit is all-or-nothing; an empty-branch
  abort rolls the branch back. *Rationale: the old "no git automation" rule
  assumed a human at the keyboard; the agent-driven flow needs local mechanics
  automated while push/PR stay under the user's explicit per-sync Yes/No.
  Approved 2026-09-28.*
  *Status (2026-11-02): 已实现 — 修正 D25 §6：submit 自动化本地 git 半程——建分支 `mem/sync-<timestamp>`（`src/submit.ts:304-318`）、仅 `git add` 记忆文件（`:397`）、本地 commit（`:402`）、空分支 abort 回滚（`:383-384`）.*
- **D28** — Memory PR base defaults to the **current branch**; the user may
  redirect to `main` or the project's integration branch (`--base`). A
  standalone memory PR and a code+memory PR are both supported — the agent asks
  which one each time; on "with code" it uses `--onto` and never commits
  unrelated staged changes. *Rationale: memory usually reviews against the work
  it describes (current branch); the integration branch is the exception, not
  the default. Approved 2026-09-28.*
  *Status (2026-11-02): 已实现 — PR base 默认当前分支：`src/submit.ts:321`（`base = opts.base ?? startBranch`）.*
- **D29** — Every review transition is written to a per-memory audit trail
  (`review_history`: at/by/from/to/note) — reject / resubmit / approve /
  publish all append, never overwrite; `propose` and `submit` seed it; merge
  conflict resolution unions both sides' histories. *Rationale: review is a
  decision log, not a flag — "who rejected this and why" must be answerable
  months later. Approved 2026-09-28.*
  *Status (2026-11-02): 已实现 — `src/review.ts:126`（propose/submit seed `review_history`）、`:239-240`（promote/reject/resubmit 追加不覆盖）、`:459-465`（resolve 时 union 双方 history）.*
- **D30** — Retrieval ranks by review state: approved/published project
  memories outrank unreviewed content; project drafts/rejected sink to the
  bottom and are visibly tagged `[draft]` in search/list/inject output, while
  personal memories (always draft by design) are never demoted or tagged.
  Explicit search still finds drafts — they are deprioritized, not hidden.
  *Rationale: reviewed knowledge should win the context window; drafts stay
  discoverable but never masquerade as vetted. Approved 2026-09-28.*
  *Status (2026-11-02): 已实现 — src/retrieve/search.ts:111-126（reviewTier：approved/published → 0，personal → 1 不降级，draft/rejected → 2）.*
- **D31** — Every index sync records when it ran, what triggered it
  (`session` / `request` / `cli` / `submit`) and its stats, in
  `<appdata>/sync-state.json`; `sync-status` shows the last sync first.
  *Rationale: "is my index fresh?" must be answerable without guessing —
  especially across branch switches where the in-repo dir changes underneath.
  Approved 2026-09-28.*
  *Status (2026-11-02): 已实现 — src/store/sync.ts:180（SyncKind 7 种）；recordSync() 写 sync-state.json；sync-status 命令在位.*
- **D32** — The branch PR's GitHub state maps back onto each in-repo
  memory's review_state via `pr-status` / `memory_pr_status`: merged PR →
  published, PR approval → approved with `approved_by` = reviewer login,
  changes-requested → suggestion only (never auto-rejects). Report by
  default; `--apply` performs the mapped transitions locally (no push —
  inside the D27 line). Each memory keeps its own state: a human `rejected`
  is never overridden by a PR signal. *Rationale: the PR is where the team
  actually reviews — the mapping closes the loop without inventing new
  review UI. Approved 2026-09-28.*
  *Status (2026-11-02): 已实现 — `src/tools/ops.ts:89`（`memory_pr_status` 描述：merged→published、approval→approved、`approved_by` = reviewer、changes-requested 仅建议）.*
- **D34** — The MCP server sends session-start guidance in the handshake
  `instructions`: call `memory_status` at session start (and at work
  checkpoints); if the outbox has drafts, summarize and ask the user which to
  sync; proactive `memory_add`; `memory_search` before asking about the past;
  personal never leaves the machine. *Rationale: the init-written instruction
  files only exist if the user ran `init --client` — the handshake reaches
  every MCP client at connect time. Still advisory: no MCP consumer offers a
  hard session-start hook, and we do not claim otherwise. Approved 2026-09-28.*
  *Update (2026-11-02): the session-start `memory_status` call is now conditional (D53) — only when the server reports drafts; the Checkpoints section is retired.*
  *Status (2026-11-02): 部分实现 — **条款级修正（D53）**：D34 原文"session start 时调 `memory_status`"已改为有条件——仅当服务器报告有草稿时才调.*
- **D35** — "sync memory" (or "同步记忆") is a natural-language trigger for the
  sync flow: the agent calls `memory_status`, summarizes the outbox drafts, and
  asks the user which ones to sync — same flow as the session-start proposal,
  but user-initiated. Taught in the MCP handshake instructions, the
  init-written instruction files, and the `memory_status` tool description.
  *Rationale: the user should not have to remember command names to sync;
  saying it in words must work. Approved 2026-09-28.*
  *Status (2026-11-02): 已实现 — `src/mcp.ts:94-97`（用户说 "sync memory"/"同步记忆" → 调 `memory_status`，绝不直接浏览数据目录）.*
- **D36** — `submit` never creates a branch on its own (revises D26/D27): it
  copies the named drafts into `.ai/open-memex/`, commits locally on the
  CURRENT branch, and prints next-step commands. Branch creation is the human's
  call — or the agent's, only with explicit approval for the full chain, via
  `submit --branch <name>` / `memory_submit(branch=...)`. *Rationale: an
  auto-created branch strands the user on it — they forget to switch back.
  After a submit the agent asks ONE follow-up ("want me to create a branch +
  push + open the PR, or will you handle it yourself?") instead of branching
  silently. Checkpoints that trigger `memory_status`: session start, end of a
  work chunk, after the user commits, and after any memory_* action.
  The "sync memory" trigger ALWAYS goes through the `memory_status` tool —
  never by browsing the appdata directory directly. Approved 2026-09-28.*
  *Status (2026-11-02): 部分实现 — **条款级修正（D53）**：条目末尾所列"触发 `memory_status` 的检查点（session start / 工作块结束 / commit 后 / memory_* 后）"已随检查点机制退役，提示词中不再有 Checkpoints 一节.*
- **D33** — Every CLI command answers `open-memex <command> --help` (and `-h`)
  with its own usage, flags, and examples; checked before config/DB load so
  help works even in a broken environment. Unknown commands with `--help`
  fall back to the global usage. *Rationale: AI assistants discover the CLI
  through --help first — a command that silently swallows --help as a flag
  teaches the agent nothing. Approved 2026-09-28.*
  *Status (2026-11-02): 已实现 — `src/cli.ts:722-724`（`--help`/`-h` 在 `loadConfig()` 之前处理，注释明示）.*
- **D37** — Conversation distillation is the memory unit; transcript storage is
  not the default. Capture should preserve the useful conclusion from a human/AI
  session — what was learned, what resolved the issue, what should be avoided,
  and where the authoritative doc lives — as a short reviewable memory. If the
  knowledge already exists in docs, store a `reference` memory with
  `canonical_ref` instead of duplicating the doc. Tags are retrieval hints, not
  content kinds: `type` classifies the memory, tags describe topics/tools/paths.
  *Rationale: full chat logs are noisy, harder to review, and riskier for
  privacy; the value is remembering the right conclusion at the right scope,
  with enough context for the next human or AI session. Approved 2026-09-28.*
  *Status (2026-11-02): 部分实现 — **缺口**：条目所说的 `reference` 记忆带 `canonical_ref` 字段——`Frontmatter`（`src/store/markdown.ts:44-80`）中**没有 `canonical_ref` 字段**，文档链接只能写在正文里.*
- **D38** — OpenMemex supports a Markdown second-brain use case while keeping
  distillation as the default for implicit/model-suggested capture. If the user
  explicitly asks to save a long note, meeting summary, troubleshooting record,
  or write-up, preserve it as user-authored Markdown with tags and normal
  scope/privacy rules. Git/GitHub sync is the default team-sharing provider, not
  the product boundary: future export/import archives and API-backed providers
  may move the same markdown memories to other computers, applications, or
  enterprise systems. For generic "save/remember/note this" requests, the agent
  routes project-specific knowledge to `project`, personal or repo-unrelated
  knowledge to `personal`, and asks one clarification if ambiguous; `org` remains
  curated/future, never a direct single-user chat write. *Rationale: users also
  want a local AI-assisted second brain, but portability and ownership must stay
  explicit; sharing mechanisms should be provider choices over the same memory
  model, not the identity of the product. Approved 2026-09-28.*
  *Status (2026-11-02): 已实现 — 长文仅用户明示才存：`src/mcp.ts:111`（"Long-form notes are fine ONLY when the user explicitly asks"）.*
- **D39** — `type` and `tags` are complementary axes, not alternatives. `type` is
  single-valued: what the memory IS — it drives behavior (lifecycle, review,
  rendering, retrieval: a `todo` can be completed, a `reference` resolves
  `canonical_ref`, a `decision` participates in supersede chains). `tags` are
  multi-valued: what the memory is ABOUT — pure retrieval hints
  (topics, tools, subsystems, paths, incidents). *Rationale: without type the
  system cannot tell "a todo I must do" from "a fact I must know" even when both
  are tagged `auth`; without tags, cross-cutting retrieval ("everything about
  onboarding") would need a combinatorial type explosion. Type answers "how do I
  handle this?", tags answer "how do I find this?". Approved 2026-09-28.*
  *Status (2026-11-02): 部分实现 — **缺口**：条目举例 "a `reference` resolves `canonical_ref`"——无 `canonical_ref` 字段（同 D37）.*
- **D40** — `open-memex export` excludes `visibility: private` memories by
  default; `--all` / `-a` includes everything, for a full personal migration to
  a new machine. *Rationale: the safe default protects privacy; the escape hatch
  keeps the "no walled garden" promise — the user can always take everything
  with them. Approved 2026-09-28.*
  *Status (2026-11-02): 已实现 — `src/cli.ts:262-275`（export 用法：默认排除 `visibility: private`，`--all`/`-a` 全量）.*
- **D42** — §3.5 checkpoint distillation is taught in the MCP handshake
  instructions (`src/mcp.ts` `SERVER_INSTRUCTIONS`) and the `init`-written
  instruction files (`src/init.ts` `INSTRUCTIONS`): at checkpoints the agent
  DISTILLs the session and proposes 1–3 short memories (conclusion, not
  transcript); nothing is saved without user approval. Approved captures are
  saved via `memory_add` with the new optional `source` param set to
  `"inference"` (default `"tool"`). *Rationale: closes the 0.4.0 TODO from D41 —
  the design's capture loop now reaches the agent. Implemented 2026-09-29.*
  *Status (2026-11-02): 已实现 — `memory_add` 的 `source` 参数：`src/tools/ops.ts:128-132`（"Pass 'inference' for agent-proposed captures"）.*
- **D43** — `distill-agents` output gains a "Memory hygiene (open-memex)"
  footer carrying the §3.5 checkpoint guidance (propose 1–3 distilled captures
  at checkpoints; save nothing without approval; prefer `reference` over
  copying). *Rationale: double insurance for opencode users, who never see the
  MCP handshake instructions or the `init`-written instruction files — but
  opencode reads AGENTS.md natively, so the distilled snippet teaches the
  checkpoint habit wherever it lands. Approved 2026-09-29.*
  *Status (2026-11-02): 已实现 — `src/distill-agents.ts:73`（输出 `### Memory hygiene (open-memex)` footer）.*
- **D44** — `migrate --to-v2` hotfix (issue #7, 0.4.1): (1) `--dry-run` now
  previews the legacy `my-o-memory` files in place — per-file conversion plans
  without moving anything (previously it scanned only the new, still-empty
  root and always reported "0 files", making the preview useless); (2) dry-run
  no longer prints the false "legacy data dir merged" line; (3) the Windows
  EPERM on the legacy-dir backup rename is caught and rethrown as an actionable
  message (close the program holding the folder — e.g. a running MCP server —
  and re-run; nothing was deleted), and the CLI prints it as `Error: …` with
  exit 1 instead of a raw syscall stack; (4) `parseFlags` accepts `--key=value`
  in addition to `--key value` (the `=` form was silently misparsed before,
  dropping the flag — which can turn a `--dry-run` into a real run).
  *Rationale: a preview that shows nothing is worse than no preview — the user
  cannot confirm what the real run will do; and a destructive-path failure must
  speak in user terms. Shipped as 0.4.1 hotfix on the stable line. Approved
  2026-09-29.*
  *Status (2026-11-02): 已实现 — `src/store/v2migrate.ts:220-243`（`dryRun` 时就地预览 legacy 文件的转换计划，`:243` 仅非 dry-run 才落盘）.*
- **D45** — `init --global` (0.5.0-alpha.1): one-time user-level MCP wiring for
  VS Code / Cursor. Writes the open-memex server entry to the editor's
  user-level `mcp.json` (`%APPDATA%\Code\User\mcp.json` on Windows,
  `~/Library/Application Support/Code/User/mcp.json` on macOS,
  `~/.config/Code/User/mcp.json` on Linux; `~/.cursor/mcp.json` for Cursor)
  instead of the project's `.vscode/mcp.json` — init once, the server starts
  in every project. The entry keeps `cwd: "${workspaceFolder}"` so VS Code
  substitutes it per window and project-scope resolution keeps working;
  a per-project config still wins when present. Merge semantics are shared
  with project-level init (merge, never clobber; `--force` overwrites).
  Interactive `init` now asks per-project vs user-level for vscode/cursor
  (default: per-project, preserving old behavior); `--global` skips the
  question. For opencode, `--global` is a no-op that prints the native-plugin
  one-liner (already global, and strictly more capable than plain-MCP mode);
  Visual Studio stays solution-level by design. *Rationale: per-project init
  is a paper cut that compounds — the data layer already needs zero per-project
  setup (scope is derived from cwd), so the editor wiring should be able to
  match. Approved 2026-09-29.*
  *Update (2026-11-02): opencode --global now merges into ~/.config/opencode/opencode.json (D46); the hint-only wording is superseded.*
  *Status (2026-11-02): 已实现 — `src/cli.ts:379-393`（`init --global` 用户级 MCP 写入）.*
- **D41** — The type taxonomy is reconciled to 11 types with one-line definitions
  (§3.1): `fact` `preference` `decision` `constraint` `todo` `knowledge` `howto`
  `gotcha` `lesson` `observation` `reference`. Merged away: `warning`→`gotcha`,
  `workflow`→`howto`, `incident`→`lesson` (incident id goes in `tags`),
  `architecture`→`knowledge` (tag `architecture`). *Rationale: a type earns its
  place only if the system treats it differently (lifecycle, retrieval,
  rendering); otherwise it is a tag. Fifteen types blur classification and hurt
  agent accuracy — eleven keeps each type's behavioral slot distinct. `lesson`
  is deliberately broader than `incident`: a postmortem's shape (timeline, root
  cause, actions) is a template concern, not a type. Code
  `MEMORY_TYPE_TAXONOMY` updated to match. Approved 2026-09-28.*
  *Status (2026-11-02): 已实现 — `src/store/markdown.ts:14-26` `MEMORY_TYPE_TAXONOMY` 恰为 11 类（fact/preference/decision/constraint/todo/knowledge/howto/gotcha/lesson/observation/reference）.*
- **D46** — `init` with no `--client` auto-detects installed editors and wires
  them all (0.5.0-alpha.2). Detection: VS Code via `code` on `PATH`, well-known
  install locations, or an existing user-level `mcp.json`; Cursor via `cursor`
  on `PATH` or `~/.cursor`; opencode via `opencode` on `PATH` or its global
  config dir; Visual Studio only when the project has a `.sln` (solution-scoped
  by design). Auto mode always wires user-level where the editor supports it —
  VS Code / Cursor MCP entry (D45), and for opencode the native plugin entry is
  now *actually merged* into `~/.config/opencode/opencode.json` (replacing D45's
  hint-only `--global`), so one init covers every editor and every project.
  A config file with comments (JSONC) is never rewritten — init prints the
  manual one-liner instead. Interactive `init` shows the detected editors and
  confirms wiring all of them (declining falls back to the single-editor
  prompt); non-interactive (`--yes`) wires all detected with no prompts.
  An explicit `--client` keeps the old single-editor behavior, including the
  per-project default for vscode/cursor. *Rationale: Stone's two hats — he
  writes code in several editors himself, and new users / pilot colleagues
  should not have to learn `--client` to get started. The help text already
  promised "default: auto-detect"; D46 makes the code keep that promise.
  Approved 2026-09-29.*
  *Status (2026-11-02): 已实现 — `src/init.ts:841`（无 `--client` 时 auto-detect 并全接）.*
- **D47** — when `init` refuses to touch a config file that isn't valid JSON
  (usually JSONC with comments — VS Code / Cursor / opencode all accept them),
  it now prints the exact snippet to add by hand: the section key plus the
  `"open-memex"` entry, pretty-printed. Covers all three MCP-writing paths —
  vscode/cursor (user + project level), opencode project-level `opencode.jsonc`,
  and Visual Studio `.mcp.json` — matching the manual hint the opencode
  `--global` plugin path already printed (D46). The file is still never
  rewritten; the hint just makes "fix it manually" actionable. Triggered by
  Stone's real Windows run: his user-level `mcp.json` had comments, init
  correctly left it alone, but the old message gave him nothing to paste.
  *Rationale: a refusal without a remedy is a dead end; the entry shape is
  already computed, so printing it costs nothing. Approved 2026-09-29.*
  *Status (2026-11-02): 已实现 — `src/init.ts:231` `parseJsonConfig`.*
- **D48** — new `open-memex uninstall` command, the reverse of `init`
  (0.5.0-alpha.4). Removes the MCP server entry / opencode native plugin line /
  Copilot instructions section that `init` wrote; memory data is never touched.
  Client resolution mirrors `init` (explicit `--client`, else auto-detect with
  an interactive confirm). Without `--global` it cleans both project-level and
  user-level files — init may have written either, and a leftover entry at the
  other level would be a surprise; `--global` restricts to user-level. Empty
  sections/arrays are pruned; an instructions file that only held the
  open-memex section is deleted. Non-JSON (JSONC) configs are left untouched
  with the manual step, same D47 treatment as the init write path.
  *Rationale: Stone asked "有 uninstall 吗" while testing init on Windows —
  every write deserves an undo. Approved 2026-09-29.*
  *Status (2026-11-02): 已实现 — `src/cli.ts:396-411`（`uninstall [--client ...] [--global] [--yes]`）.*
- **D49** — empty config files are no longer treated as corrupt (0.5.0-alpha.5).
  Stone's real Windows run: his user-level `mcp.json` existed but was empty,
  and `init` refused it with "not valid JSON — left untouched", because
  `JSON.parse("")` throws. New `parseJsonConfig` helper: empty or
  whitespace-only content parses as `{}` — there is nothing to preserve, so
  writers safely populate it; genuinely unparseable content (JSONC comments)
  or non-objects still return null and keep the D47 leave-untouched + manual
  hint behavior. Applied to all five config file touch points: the three init
  writers (vscode/cursor MCP, opencode `opencode.jsonc`, Visual Studio
  `.mcp.json`) and the two uninstall removers (empty file = nothing to remove).
  *Rationale: an empty file is the safest write target, not a corrupt file;
  refusing it sent the user down a manual path for no reason. Triggered by
  Stone's report 2026-09-29.*
  *Status (2026-11-02): 已实现 — `src/init.ts:231` `parseJsonConfig`（空/纯空白内容解析为 `{}`）.*
- **D50** — close the install→init gap (0.6.0-alpha.1). `npm install -g`
  only puts the CLI on PATH; the editor wiring is `init`'s job, and a clean
  reinstall wipes it — Stone hit exactly this on 2026-09-30 (fresh opencode
  reinstall + `npm i -g open-memex`, then no open-memex in `opencode.jsonc`).
  Two changes, both CI-safe: (1) a `postinstall` script that **prints**
  `Run \`open-memex init\`…` — postinstall must never prompt, it runs in CI /
  Docker / `npm ci` where stdin isn't a terminal; (2) bare `open-memex` on a
  machine where init never completed **offers** to run it (default yes) when
  stdin+stdout are TTYs, otherwise prints usage exactly as before. Asked-state
  is a `.init.json` marker at the data root — init writes it on success, a
  declined offer writes it too, so the question is asked once; `uninstall`
  removes it (unwiring is the reverse of init, so the next bare run offers to
  wire again). The marker is a dotfile and export builds from DB rows, so it
  can't leak into bundles. The offer re-execs `open-memex init` as a child
  with inherited stdio rather than calling init in-process — the offer's own
  readline already consumed stdin's buffer, and a second readline on the same
  stream would see EOF on burst input (verified with a pty test).
  *Rationale: install ≠ setup, and the gap only shows up on a fresh machine —
  exactly when the user has the least context. A printed hint covers the
  install moment; the interactive offer covers the first-run moment; neither
  can hang a pipeline. Approved 2026-09-30.*
  *Status (2026-11-02): 已实现 — `package.json:44` `postinstall` 脚本.*
- **D51** — close the init→first-use gap (0.6.0-alpha.2). D50 gets the user to
  a wired editor; a first-time user then stops at "it's wired" with no idea
  what to do next. `init` now ends with one concrete next step:
  ``Next step: `open-memex add "standup is at 9:30"` — then ask your agent what
  it remembers.`` One line, printed unconditionally — the cheapest possible
  onboarding after wiring. *Rationale: the CLI is editor-independent, so the
  hint works no matter which client was wired; `add` + recall is the smallest
  loop that proves the whole system works. Approved 2026-09-30.*
  *Status (2026-11-02): 已实现 — `src/init.ts:960`（`Next step: open-memex add "standup is at 9:30"`）.*

- **D52** — agent-prompt clarity rewrite (0.6.0-alpha.3). Both agent-facing
  prompts (MCP `initialize` instructions in `src/mcp.ts`, init instruction
  template in `src/init.ts`) are rewritten to fix ambiguities found on review:
  (1) the proactive-save vs approval-gate contradiction is resolved by naming
  the two cases — facts the user *states* are saved proactively, conclusions
  the agent *infers* are proposed first and saved only on approval;
  (2) `memory_status`/`memory_search` are excluded from the "after any
  memory_* action" checkpoint trigger (self-trigger loop);
  (3) tool names use the full `memory_*` form in both prompts;
  (4) the four checkpoints are defined once as "Checkpoints" and referenced,
  with an operational heuristic ("a task the user would describe in one
  sentence") replacing "meaningful chunk of work";
  (5) empty outbox → do nothing; "the user commits" → "any git commit in this
  session"; `type "reference"` named explicitly; PR-base mechanics spelled out
  per D28. *Rationale: these prompts are the product's UI for agents — a
  literal-minded agent must execute them correctly without guessing.
  Approved 2026-10-01.*
  *Update (2026-11-02): clauses (2) and (4) relied on the Checkpoints mechanism retired by D53; the remaining clauses stand.*
  *Status (2026-11-02): 部分实现 — **条款级修正（D53）**：涉及检查点的子句 (2)（`memory_status`/`memory_search` 排除自触发）和 (4)（四检查点定义一次并引用）所依赖的检查点机制已于 D53 退役，提示词中已无 Checkpoints 一节.*

- **D53** — push-not-poll outbox: the checkpoint mechanism is retired; code
  pushes state to the agent instead (0.6.0-alpha.4). `src/submit.ts` gains
  `outboxDraftCount()` (one indexed SQLite COUNT on the current scope's outbox,
  no git I/O); `src/tools/ops.ts` gains `withOutboxNote()`, which appends
  `[open-memex: N draft(s) waiting in the project outbox — call memory_status
  to review]` to mutating tool results, only when N > 0. It is wired into the
  five MCP mutating tools (`memory_add`, `memory_supersede`, `memory_forget`,
  `memory_submit`, `memory_propose`) and the three opencode-plugin mutating
  tools (`memory_add`, `memory_supersede`, `memory_forget` — there the note
  stays generic because the plugin has no `memory_status`). The MCP server
  also appends the live draft count to the `initialize` instructions when N >
  0 (stdio servers start fresh per session, so construction-time state is
  session-start state). Both agent-facing prompts drop the Checkpoints section
  and the post-`memory_submit`/`memory_propose` status checks; the sync rule
  becomes one line ("when the server reports drafts waiting, call
  `memory_status`") plus the existing "sync memory" trigger. The static init
  template keeps one explicit session-start `memory_status` call, since a
  static file cannot carry live state. An anti-nag clause is added: if the
  agent already asked about these drafts this session, it does not ask again.
  *Rationale: the server knows the outbox state; making the agent poll for it
  on a timer wastes tool calls and teaches a habit that scales badly. The note
  is silent when the outbox is empty, so the common case costs nothing.
  `memory_submit` drains the outbox, so its own note is naturally silent.
  Approved 2026-10-01.*

- **F28** — install→init reminder was invisible (0.6.0-alpha.5). The D50
  postinstall pointer never reaches the user: npm runs lifecycle scripts in
  the background and swallows their stdout unless `--foreground-scripts` is
  passed (reproduced on npm 10.9.4 — the script ran with code 0, its output
  never displayed). The install-time channel is therefore best-effort only.
  Fix: every CLI entry point now prints a one-line nudge on stderr until init
  has run or been declined (`open-memex init` wires editors), gated by the
  existing `.init.json` first-run marker — stderr keeps the MCP stdio protocol
  (stdout) intact, so even `open-memex mcp` spawned by an editor carries it
  safely. `init`/`uninstall` are excluded. The bare-`open-memex` interactive
  offer on a TTY (D50) is unchanged. *Rationale: the reminder must live in a
  channel the project controls — the CLI — not in npm script output.
  Reported 2026-10-01.*

- **F29** — Copilot review fixes on PR #11 (0.6.0-alpha.7). (a) The lockfile
  carried a stray `"version": "0.6.0-alpha.1"` key as a direct child of
  `packages` (left by the D50 version bump; hand-edited bumps preserved it) —
  `npm ls --package-lock-only` failed on it. Removed; version bumps now go
  through `npm pkg set` so npm owns the lockfile format. (b) D53 missed the
  shared `TOOL_DESCRIPTIONS.memory_status`: it still told agents to call the
  tool "at session start and at task checkpoints" — the polling this change
  retires. Now: session start, server-reported drafts, or explicit "sync
  memory". Same staleness removed from the `source` field hint. (c) Onboarding
  strings (postinstall note, first-run nudge, bare-CLI offer) now mention
  Visual Studio auto-detection for solution projects instead of listing only
  three editors. *Lesson: never hand-edit version fields in package-lock.json.
  Reported 2026-10-01.*
  *Status (2026-11-02): 已实现 — `src/submit.ts:163` `outboxDraftCount()`.*

- **D54** — Agent Skills support (0.6.0-alpha.8). Ship a bundled
  `open-memex` skill (`skills/open-memex/SKILL.md`: frontmatter + CLI guide —
  proactive save, search, scope routing, outbox→submit flow) inside the npm
  package. `init` copies it (not symlinks — Windows needs no Developer Mode)
  into each wired editor's user-level skills dir: VS Code →
  `~/.copilot/skills/open-memex/`, Cursor → `~/.cursor/skills/open-memex/`,
  opencode → `~/.config/opencode/skills/open-memex/`; Visual Studio has no
  skills concept and is skipped. User-level by design (D46: init once). An
  existing skill is never clobbered silently — kept unless `--force`.
  `uninstall` removes only the `open-memex` skill directory. The skill tells
  agents to prefer MCP tools (`memory_add` etc.) when available and fall back
  to the CLI otherwise (with the `npx -y open-memex@latest` prefix when the
  CLI isn't on PATH). *Rationale: skill-aware agents get memory with zero MCP
  configuration; the skill is the CLI-shaped complement to the MCP server.
  Requested by Stone 2026-10-01 after the Agent Skills ecosystem suggestion.*

- **F30** — Sweep pre-rename `my-o-memory` leftovers (0.6.0-alpha.9). The
  my-o-memory → open-memex rename left editor configs behind that still load
  the OLD plugin/server, which writes to the OLD data dir — silently splitting
  the user's memories in two (found live on Stone's work machine 2026-10-01:
  the old opencode plugin sat above the new one in `opencode.json`, so
  opencode and the CLI wrote to different data roots). `init` now drops stale
  `my-o-memory` plugin entries and `my-o-memory` MCP server keys wherever it
  touches a config (opencode global plugin list, per-project `opencode.jsonc`,
  `.mcp.json`, VS Code/Cursor `mcp.json` incl. `--global`), even on the
  "kept" path; JSONC files it can't parse get a manual-removal hint.
  `uninstall` sweeps the same leftovers. `doctor` gains a read-only
  `legacy my-o-memory` check: fails when a legacy data dir exists next to the
  data root, when a user-level config still references `my-o-memory`, or when
  `MY_O_MEMORY_HOME` points at a pre-rename dir. *Lesson: a package rename
  must clean up its own old wiring — the old entry and the new entry are never
  both valid. Reported 2026-10-01.*
  *Status (2026-11-02): 已实现 — `skills/open-memex/SKILL.md` 存在于包内.*

- **D55** — opencode's native plugin supersedes the Agent Skill
  (0.6.0-alpha.10). Real-world feedback (Stone 2026-10-01): with both the
  native plugin's `memory_*` tools and the D54 skill installed, opencode's
  agent turned chatty — two overlapping instruction sets plus a "use MCP or
  CLI?" choice on every memory action. No data corruption (identical saves
  dedupe), but the UX regressed from "one tool call and done" to narration.
  `init` no longer installs the skill for opencode when the native plugin is
  wired (`--global`), and removes a previously installed one; the per-project
  plain-MCP mode keeps the skill as the no-tools fallback. VS Code/Cursor
  keep the skill — their MCP wiring is more fragile (server-start failures,
  policy blocks), so the fallback still earns its keep, and the skill already
  tells agents to prefer MCP tools when available. *Lesson: don't ship two
  overlapping integrations for the same editor — the agent pays the
  duplication cost in chatter. Reported 2026-10-01.*
  *Status (2026-11-02): 已实现 — `src/init.ts:920-924`（opencode 有 native plugin 时不装 skill，并移除已装的）.*
- **D56** — question-shaped searches and host parity, said out loud
  (0.6.1-alpha.1). Two-persona review (Stone 2026-10-03) converged on small,
  honest fixes rather than new machinery. (1) Retrieval already OR-ed terms
  and ranked with bm25, but fed whole questions ("how do we configure…",
  "中文记忆怎么检索") straight into FTS — question words matched everything
  and diluted ranking. Query construction now filters a small EN/CJK
  function-word set, dedupes, and caps terms at 24 per side, with a
  never-empty fallback (query.ts; partially answers the retrieval-robustness
  open question — layers 2 agent-side expansion / 3 capture-time aliasing
  remain open, embeddings stay reserved). (2) The plugin(5)/MCP(11) tool
  asymmetry is now stated in the six MCP-only tool descriptions themselves,
  with the CLI equivalent named, so an agent looking for `memory_status`
  inside opencode finds the answer instead of assuming breakage (the
  host-parity open question's "document it" option; true parity undecided).
  (3) `init`'s closing lines gain a one-line privacy statement at the moment
  of maximum doubt: memories live only on this machine, personal ones never
  leave it, nothing is uploaded.
  *Status (2026-11-02): 已实现 — (1) `src/retrieve/query.ts:33` `MAX_TERMS = 24`、function-word 过滤.*

- **D57** — explainable search, a memory audit, and the concurrency posture
  written down (0.6.1-alpha.2; addresses most of the retrieval-explainability
  / memory-health open question and establishes the concurrent-sessions
  behavior it asked for). (1) `open-memex search --explain` prints the
  constructed FTS expression, per-hit bm25 score, and how many matches
  lifecycle hid (superseded vs retracted/archived), so a miss is diagnosable
  — bad query, stale memory, or chain-hidden — without reading the index.
  (2) New `open-memex audit` (read-only; doctor checks the environment, this
  checks the memories): near-duplicate active pairs (same ≥ 0.8 Jaccard as
  write-time dedup), actives untouched for 90+ days, broken supersede chains,
  personal files found inside the in-repo memory dir (iron-rule breach), and
  index/file drift. Reports only; fixes stay with `supersede` / `forget` by
  hand. (3) Concurrency, measured: every process opens its own connection to
  one WAL index; memory files are per-memory ULIDs, so concurrent writes to
  *different* memories never collide on disk. SQLite was the gap — no
  `busy_timeout` was set, so better-sqlite3 silently tolerated 5s while
  bun:sqlite (opencode plugin) timed out at 0 and failed instantly under any
  overlapping write. Now unified at `PRAGMA busy_timeout = 5000` in `db()`.
  Past the timeout the CLI prints one plain line ("store is busy … nothing
  was lost") instead of a stack trace — and nothing *is* lost: the memory
  file is written before the index update, so the next sync reconciles it
  (verified end-to-end: a write blocked 8s still lands once the lock frees).
  Memory file writes are tmp+rename, so a concurrent reader never sees a
  torn file. Same-memory concurrent edits remain last-writer-wins (accepted:
  different processes editing the same memory simultaneously is a human
  conflict, not a storage one). `doctor` reports the live locking settings.
  *Status (2026-11-02): 已实现 — (1) `src/cli.ts:114-120` `search --explain`.*

- **D58** — the opencode plugin must never runtime-import the host SDK
  (0.6.1-alpha.3). Field report: after a global `npm i -g open-memex`, the
  plugin was configured in `~/.config/opencode/opencode.jsonc` but silently
  inactive — no memory tools, no error, nothing in opencode's log. Bisected
  with the real host (opencode 1.18.34) and a minimal plugin: a bare
  `file://` entry loads fine; adding `import { tool } from
  "@opencode-ai/plugin/tool"` makes opencode skip the plugin without a
  trace. That import only ever resolved from a source checkout (where
  `npm install` provides the devDependency); from a global install's
  location nothing provides the module and the host does not resolve it
  for file:// plugins. The helper is a runtime identity (`return input`),
  so the fix is a local same-signature stand-in in `tools/memory.ts` —
  types still come from the SDK (type-only imports erase at runtime), and
  the plugin now depends only on real runtime dependencies. Verified in
  the real host against a global-install-shaped tree: all five tools
  register. Rule going forward: plugin code imports host SDK types only;
  runtime imports must resolve from the package's own dependencies.
  *Status (2026-11-02): 已实现 — `src/tools/memory.ts:2` 仅 `import type`（`@opencode-ai/plugin`）.*

- **D59** — `doctor` patrols the plugin entry it used to take on faith
  (0.6.2-alpha.1). D58's failure was invisible to every existing check:
  `doctor` verified the MCP server end-to-end but never looked at the
  opencode plugin entry, so a configured-but-dead plugin passed all
  checks. The new `opencode plugin` check reads the user-level opencode
  configs (`opencode.json` + `opencode.jsonc`), attributes entries to
  this plugin by package path or the `[open-memex]` marker (source
  checkouts live anywhere), and fails when (a) the entry's target file
  does not exist — with the `init --force` re-point command named — or
  (b) the entry's relative-import closure runtime-imports
  `@opencode-ai/plugin`, the exact D58 death. It checks only what can be
  attributed; per-project and MCP wiring are out of scope.
  *Status (2026-11-02): 已实现 — `src/doctor.ts:191` 起 `opencode plugin` 检查（入口文件存在 + 导入闭包不 runtime-import host SDK）.*

- **D60** — one plugin serves both opencode generations (0.7.0-alpha.1).
  Opencode 2 changes the plugin contract end to end: config reads
  `plugins` (directories or `{package}` objects) instead of v1's
  `plugin` file entries, a v1-style file entry only earns a log warning
  ("configured plugin path must be a directory") and is silently skipped
  — the D58 death in a new shape; and the plugin value itself is a
  structurally decoded `{ id, setup(ctx) }` rather than the v1 server
  factory. A single `open-memex init --client opencode --global` now
  writes both keys (`plugin` file URL and `plugins` directory): each
  host loads from its own key — verified: opencode 1.18.34 ignores the
  `plugins` array with a config-normalization warning, and opencode 2
  warns per `plugin` file entry but loads the directory entry — so users on either generation get a
  working plugin from the same install. `src/index.ts` default-exports
  `{ id, setup, server }`: v2 calls `setup`, v1 calls `server`, the
  shared logic (bootstrap, keyword capture, one-time injection) lives in
  `src/plugin-core.ts`. Cost of the bridge on the v1 side: v1 hosts
  older than 1.18.29 only invoke function default exports and would
  skip this object; 1.18.29+ accepts it — the README states the new
  minimum. The v2 adapter (src/opencode-v2.ts) obeys D58's rule — no
  runtime `@opencode/plugin` import (a devDependency again); the
  context is duck-typed from the 2.0 surface, tool arg shapes compile
  from the same zod shapes via `z.toJSONSchema`, and hooks map
  one-to-one (session `prompt` → keyword capture, session `context` →
  first-turn injection). One registration subtlety cost real debugging
  time and is worth recording: on 2.0.1 a plugin tool added without
  options is exposed to the model only in code mode — callable through
  an `execute` meta-tool that runs model-written JS
  (`tools.memory_search(...)`) — and a model that instead calls the
  tool by name gets a host-side "Unknown tool" error, so whether the
  memory tools work at all depends on the model's calling style. Each
  tool therefore registers with `options: { codemode: false }`, which
  restores plain function calling (verified: direct calls execute
  first try). The D59 doctor check extends to both keys:
  v2 entries are checked for an existing, resolvable entry file and the
  closure scan now covers `@opencode/plugin` too, plus a generation
  advisory — when the installed host and the config point at different
  generations, doctor fails and names the fix (`init --force`; package-
  name entries installed via `opencode plugin add` are recorded but not
  path-checked). Field-verified on real hosts 1.18.34 and 2.0.1.
  *Status (2026-11-02): 已实现 — `src/index.ts:54` 默认导出 `{ id, setup, server }`.*

- **D61 — proactive capture cluster: propose posture, a shared
  memorability rubric, and capture-time aliasing (retrieval layer 3).**
  Builds on the "proactive capture" open question below and the
  CHECKPOINT_PROACTIVITY / MEMORY_VISIBILITY notes. Three pieces,
  shipped together because they are one user-visible behavior — the
  agent capturing well without being asked each time:
  (1) **Posture: propose, not auto-draft.** When the agent finishes a
  task the user would describe in one sentence, it proposes 1–3 short
  candidate memories in the conversation and saves only what the user
  approves (approved inferences are saved with `source: "inference"`,
  the §3.5 convention). The guidance is text, not mechanism — the same
  rubric written into the bundled skill, the AGENTS.md memory-hygiene
  footer, the MCP handshake instructions, the `memory_add` tool
  description, and a one-line summary in the injected context block —
  with throttling rules (task end / decision / gotcha moments only, no
  mid-task interruptions, never re-propose a declined candidate). The
  auto-draft posture (write first, surface later in bulk) is deferred
  until memory visibility ships: without an inventory the user can
  read, silent drafting reads as surveillance, so D61 deliberately
  does not build it.
  (2) **Rubric.** One memorability standard, shared by this live
  capture path and the future retrospective-distillation group:
  worth saving — decisions and their reasons, preferences,
  conventions, gotchas, approaches tried and abandoned, and
  `reference` memories pointing at authoritative docs; not worth
  saving — one-off task details and anything re-derivable from the
  code. Retrieval robustness layer 2 (agent-side query expansion:
  decompose into concepts, 2–3 phrasings each, cross-language, check
  the other scope) ships as guidance in the same texts, on top of the
  D56 server-side layer 1.
  (3) **Capture-time aliases (layer 3).** When a memory is saved, the
  agent attaches up to 4 aliases — alternate phrasings, synonyms,
  equivalents in the user's other language — stored in a new optional
  frontmatter field `aliases` (additive; files without it parse
  unchanged, `schema_version` stays 2) and indexed in their own FTS
  column (index schema 6→7, rebuilt from markdown automatically).
  Gated by a new `captureAliases` config flag (init asks once, default
  on, `config set captureAliases off` opts out): when off, aliases
  passed by agents are dropped and the alias guidance disappears from
  the MCP handshake. Turning it off never rewrites existing memory
  files — aliases already stored stay stored and searchable, and
  supersede keeps carrying them forward; the flag gates new captures
  only (no silent data destruction). Aliases pass through the same
  secret redaction as memory content before they are stored, and a
  malformed alias list (blanks, more than 4) is normalized silently —
  never a tool-call error.
  Keyword capture (no agent in the loop) leaves
  aliases empty rather than inventing them; `supersede` carries
  aliases forward unless the caller replaces them. Aliases are
  normalized (trim, case-insensitive dedupe, cap 4) and bad ones cost
  nothing — they rank as bm25 noise, never an error. Retrospective
  distillation over host transcripts stays its own group; it will
  reuse this rubric.
  *Status (2026-11-02): 已实现 — CHANGELOG 0.7.0（2026-10-04）"Proactive capture: checkpoint proposals and aliases".*

- **D62 — environment variable names grow current-name aliases.** The
  data-root and config-path overrides predate the rename and kept the
  old package's name (`MY_O_MEMORY_HOME`, `MY_O_MEMORY_CONFIG`) — a
  stale-looking name is a trap for users and agents scripting against
  the current one. `OPEN_MEMEX_HOME` / `OPEN_MEMEX_CONFIG` are now the
  preferred names; the legacy names still work as fallbacks (new name
  wins when both are set), so existing setups and scripts never break.
  The data root itself does not move — only the variable names change.
  `doctor`'s storage check notes when the root arrived via the legacy
  variable, and its pre-rename-dir leftovers check reads whichever
  variable is in effect.
  *Status (2026-11-02): 已实现 — CHANGELOG 0.7.0 "Environment variable names (D62)".*

- **D63 — correctness fixes from a whole-project external review.** Six
  verified silent-wrong-answer bugs, fixed as one batch: (1) VS init
  dropped the parsed `.mcp.json` instead of merging it, wiping other
  servers; (2) forget reported success when unlink failed — only ENOENT
  is success now, both in the tool op and the CLI; (3) the config
  loader's regex comment-stripper was not string-aware and corrupted
  redact patterns (`src/**/secrets` → `srcsecrets`) — replaced with a
  string-aware scanner now shared with doctor (one parser, not two);
  (4) `loadConfig` enforces the `memoryDir` no-escape invariant on
  hand-edited files, falling back to the default with a warning;
  (5) `migrate` rewrites `scope`/`visibility` with the key, and
  conflict resolution compares parsed timestamps (lexicographic
  RFC-3339 order breaks at fractional seconds); (6) bundle import
  enforces staging-dir containment (resolve + realpath), rejecting
  `../` and symlink escapes. Rule going forward: any behavior that can
  fail must fail loudly in its return value; "already gone" is the only
  swallowed delete error.
  *Status (2026-11-02): 已实现 — CHANGELOG 0.7.0 "Correctness fixes from the whole-project review (D63)"，六项逐条列出并注明各有回归测试.*

- **D64 — second batch from the same review: stale answers, stranded
  files, and holes between surfaces.** (1) The opencode plugin hosts
  synced the index only at bootstrap, so memories written by the CLI or
  another client stayed invisible all session (and exact duplicates
  accumulated); plugin tool calls now reconcile from disk first,
  mirroring the MCP server's per-call sync. (2) Superseding a published
  memory reset `review_state` to `draft` in the repo, where submit
  could not reach it and promote refuses drafts — the replacement now
  re-enters at `proposed` whenever the old memory had entered review.
  (3) Every memory-file rewrite now goes through the atomic
  tmp+rename helper (D57 covered creates only); a torn read mid-rewrite
  previously parsed as a deletion. (4) `setStatus` refuses
  `retracted → active`: retraction is one-way through this path, or
  withdrawn content silently returns to recall. (5) Propose copies get
  `visibility: internal` instead of inheriting `private`, which export
  excludes by default — the team copy no longer vanishes from bundles.
  (6) `opencodeGlobalConfigPath` resolves whichever of `.json`/`.jsonc`
  actually exists, as init's writer does; uninstall no longer reports
  "nothing to remove" while leaving the plugin entry behind.
  (7) `doctor` now checks all eleven MCP tool names (it checked the
  plugin's five) and flags v1 memories stranded under `memories/user/`,
  which v2 read paths cannot see. (8) `memory_status` output is capped
  per section with an "… and N more" line; `memory_list` accepts
  `scope: both`; `forget` says when the deleted file lived in the repo
  (commit the deletion); the Copilot instructions and the MCP handshake
  now tell the agent the same thing about when to call
  `memory_status`; the AGENTS.md distillation footer teaches
  `source: "inference"` like every other surface; `where` prints the
  config path it always promised. Standing rule reinforced: any surface
  that answers a question must be reading current truth, and every
  workflow state must have a next step.
  *Status (2026-11-02): 已实现 — CHANGELOG 0.7.0 "P1 fixes: stale answers and stranded files (D64)"，八项逐条列出.*

- **D65 — keyword capture: natural phrasings fell through.** Default-pattern
  fixes found while verifying a review claim: (1) `帮我记住…` — arguably the
  most natural Chinese phrasing — matched no pattern at all; it now captures
  to personal, following the established 我-rule (same as 替我记）, while
  `帮我们记住…` still routes project. (2) A leading `请` defeated every
  记住-led pattern (`请记住我…`, `请记住：…`, `请记住（个人）…`); the
  `(?:请)?` prefix the 记一下 patterns already had is now uniform.
  (3) English `remember to …` left a stray leading "to" in the captured
  body; the pattern consumes it (with backtracking verified so
  "remember Toronto…" is not mangled). Patterns are code defaults, so
  upgrades pick these up automatically unless the user customized the
  pattern lists. Deliberately NOT changed: multi-line paste triggering
  and the secret-masking windows stay as they are — narrowing them is a
  capture-recall tradeoff that needs an explicit decision, not a drive-by.
  *Status (2026-11-02): 已实现 — CHANGELOG 0.7.0 "Keyword capture gaps (D65)".*

- **D66 — follow-up review of the D63–D65 stack.** (1) The 帮/替
  keyword family is rebuilt around full verb phrases: an optional `请`,
  `记` + optional `住|录` + optional `一下`, then a separator boundary —
  `请帮我记住：…` captures (D65's new pattern lacked its own `请`),
  `帮我记录一下：…` saves `周五不发布` instead of the mid-word garbage
  `录一下：…`, and `帮我记得…` does not fire. `help me remember: …`
  joins the personal patterns. Still deliberately unchanged: shortening
  the ≥3-char content floor (it eats `记一下这个`-type captures, but
  lowering it invites junk) and adding narrative triggers like `记得…` /
  `remind me to…` (imperative-vs-narration ambiguity) — both need an
  explicit decision. (2) `sync-status` CLI shows the full list; the
  20-line cap binds only agent renders, whose "… and N more" line names
  the CLI. `list --scope both` reaches CLI parity with the tool, and
  `status --help` documents the retracted one-way door. (3) The test
  suite is Windows-safe (probe imports are `file://` URLs, the uninstall
  test sets `USERPROFILE` since `os.homedir()` ignores `HOME` there)
  and refuses to run against a stale `dist/`. (4) Sync-error posture is
  now a stated asymmetry: the MCP adapter lets pre-call sync errors
  propagate as tool errors; the plugin adapter logs them at debug and
  answers from a possibly-stale index rather than taking the tools
  down. (5) §19's legacy-paths text now names the shipped locations;
  historical decision entries keep their as-decided wording.
  *Status (2026-11-02): 已实现 — CHANGELOG 0.7.0 "Review follow-ups (D66)".*

- **D67 — keyword capture: a trigger must be a statement to the store.**
  Three rulings, all from the D66 review's open items plus one bug D66
  introduced. (1) **The boundary guard guards the bare verb only.** D66 put
  a separator requirement *after* the whole verb phrase, which killed the
  commonest Chinese form — `帮我记一下这个配置`, `帮我记住这个配置`,
  `替我记一下我住在杭州`, `帮我们记一下这个约定` all stopped matching, because
  the noun follows 记一下/记住 directly. The guard now applies only to a
  bare 记: `记` + (`住`|`录`, never followed by a verb continuation like
  得/着) + optional `一下`, or a separator. So mid-word garbage (`帮我记得带伞`
  → `带伞`) is still impossible while the natural form captures. (2) **The
  ≥3-char body floor stays, but stops being silent.** A trigger that yields
  `这个` or `OK` is a match on the trigger, not a memory, and a 2-char memory
  is noise in every later injection — so the floor is deliberately *not*
  lowered (a script-aware floor is the escape hatch if short Latin bodies
  ever matter). What changed is honesty: `capture --dry-run` prints the
  rejection with the reason, and `logLevel: debug` logs it, so "nothing
  happened" is never a mystery. A rejected **personal** match also keeps
  its line claimed — otherwise `记住我：OK` fell through to the generic
  记住 and was saved as the nonsense project memory `我：OK`. (3) **Narrative
  forms are not triggers.** `记得…`, `remind me to…`, `I always forget to…`
  stay out: they are imperatives aimed at the agent, they are the most
  frequent sentences in any conversation that mentions memory, and a false
  trigger writes permanent state nobody reviewed — while a missed trigger
  costs one sentence. The asymmetry is deliberate: precision over recall.
  For the two ambiguous forms already in the list, an explicit marker now
  separates narration from instruction: `别忘了：…` / `don't forget: …` /
  `don't forget that …` capture; bare `别忘了带伞` / `don't forget the wifi
  password` do not. The `note` family is untouched — `note the API is v2`
  was never ambiguous. (4) Test/tooling honesty: `test-full.ts` guards the
  built `dist/` with a content fingerprint (`scripts/build-stamp.mjs`)
  rather than mtimes — `git checkout` rewrites mtimes, so a branch switch
  could leave an older-branch dist looking fresh — and the agent-facing
  `memory_status` cap is pinned again (20 entries per section plus a
  "full list: open-memex sync-status" pointer) after D66's CLI-parity test
  had dropped that coverage.
  *Status (2026-11-02): 已实现 — CHANGELOG 0.7.0 "Keyword capture: what counts as a trigger (D67)".*

- **D68 — memory visibility: the inventory is a protocol surface.** Group 3-C
  (design: `docs/memory-visibility-design.md` v2). `memory_list` output
  becomes a numbered, structured inventory (`[type] id=… created=…
  source=…`, state tags for project scopes; `created=` is when the fact
  was learned, `updated=` shown only when it moved materially later). The
  raw enums stay in the data; plain-language renderings live in the
  guidance surfaces (tool descriptions, MCP handshake, SKILL.md,
  distill-agents footer) so agents rephrase in the conversation's
  language. New input `include: "active" | "all"` (default `active`) —
  a deliberate behavior change: superseded versions and retracted /
  archived memories leave the default listing (audit view via `all`).
  Every listing states its true total; truncation is disclosed, never
  silent (the D66 lesson applied to this surface). `open-memex
  inventory` renders the same data layer as text (default) or JSON
  (`open-memex-inventory/1`); a report containing personal memories
  refuses to be written inside a git working tree without
  `--allow-personal`. `memory_forget` gains `soft` (CLI `forget
  --soft`): retraction as a first-class tool action — hidden from lists
  and search, file kept, still one-way per D64 (restoring the fact means
  saving it again; no un-hide, no undo, no recycle bin). Deletion stays
  a confirmed conversation: agents re-list before acting on a number
  (numbers are only valid for the listing just produced) and read the
  entry back before deleting. The HTML rendering of the same data layer
  follows as a separate change; auto-draft stays gated on the unlock
  conditions in the design doc.
  *Status (2026-11-02): 已实现 — CHANGELOG 0.7.0 "Memory visibility: see it, hide it, delete it (D68)" 及同版 "Inventory HTML report (D68 follow-up)".*
- **D69 — inventory HTML rendering lands (3-C complete on the visibility side).**
  `open-memex inventory --format html` renders the D68 data layer into a
  single local page: scopes grouped, outbox drafts in their own section,
  replaced/hidden history folded with supersede-chain pointers, all
  content escaped, filter box is local show/hide (no innerHTML, no
  network). Default output is the data dir's `inventory.html`; the D68
  worktree refusal applies unchanged. Sections fold above 50 current
  entries. With this, the 3-C visibility surfaces are complete (agent
  inventory in chat, text/JSON reports, HTML page; hide + confirmed
  delete as the correction actions). Auto-draft remains gated on the
  unlock conditions in `docs/memory-visibility-design.md`.
  *Note (2026-11-02): entry restored verbatim from commit 8b11aed (2026-10-03) — it was dropped from the log during a later rebase/merge.*
  *Status (2026-11-02): 已实现 — 0.7.0-alpha.10 (commit 8b11aed); src/inventory-html.ts.*

- **D74 — the Node floor is 22.14, because the driver sets it, not us.** D72
  moved the Node driver to `better-sqlite3` 13 (the N-API rewrite) to stop the
  Node 24.19+ exit-path abort. That upgrade carried an unstated requirement:
  v13 is compiled against **Node-API 10**, and Node only gained Node-API 10 in
  **22.14.0**. Below that floor `require("better-sqlite3")` succeeds and then
  `new Database()` segfaults the process — no message, no stack, exit 139 on
  macOS/Linux, `0xC0000005` on Windows. Measured on win32-x64: Node 22.12.0
  dies on the first open, Node 22.23.3 and 24.20.0 work; Node 20 can never work
  with v13, since Node-API 10 never landed on that line (EoL regardless). This
  is upstream and still open — WiseLibs/better-sqlite3#1514, plus #1516 for the
  separate `npm ci` gyp problem on Windows, where `gypfile: false` does not stop
  npm from shelling out to node-gyp. `engines.node` had been `>=22.6`, which was
  the `--experimental-strip-types` floor — a real but *different* constraint
  that predated the driver bump; leaving it would have shipped a package whose
  declared support window crashes on its own dependency. Three changes:
  (1) `engines.node` is `>=22.14.0`, and the two floors are documented as two
  floors rather than merged into one number; (2) `loadDatabase` refuses below
  the new floor and throws the actionable message (upgrade Node, or pin
  `better-sqlite3@^12.11.1` — v12 is unaffected), because a crash no in-process
  `try`/`catch` can report is the worst possible failure mode for a CLI;
  (3) `doctor` reports the floor *and* probes the driver in a **child process**,
  since a segfault cannot be caught in-process — the probe resolves the driver
  from this package's own directory, because `doctor` routinely runs with cwd
  set to a user project where a bare `require` finds nothing. The version
  comparison lives in `src/runtime-floor.ts`, pure and unit-tested, because the
  boundary is a fact to be tested (22.13.9 below, 22.14.0 exactly at, 22.23.3
  and 24.20.0 above) rather than a constant to be trusted. Deliberately NOT
  done: pinning back to v12 (that re-opens D72's Node 24 abort), or attempting
  to fix either upstream bug here.
  *Status (2026-11-02): 已实现 — CHANGELOG 0.7.1（2026-10-04）"The Node floor is 22.14, because the driver says so (D74)".*

- **D73 — one user statement, one memory: the keyword hook hands off to the
  agent.** The keyword hook and the agent are two writers for one user turn,
  and only one of them knows the sentence is already stored. Observed
  2026-10-04: a single `remember this folder is for my spark tank ideas …
  shared memory across agents and employees` produced **three** memories — one
  `source: keyword` verbatim capture plus two `source: tool` paraphrases the
  agent wrote because it could see the chat transcript but not the store. The
  existing §3.4 guard could not catch it: token Jaccard scored those
  paraphrases 0.21–0.38 against the capture, below the 0.8 near-dup bar, and
  `open-memex audit` reported zero near-dup pairs, so the store looked healthy
  while holding three copies of one statement (retrieval then returns all
  three). Two mechanisms, deliberately layered:
  **(a) hand-off note** — `captureFromText` records each capture against the
  host session id (`chat.message` / v2 `prompt`, both of which carry one), and
  the system-context hook (`experimental.chat.system.transform` / v2
  `context`) pushes a short block naming what was already stored, delivered
  once per capture and pruned after the turn window. The agent can now avoid
  the duplicate write it had no way to see. In-memory only, like
  `injectedSessions`: never persisted, gone on restart.
  **(b) turn-echo guard** — `memory_add` additionally refuses a write that
  overlaps a `source: keyword`/`user` memory created in the same scope within
  the last 10 minutes, returning the stored id and pointing at
  `memory_supersede`. This is the deterministic backstop for the case where
  (a) is ignored. It is deliberately scoped and high-barred, because lexical
  overlap **cannot** separate an agent's gloss from a genuinely new fact: in
  the same measured set, the agent's gloss scored 0.211 and a distinct fact
  the same sentence happened to contain scored 0.214. So the bar sits at
  0.28 — wholesale re-saves of the captured sentence measure 0.29–0.36 and are
  refused; anything below is left to (a) and the agent's judgment, and a
  refusal always names the stored id so the caller can rephrase to the new
  part or supersede. Agent-authored `source: tool` saves keep the old 0.8
  near-dup *notice* and are never refused. The refused case is recoverable by
  construction (supersede, or a follow-up add carrying only the new
  information), and no D14-style masking, dedup, or lifecycle rule changes.
  What is deliberately NOT done: no fuzzy-matching upgrade (D73 measures why a
  better metric still cannot decide "new information"), no auto-merging of the
  agent's gloss into the capture, and no transcript store (the replay-distillation
  open question owns that).
  *Status (2026-11-02): 已实现 — CHANGELOG 0.7.0 "One thing you said is one memory (D73)".*

- **D72 — the Node SQLite driver moves to the N-API line.** The D70 suite was stable on Windows and failed in shifting clusters on Linux under Node 24.20: individual CLI processes intermittently died with `SIGABRT` in `Statement::~Statement()` (`RemoveEnvironmentCleanupHook ... Assertion failed: (env) != nullptr`) and lost their stdout, so unrelated supersede / submit / inventory checks failed depending on which process the GC reaped. The work itself had always landed; only the exit path was broken. Root cause is upstream: Node 24.19 changed `node::ObjectWrap` cleanup-hook registration, and `better-sqlite3` <13 (raw `node::ObjectWrap`) can finalize a prepared statement from a GC callback with no Environment entered. `better-sqlite3` 13 is the N-API rewrite and removes that path; it still supports Node ≥22, and every API this repo uses (`Database`, `prepare`, `exec`, `pragma`-style PRAGMAs, `close`) is unchanged. The suite's crash-retry shim stays as belt-and-braces for older installs, but the shipped driver no longer needs it on current Node. Verified: three consecutive Linux `test-full` runs at 114/114 plus a 40-command add/list/search loop with zero aborts (was ~50% per process).
  *Status (2026-11-02): 已实现 — CHANGELOG 0.7.0 "Node 24 CLI aborts: SQLite driver moves to the N-API line (D72)".*

- **D71 — the scope seed is the folder opened, never a filesystem root.**
  OpenCode v1 hands the plugin two roots: `worktree` (the repo root — but
  the filesystem root itself, `C:\` or `/`, when the opened folder is not a
  git repo) and `directory` (the folder actually opened). The v1 adapter
  preferred `worktree`, so every non-git folder on a drive seeded its scope
  on the drive root and collapsed into one shared
  `project__workspace__<hash of the root>` bucket — a `c:\temp` project
  landing in `project__workspace__3dc8472eaebe` (seed `c:\`) is what
  surfaced it. `pickScopeRoot` (src/scope.ts) now takes `worktree` only when
  it is a real directory below the filesystem root, else `directory`. The
  repo-root behavior is unchanged: a real worktree still wins, so opening a
  repo subfolder keeps the repo's scope. Memories already written under a
  root-seeded key stay where they are (no auto-migration, per the existing
  rule); `open-memex scopes` shows the stray bucket and
  `open-memex migrate --from <old-key>` moves them. The v2 adapter already
  seeded on the opened directory and is unaffected.
  *Status (2026-11-02): 已实现 — CHANGELOG 0.7.0 "Non-git folders shared one scope bucket (D71)".*

- **D70 — visibility follow-ups: one number, one guard, one truth.** The
  3-C review of D68/D69 found the surfaces honest individually and
  inconsistent with each other. (1) **Every visibility surface discloses
  truncation.** `memory_list` did; `open-memex list` — the command a
  sceptical user runs first — silently showed 20 of 25. It now renders
  the same structured line as the tool and states how many entries it
  dropped, naming the command that shows everything. (2) **Numbers are
  unique within a listing.** Ordinals ran per scope, so a single
  `scope: both` output contained two `#1`s and "delete #3" was a guess;
  the counter now runs across every section of one listing (tool, CLI and
  the text report). (3) **A correction that touches the repo says so.**
  The hard delete already did (D64); the soft hide did not, so a
  retraction of an in-repo memory read as "hidden" while it was only a
  local working-tree edit — the team still had the memory. Both surfaces
  now name the commit and push. (4) **The report guard fails closed and
  exists once.** `isInsideWorkTree` ran `git -C` on the output's parent
  directory, so a not-yet-created directory made the check throw and
  report "not in a worktree" — a fail-open on the one path where personal
  memories would ride a commit; it now resolves the nearest existing
  ancestor, reports a missing directory as itself, and both formats share
  a single refusal helper instead of two copies. (5) **`open-memex-inventory/2`**
  drops the absolute `file` path: the JSON renderer exists to be handed to
  an agent, i.e. pasted into a cloud conversation, and it carried the
  user's home directory. (6) Smaller honesty fixes: an empty scope is
  reported as `(0)` instead of vanishing; only the HTML audit view loads
  the hidden rows themselves (text/json pay for counts); the page's
  "no network requests" claim is now enforced by a `default-src 'none'`
  CSP rather than asserted; and `countList`'s comment states its one known
  divergence (a self-healed dangling chain pointer) instead of claiming
  equivalence. Deliberately NOT done, pending a decision: HTML i18n and a
  size cap for very large stores.
  *Status (2026-11-02): 已实现 — CHANGELOG 0.7.0 "Visibility follow-ups: one number, one guard, one truth (D70)".*

- **D75 — closed questions leave the list; competitor-inspired directions enter it (2026-10-04).** The Open Questions section is a working list, not an archive: the entries decided in D56 (host parity), D57 (retrieval explainability / memory health), D61 (checkpoint proactivity, capture criteria, retrieval layers 2–3), and D68 (memory visibility), plus the retrieval-robustness entry whose three cheap layers all shipped, are removed; the decisions remain the record. A same-day scan of five Glama-listed memory servers (auxly-memory-cli, agent-memory, remnic, Agent-Memory-Bridge, memtomem, memryzed) confirmed the current wedge — proactive in-session capture + one memory shared across editors + PR-based team sharing — appears in none of them whole. Borrowable directions are recorded instead: four new open questions (retrieval evaluation gate, per-client trust levels, cold-start import, session working state) and one roadmap candidate (`doctor` mis-registration check). Nothing here commits implementation; each direction needs its own design pass.
  *Status (2026-11-02): 已实现 — CHANGELOG 0.7.3 "Design doc maintenance (D75)".*

- **D76 — tool annotations must tell the truth (2026-10-05).** `memory_pr_status` declared `readOnlyHint: true` while `apply=true` writes local review states (caught by Glama's TDQS evaluation of v0.7.2, 4.0/5). Structured hints are part of the protocol surface: all 11 tools now declare read-only / destructive / open-world hints that match their behavior, descriptions route between sibling tools instead of leaving agents to guess, and `scripts/smoke-mcp.ts` guards the pr_status combination. Description honesty is held to the same standard as behavior: ranking claims, defaults, and error semantics in tool text must match the code.
  *Status (2026-11-02): 已实现 — CHANGELOG 0.7.3 "Tool-definition quality pass (Glama TDQS 4.0/5 on v0.7.2): D76".*

- **D77 — measure usefulness by reuse, not storage (2026-10-07).** The Spark Tank submission commits the metric: "measured by reuse — fewer repeated questions, less context-prep time, approved memories reused by non-authors — not by memory count." Three layers, in build order: (1) **Offline retrieval eval.** A synthetic fixture (memories + queries with gold ids) run against the FTS5 baseline; publish recall@k/MRR in the README. This also answers the D75 "retrieval evaluation gate" open question — the number gates any future semantic-layer decision (reference points: agentmemory's published LongMemEval-S R@5 95.2%; lotargo/memory_plugin's BM25-only vs hybrid table). Later, run the MemoryAgentBench harness for directly comparable numbers (Knowl 90 / Mem0 18 / MIRIX 14 / Zep 7). (2) **Online reuse counters.** Per memory: `retrieved_count` (returned by search/list/first-turn injection) and `useful_count`, split into `useful_self` (author's own reuse — the personal-utility story) and `useful_team` (reuse of published project memories across sessions — the Spark Tank "reused by non-authors" story; no identity system needed: published state plus session diversity is the proxy). Both count as useful; reporting them separately keeps the team-knowledge claim honest. Explicit confirmation: a `memory_useful` tool call, human approve at review; behavioral: supersede/promote referencing it. Passive surfacing must never refresh usefulness — the opencode-memory lesson: unguarded exposure creates a self-reinforcing retrieval loop. Derived: `reuse_rate = useful / retrieved`; "zombie memories" (retrieved but never confirmed useful) surface in `memory_status` as decay/prune candidates. Counters live in SQLite, not frontmatter; local-only. (3) **Status surfaces.** `memory_status` gains a reuse report: top reused, zero-reuse list, per-scope reuse rate — feeding the Spark Tank pilot metrics. Moat note: competitors' "useful" is agent self-reported; our review ladder gives a human-grounded signal — approved/published means a human already said it is worth sharing. **Priority: this is the next build after 0.7.3** — fixture eval first (1–2 days, publishable number), then counters + `memory_useful`, then the status report, then the external bench.
  *Status (2026-11-04): 已实现 — 三层全建。第 1 层 eval 已发；第 2 层（0.9.0-alpha.2）：`memory_usage` 表（独立于可重建索引，跨 rebuild 存活）+ `retrieved_count`/`useful_self`/`useful_team` + `memory_useful` 工具与 `open-memex useful` CLI，分类代理：personal 或未评审项目草稿→self，approved/published 项目记忆→team，supersede 与评审 approve（含 `--local-approve`）各自动计一次 useful，曝光只走 search/list/injection 的显式 `record` 开关；第 3 层（0.9.0-alpha.3）：`memory_status` / `sync-status` 复用报告（各作用域 retrieved/useful 比率且 self/team 分开显示、top reused、zombie=被检索却从未确认有用；superseded/deprecated 带生命周期标记，避免历史复用被读成当前指引；retracted/archived 不计入两列表，总数仍计）。仍未跑：MemoryAgentBench 第二个外部数据点（属第 1 层延伸，不在三层机制内）。*

- **D78 — pre-submit curation: human-on-the-loop, not in-the-loop (2026-10-07).** Fragmented captures must be organized before submit, but the submitter's patience is the scarce resource — every manual gate lowers the submit rate, so curation defaults to automatic and the human handles exceptions. Confidence tiers: **auto-apply** (exact duplicates, trivial fragments, inferred type/tags, title normalization); **batch-confirm** (semantic merges, splits — one summary screen, one tap to accept or undo, never per-item approval); **explicit human decision** (dropping substantive content, and submit itself — the D-hard boundary "project scope never auto-submits" stands: automation covers organizing, sharing stays human). The safety net is the supersede chain: every auto-merge preserves provenance and is undoable, so pre-approval is replaced by reversibility (undo-send, not confirm-dialog). Trigger: no new step to remember — `submit` becomes curate+submit in one command, with the curation summary attached to the PR description; session wrap-up is the alternative hook (batch-silent, per the D61 checkpoint posture). Closed loop: human undos feed back into confidence thresholds, consuming the D77 `useful_count` signals. This revises the earlier review-ladder instinct of per-item approval: the human moves from in-the-loop to on-the-loop.
  *Status (2026-11-13): 部分实现 — D93 第一刀已落地 auto-apply 确定性层（精确重复合并 / 空正文归档 / 首行标题规范化）+ 预提交 lint 报告 + `curate undo`；semantic merge/split、type/tag 推断、batch-confirm 仍开放，submit 本身仍由人触发.*

- **D79 — query-time synonym expansion with a second-chance round (2026-10-07).** Fourth retrieval layer after D56 (query construction) and D61 (agent-side expansion guidance, capture-time aliases): a curated, checked-in synonym map (`src/retrieve/synonyms.ts` — EN dev-domain groups plus ZH groups, bidirectional) applied at query time. `search()` runs round one unchanged; when it returns fewer candidates than requested, round two re-runs with synonym variants OR-ed in and fills only the gaps — round-one ids and scores are never diluted by the expansion. Deliberately not embeddings and not an LLM call: deterministic, auditable, zero dependencies; a bad synonym is a visible line in the file, not a silent vector. `SearchStats.secondRound` records whether the round ran (surfaced in `search --explain`). Eval proof: 3 synonym-only fixture queries are unanswerable in round one by construction (their words appear in no memory); round two answers 2 of 3 at rank –2. Baseline with the round: recall@1 0.81, recall@5 0.95, MRR 0.87 over 37 queries. Follow-ups, not in this change: feedback-weighted ranking once D77 counters land; the embeddings gate decision against these numbers; reranker evaluation. **Update (2026-10-07, LongMemEval-S):** measured on 470 questions (recall_any@k protocol, per-question isolated corpora): R@1 86.0% / R@5 97.0% / R@10 98.3% / MRR 0.909 — ahead of agentmemory’s published BM25-only (86.2% / 94.6% / 0.715) and level with their BM25+vector (95.2% / 98.6% / 0.882). But the second round fired on **0 of 470** queries: the `raw.length < limit` trigger never trips once the corpus fills the page — the round as designed is a thin-corpus fallback, not a scale answer. A pooled 22k-memory stress run drops R@5 to 40.6% (the lexical ceiling, now measured instead of asserted). Consequence: the trigger needs a redesign (score/coverage-based, or always-expand-with-fusion) before the round can claim the scale story; the pooled number is the baseline an embedding layer must beat. **Ablation (2026-10-07, same bench):** OFAT over the lexical factors, limit=10, effect on MRR: OR semantics **+0.652** (AND collapses to 0.257 — the load-bearing wall); prefix matching **-0.010** (disabling it lifts R@1 86.0%→87.9% — mildly harmful, needs a second dataset before acting); stopword filtering **+0.005** (keep: cheap, principled); synonym round **0.000** at every limit and scale tested. Limit sweep: R@1 is invariant to limit (86.0% at 1–50); returns flatten at limit 5 (R@5 97.0%, +1.3pp to go to 50); round-2 fired 10/470 at limit=50 and rescued nothing (identical to no-synonyms). Pooled 22k at limit=50: R@5 still 40.6%, round-2 fired 0. Reading: the lexical lemon is squeezed — OR does the work, the rest is ±0.01. The next gains must come from ranking under distractors (embedding/reranker layer), not more lexical tweaks. Rescue experiment (same day): fallback-append vs always-expand+RRF-fusion, 470q, stratified by query–gold overlap — **zero rescues** under either design, at either scale; not one question changes outcome. The 8 residual misses are reasoning problems (preference/multi-hop/temporal), not vocabulary gaps. The round’s value lives in a mismatch slice the public data barely contains (proven on constructed queries: 2 of 3 rescued). Keep the curated map; stop spending design budget on the trigger. (Superseded same day: index-time expansion, see backlog.)
  *Status (2026-11-02): 已废弃 — 按子句状态：query-time 第二轮机制**已废弃**（D80 的 index-time expansion 取代）.*
- **D80 — index-time synonym/translation expansion (2026-10-07).** Supersedes D79's query-time second round (removed from `search()`; `SearchStats.secondRound` gone): the curated map (`src/retrieve/synonyms.ts` — EN dev-domain groups, ZH groups and EN↔ZH translation pairs merged into one bidirectional group list) is applied at sync/index time. `writeRow` expands each memory's keywords via `expansionVariantsForDoc()` and appends the variants to the indexed `aliases` column (FTS and CJK-bigram columns both pick them up), so any related word matches in a plain round-1 query. Query side: single FTS round, no trigger, no second chance. Keyword-centric per Stone ("重要的是关键词"): Latin content terms (same stopword filter as the query builder, so both sides agree on what a keyword is) + CJK substring matching + multi-word Latin phrases (`regression test`); variants already present in the text are skipped; capped at 32 per memory to bound index growth. Derived at sync time — the Markdown file stays the source of truth; a map update needs a reindex to backfill. *Rationale: the precise slice (exact EN↔ZH pairs like 单点登录/SSO) must never be missed, and embeddings are fuzzy where the map is exact; paying the cost once at write time keeps every query simple and trigger-free.* Eval on the 41-query cross-lingual fixture: recall@1 0.732 → 0.756, recall@5 0.854 → **0.976**, MRR 0.791 → **0.859** — all 5 EN↔ZH vocabulary misses rescued at rank 1–3. Known trade-off: a single-keyword query can rank an aliases-only hit below shorter docs sharing the variant (`how do we ship`: rank 2 → 8 — its hit is 1 of 15 variants on a long aliases field); accepted, the old rank depended on the fragile thin-corpus trigger. `expandQueryWithSynonyms` kept as a bench-only export.
  *Status (2026-11-02): 已实现 — CHANGELOG 0.8.0 "Index-time synonym/translation expansion (D80, supersedes D79)".*
- **D81 — user-defined alias vocabulary as query-time expansion (2026-10-07).** Stone: an alias should be a *kind of memory* — defined once, remembered forever. Any memory type may carry `alias:` (the nickname, e.g. 香蕉计划) and `target:` (what it refers to, e.g. 支付系统重构项目) frontmatter; the alias memory defines vocabulary once per scope. At query time (`src/retrieve/alias-memory.ts`), query terms are looked up against the alias registry — one cheap `SELECT` per `search()` call over rows with non-empty alias+target (trigger A: exact registry hit, never a count heuristic; the D79 0/470 trigger is not repeated). On a hit the query is rewritten with the other side of the relation — bidirectional (alias→target and target→alias), depth < 3, cycle-safe — and re-run as round 2 (round 3 for chains). Rounds merge by normalized-max (`mergeRounds`): each round's BM25 scores are divided by that round's best (raw cross-round scores are incomparable — °C vs °F), then final = max, so an alias-side champion competes evenly with a literal-side champion — alias hits are never down-weighted for coming from a later round. Merged pool is re-ranked then cut to [1.5K, 2K] (Stone) — never back to K, or round-2 hits would be starved the way D79's slice-to-K starved them. No reindex when an alias changes (query-time). Scope-aware: a project codename stays in its project. *Rationale: D80's curated map is static and shared — personal vocabulary (小宝贝, 香蕉计划) doesn't belong in it; per-memory D61 aliases don't propagate to new memories. Alias memories close the gap: user-defined, scope-aware, effective immediately.* v1: user-explicit creation only (`memory_add` alias/target params, CLI `--alias`/`--target`, frontmatter edit); agent-proposed aliases deferred. D81 also rewords the init `captureAliases` prompt (it is not the synonym switch — D80's expansion always applies). Eval: 3 new fixture queries (香蕉计划↔支付系统重构项目 both directions + the alias memory itself), 44 queries total: recall@1 0.750, recall@5 **0.977** (43/44), MRR 0.857 — the single miss remains `how do we ship` (known D80 trade-off).
  *Status (2026-11-02): 已实现 — CHANGELOG 0.8.0 "User-defined alias vocabulary as query-time expansion (D81)".*


- **D82 — closed `type` taxonomy on search/list (2026-10-07).** Follow-up deferred from the TDQS pass (#50), closes issue #51: `memory_search` / `memory_list` `type` is now `z.enum(MEMORY_TYPE_TAXONOMY)` instead of `z.string()` — a misspelled type (`"decisions"`) is rejected at the schema (MCP -32602) instead of returning zero results the agent can't distinguish from "no memories of that type". Hard rejection, not a soft "no matches" message: closed taxonomy + fail-fast. Existing rows with non-taxonomy types are possible (the frontmatter parser only coerces the v1 `instruction` → `knowledge` case) and are unaffected — they still surface in unfiltered search/list, they just can't be addressed by a type filter. The opencode plugin shares the same args objects, so both surfaces tighten together; `scripts/smoke-mcp.ts` guards the rejection. `memory_submit` keeps `destructiveHint: false` — settled in the #50 review (the outbox unlink happens after the repo copy is committed and hash-verified, so it's recoverable from git); recorded here so it isn't re-litigated.
  *Status (2026-11-02): 已实现 — CHANGELOG 0.8.1 "memory_search / memory_list type is now a closed enum (D82, closes #51)".*

- **D83 — D80 expansions get their own index column (2026-10-07).** Design follow-up to issue #56 (deferred from the D80 review): the curated index-time variants (`expansionVariantsForDoc`) move out of the `aliases` column into a dedicated `expansions` column — on `memories`, on `memories_fts`, and in the ai/ad/au triggers. `writeRow` stores user/authored aliases in `aliases` and derived variants in `expansions` (still filtered against the supplied set, still never written to Markdown); the `cjk` bigram column keeps covering body + tags + aliases + expansions so CJK variants stay substring-searchable. Retrieval: the FTS MATCH set gains the column with its own bm25 weight (at or below `aliases` — the fixture is the gate, tune don't guess); `SearchHit.aliases` and the `(aka: …)` attribution surface only user-authored aliases; `search --explain` reports which column matched (alias vs expansion). Migration: `SCHEMA_VERSION` 8 → 9; the bump triggers `rebuildIndexSchema`, which repopulates from Markdown — safe because expansions are derived and Markdown is untouched.
*Update (2026-10-07, implemented and measured):* the `how do we ship` rank did **not** improve (still 8) — the dilution for expansion-column matches is inherent to per-column BM25 length norm (32 variants in their own column dilute about as much as 36 did in the shared one), not to the mixing. What the split fixed is provenance (`(aka:)` / `SearchHit.aliases` are user-authored again) and the dilution of deliberate user aliases (a ≤4-term column now scores cleanly). Regression gate passed: `retrieval-eval` R@1 0.750 / R@5 0.977 / MRR 0.857, identical to pre-split; v8→v9 migration verified on a scratch DB (merged aliases re-split correctly, `user_version` 9). *Rationale: an agent reading `(aka: …)` must be able to trust it means "alternate phrasings someone attached to this memory", and a 32-variant derived list must not dilute the weight of 4 deliberate ones.*
  *Status (2026-11-02): 已实现 — CHANGELOG 0.8.1 "D83 (implemented, for #56)".*
- **D84 — `limit` is a cap on the return, never a hint (2026-10-07).** Correction to D81's cut rule, raised by the review of #52. D81 widened the merged alias pool to `[1.5K, 2K]` and passed that widened value to `resolveVisible` as the slice — so when an alias round fired, `search()` returned up to **2× `limit`** rows to every caller (`memory_search`, the MCP tool, `cli search`), with nothing in `--explain` saying so. The pool stays wider than `limit` — each round already over-fetches by `fetchLimit`, and the starvation D79's slice-to-K caused is real and still prevented — but the *return* is cut to `limit`. (D81's `1.5K` line was also dead: `max(min(pool,2K), min(pool,1.5K))` is always `min(pool,2K)`, so the documented band never existed; it is gone.) No ranking change — the merge sorts before any cut, so top-k is byte-identical; `scripts/retrieval-eval.ts` unchanged at R@1 0.750 / R@5 0.977 / MRR 0.857. *Rationale: `limit` is a contract on what a caller receives. Headroom belongs inside the ranking, not in the result set — an agent paying 2× the tool-result tokens on alias-touching queries has no way to see that it happened.*
  *Status (2026-11-02): 已实现 — CHANGELOG 0.8.1 "fix: search() honours the caller's limit again (#53)".*
- **D86 — the `expansions` BM25 weight, set by the fixture (2026-10-07).** Closes the two D83 clauses that were written into the decision log but never landed in code (`00c4d2d` shipped `bm25(memories_fts)` with no weight vector, and left `--explain` reporting only `fts:` / `candidates:` / `alias rounds:`). (1) **Weight vector** — `bm25(memories_fts, …)` now takes an explicit `[content, tags, aliases, expansions, type, cjk]`, with `expansions` at **0.75** (`src/retrieve/weights.ts`, kept out of `search.ts` so `smoke-pure.ts` keeps its no-sqlite guarantee). The measurement that sets it: on equal-length docs at weight 1.0, a direct body match and an expansion-only match score **identically** (`-3.983` vs `-3.983`) — the preference was being decided by tiebreak, not by the ranking function. Any weight < 1.0 breaks that tie toward the body. `0.75` is the *highest* weight the checked-in fixture cannot distinguish from 1.0 (sweep: 1.0 / 0.9 / 0.75 all yield R@1 0.750 / R@5 0.977 / MRR 0.857; 0.5 already costs MRR; below 0.35 R@5 breaks), so the ordering guarantee is free and the fixture remains the gate — retune by re-running the sweep, never by intuition. `SearchHit.matchedVia` (`body` | `alias` | `expansion` | `other`) is computed from the same per-column highlights the attribution already used. (2) **`--explain` attribution** — prints `matched via: body=N alias=N expansion=N other=N` alongside the active weights, so a surprising rank is traceable to the column that caused it. *Rationale: D83 promised the split would make the two columns distinguishable; on equal-weight columns they were not distinguishable at all, so the split bought provenance without buying ranking. This is the missing half.* **Explicit non-goal:** this does *not* repair D80's `how do we ship` rank-8 case — that is per-column length norm (one variant among many in a long `expansions` field), not a weighting problem. Fixing that means narrowing *what* lands in the column, not re-weighting it. Fixture unchanged: R@1 0.750 / R@5 0.977 / MRR 0.857.
  *Status (2026-11-02): 已实现 — CHANGELOG 0.8.1 "D83 follow-up: the two D83 clauses that shipped as design but not as code".*
- **D85 — the alias registry is indexed, not cached (2026-10-07).** From the same review (#55). D81's `loadAliasEntries` runs on **every** `search()` call over `alias <> '' AND target <> ''` — a full table scan on a corpus that may be tens of thousands. Added `idx_memories_alias ON memories(scope_key) WHERE alias <> '' AND target <> ''` to `TABLE_SCHEMA`. Two deliberate choices: (1) **no `SCHEMA_VERSION` bump** — `TABLE_SCHEMA` executes on every db open, not only on rebuild, so `CREATE INDEX IF NOT EXISTS` is idempotent and existing installs pick it up on next open with no rebuild; this also keeps the bump free for D83's 8 → 9 schema change. (2) **No result cache** — the registry must be re-read per query so a newly saved alias memory applies on the very next query (D81's freshness property). An index accelerates the lookup without caching results; those two concerns are separable and this resolves only the first. Measured at 5k memories: 971ms → 39ms per 2000 scoped lookups (~25×), `EXPLAIN QUERY PLAN` confirms `SEARCH memories USING INDEX idx_memories_alias`. Note the *unscoped* variant of the query still prefers `idx_memories_status`; `search()` always passes `scopeKeys`, so the partial index is what ships. *Rationale: the alias table is tiny by construction — one row per defined nickname per scope — so its lookup cost must be proportional to aliases defined, not to store size.*
  *Status (2026-11-02): 已实现 — CHANGELOG 0.8.1 "perf: partial index on the alias registry (#55)".*
- **D87 — stale stores migrate before the schema is created (2026-10-28).** D85's "no `SCHEMA_VERSION` bump" reasoning was wrong for one population: stores created before D81 (`SCHEMA_VERSION` 7, ≤0.7.x) have no `alias`/`target` columns, and `CREATE TABLE IF NOT EXISTS` adds no columns to an existing table — so `CREATE INDEX IF NOT EXISTS idx_memories_alias ... WHERE alias <> ''` throws `no such column: alias` inside `db()` before the `userVersion < SCHEMA_VERSION` rebuild check ever runs, wedging every open (CLI, MCP, plugin) on that store. Reproduced with a faithful v7 fixture: current code throws exactly that error. Fix, ordering only: in `db()`, when the `memories` table exists but the version is old, `rebuildIndexSchema()` runs *before* `TABLE_SCHEMA`/`FTS_SCHEMA` are executed (the table exists, so rebuild's `DELETE` is valid); fresh stores still fall through to creation and the existing post-create version check is unchanged. No version bump — the guard is ordered before creation, so version 9 still covers the migration, and no new mechanism was needed. Regression test in `test-full.ts` §9 builds a v7 store and asserts the open succeeds, `user_version = 9`, and the three columns are present. The D85 comment in `db.ts` carries a correction note. *Rationale: the wipe-and-repopulate migration only works if it runs before the schema that assumes its result; the bug was ordering, not a missing mechanism.*
  *Status (2026-11-02): 已实现 — CHANGELOG 0.8.2（2026-10-28）"fix: a pre-D81 index store (SCHEMA_VERSION 7, ≤0.7.x) no longer wedges every open (D87)".*

- **D88 — knowledge graph & compiled wiki as a derived layer (2026-10-31).** A graph + LLM-maintained wiki (§20, v0.3 candidate) compiles knowledge from memories so it accumulates instead of being re-derived on every query. The graph/wiki is derived and rebuildable from raw memory files; it never touches the source of truth. Edges are typed (`relates-to` / `supports` / `contradicts` / `derived-from` / `supersedes`) with EXTRACTED/INFERRED provenance + confidence; inferred edges are always marked. Lint runs automatically before promotion and only reports (never auto-resolves). Semantic extraction of docs is confirmed at init (on/off); once on, the default backend is the API (most machines have no local model), local model via config. Compiled pages are Markdown files. *Rationale: RAG re-computes and never accumulates; a compiled graph/wiki makes knowledge compound, and the derived layer does not touch the source of truth (raw memory files), consistent with D1 and Principle 7. Graphify is the working implementation of this pattern on codebases (measured on muse-thinktank 2026-10-31: curated graph, 1029 nodes, edges tagged EXTRACTED/INFERRED with confidence); Karpathy's LLM Wiki is the original statement of the pattern (three layers / three operations).*
  *Status (2026-11-02): 未实现 — 纯设计条目（2026-10-31）：typed edges + EXTRACTED/INFERRED provenance、promotion 前 lint、init 时确认语义抽取开关、API 默认后端、编译产物为 Markdown.*

- **D89 — session working state note (2026-11-02).** Closes the "Session working state" open question (open since 2026-10-04, deferred "until there is signal that users lose work context, not just facts"). The signal is Stone's 2026-11-02 request, following the Muse working-state comparison: durable knowledge is not enough — an interrupted task needs its working state to resume. Design adopted (§3.6): one ephemeral per-project Markdown note, agent-written at wrap-up, surfaced at session start alongside injection, outside the review ladder, 7-day default TTL. Answers the open sub-questions: contents are task summary / open files / last commands / where the work stands / next step; the writer is the agent at Stop (explicit user command where no Stop hook exists); the overlap with retrospective distillation is resolved by routing through the D61 checkpoint-proposal flow (the note is raw material, the ladder is the gate). Doc-level decision only — no code in this change; implementation is deferred to the §18 near-term backlog.
  *Status (2026-11-03): 已实现（0.9.0-alpha.1）— §3.6 落地：`src/working-state.ts`（写入/读取/过期/浮现块，`atomicWriteTextSync`、`redact` 照用）、`memory_workingstate`（第 12 个工具，插件与 MCP 同批）、会话开始浮现 `surfaceWorkingStateOnce`（插件两代适配器）、`audit` 增加 `workingStateExpired`、`open-memex wstate`（--clear）、配置 `workingStateEnabled`/`workingStateTtlDays`。**对原文的一个条款级修正**：opencode 插件 API 没有宿主 Stop 钩子（按已装 @opencode-ai/plugin 类型实地核对，Hooks 无 stop；SDK 事件里的 `session.idle` 每轮都触发，无法区分会话结束，也不生成内容），所以 opencode 的写入路径按 D"otherwise on an explicit user command"分支落地为 **指令 + 工具**——浮现块/工具描述/MCP 握手一致教 agent 在用户收尾信号时刷新；Claude Code 的 Stop 钩子归 Phase 2C 原生插件。权宜取舍（可接受）：写笔记不过评审阶梯（从不入存储），`clear` 无墓碑直接删——§3.6 明说这是过期草稿。*
- **D90 — working-state note implementation & write-path correction (2026-11-03).** Supersedes D89's Stop-hook assumption where reality differs: the opencode plugin surface (checked `@opencode-ai/plugin` Hooks today) has no `stop` hook, and the SDK `session.idle` event fires after every turn with no content the plugin could write — so the write path on opencode is instruction + tool (session-start block and tool description teach the agent to refresh the note when the user signals wrap-up), exactly the "explicit user command" branch D89 already allowed. The full feature lands: `memory_workingstate` as the 12th tool on both hosts (ops.ts once), session-start surfacing `surfaceWorkingStateOnce` (once per session, same in-memory Set discipline as injection), `audit` gains `workingStateExpired` (reports only, never auto-deletes — D57 posture), CLI `wstate` / `wstate --clear`, config `workingStateEnabled` (default on) + `workingStateTtlDays` (default 7, flat keys — the `loadConfig` merge is shallow, so nested objects would drop fields). The note passes through `redact()` on write (agent-composed command recall can quote credentials) and uses `atomicWriteTextSync` like every write path. A per-note `ttl_days` frontmatter frees the human edit from later config changes. `clear` has no tombstone — acceptable, per §3.6 the note is expired scratch. Claude Code's Stop hook arrives with the Phase 2C native plugin.

- **D91 — the knowledge graph, deterministic half (§20, 2026-11-06).** Implements the graph layer D88 designed, split at the derivation boundary: this change ships only edges the code can *prove* or derive from structure, with no LLM call anywhere. Edge extraction (`src/graph/extract.ts`, pure): (1) **supersedes** edges from the index chain (`superseded_by`, plus the reverse derived from that column — the index has no `supersedes` column), EXTRACTED/high; (2) **derived-from** edges from the propose-copy's `derived_from` frontmatter (now also an index column, schema v10), EXTRACTED/high; (3) **relates-to** edges from `[[wiki-link]]` body mentions of a node's ULID, EXTRACTED/high, and from bare ULID mentions, INFERRED/high; (4) **relates-to** from shared tags at a fixed ladder — 1 shared tag → low, 2 → medium, ≥3 → high — INFERRED, capped at `MAX_SHARED_TAG_EDGES_PER_NODE = 12` per node and `MAX_SHARED_TAG_NODES = 2000` overall so one universal tag cannot produce an O(n²) edge set; one relational edge per unordered pair, EXTRACTED beats INFERRED on the same pair. Stored in `graph_edges`/`graph_meta` beside the rebuildable index with `CREATE TABLE IF NOT EXISTS` (like `memory_usage`, D77), so the graph is derived, disposable, and never touches Markdown or the source of truth. Every mutating path refreshes it automatically (`refreshGraphQuiet` on the write hooks: add/supersede/soft + hard forget on both hosts, keyword capture, propose, review promotion, CLI add/supersede/status/forget); `refreshGraph` is the explicit `graph build` path and reports honestly (D63 — a missing id fails, findings never invent nodes). **Outline** (`src/graph/outline.ts`, pure): connected components joined **only by medium+ INFERRED shared-tag edges** (the universal-tag collapse guard — a single low/medium tag must not merge unrelated memories; fixture-pinned in `smoke-pure.ts`), rendered `topic (n): titles…` with the cut disclosed at `maxLines` (config `graphOutlineLines`, default 10, cap 30); the compiled outline is stored in `graph_meta` and injected once at session start next to the working-state note (`graphOutline`, default on; injected lines contribute exposure ids to D77 `recordRetrieved`, never usefulness). **Queries** (`src/graph/queries.ts`, pure): `graph neighbours <id> [--depth 1-6]` (BFS, default 1, per-edge receipts with type/provenance/confidence) and `graph path <a> <b>` (shortest path, default depth 4, per-hop receipts). **Lint** (`src/graph/lint.ts`, pure): orphans (active, no topic, no edges), dangling edges (endpoint absent from the index — but an endpoint that exists in *another* scope is a legitimate foreign link, e.g. a propose copy deriving from its personal original, and is skipped), and near-stale pairs (similarity ≥ 0.8, chains excluded) via the existing lifecycle `similarity()`; reports only, nothing auto-resolved — this is the report D78's pre-submit lint consumes (wired in D93). Scope contract: the graph covers the cwd's **project** scope only, no `--scope` flag, `personal` never graphs (§20.5). The interface is **CLI only** (`open-memex graph build|neighbours|path|lint|outline`) — the MCP surface stays at 13 tools; the outline reaches sessions through injection, not a tool (§20.6). Schema bump: added `derived_from TEXT` to `memories` (`SCHEMA_VERSION` 9 → 10, rebuild-from-Markdown migration — the frontmatter field already existed at `markdown.ts`). The **LLM half** — abstracted insights and missing-page alerts that propose new memories — remains open in §18/§20 and must go through the D61 propose-first flow.
  *Status (2026-11-06): 部分实现 (0.9.0-alpha.6) — deterministic half shipped: `src/graph/{extract,outline,queries,lint}.ts` + `src/store/graph.ts`, auto-refresh on every mutating path, outline injection, CLI `graph` group; smoke-pure + test-full (154 checks) green. LLM half (abstracted insights, missing-page → new memories) remains 未实现.*

- **D92 — feedback-weighted ranking, first slice (2026-11-11).** The D79 follow-up that D77-L2 unblocked: the reuse counters now have a *measured*, deliberately small effect on `search()` order. **Measurement first:** commit 1 added a 3-query reuse slice to `scripts/retrieval-eval.ts` — each query has a gold memory carrying `retrieved=5..6, useful=3` counters and a near-tied distractor with the same retrieval count but zero useful confirmations — and seeded that telemetry through the real `recordRetrieved`/`recordUseful` API. Baseline with feedback still off: 60 memories / 47 queries, R@1 0.660 / R@5 0.979 / MRR 0.804. **Mechanism:** `src/retrieve/feedback.ts` (pure, smoke-tested) reorders only inside a near-tied BM25 band (score ≥ **0.75×** the band head), only among hits with `retrieved_count >= 3`, by `reuse_rate` descending, and only within a contiguous run of eligible hits — so an ineligible/new memory keeps its exact BM25 slot and its neighbours cannot leapfrog it. The BM25 score is never changed; `search --explain` still prints it, plus a `feedback:` line listing every promotion (`↑ id +N (reuse …)`) so the trace is auditable. Tiers are reordered independently, so feedback never lifts a draft over reviewed knowledge. Config is a flat key `feedbackWeighting` (**default false**, `SETTABLE_KEYS`, shallow-merge-safe); callers (`memory_search` both hosts, CLI `search`) pass it, and the eval passes both values explicitly. **Result:** weighted R@1 0.702 / R@5 0.979 / MRR 0.825; reuse slice MRR 0.500 → 0.833 (two of three golds promoted 2→1). Band sweep on the fixture: 0.95 → no effect, 0.9/0.85/0.8 → +1 R@1, 0.75 → +2, 0.67 → +3; 0.75 is shipped because it is the widest band that still catches the two strongest reuse signals; 0.67 would also promote a hit ~33% below the band head, which is a relevance gap, not a near-tie. **Guardrails unchanged (D77):** useful only via `memory_useful`, human approve at review, or supersede — passive exposure still increments only `retrieved_count`; `reuse_rate` may exceed 1.0 and is signal strength, never a prune threshold; counters stay in local SQLite and survive index rebuilds. **Explicitly not in this slice:** embedding gate, cross-lingual rerank (D79 item 4, after D78), automatic zombie demotion/eviction (D78), and any change to `memory_useful` or the D77-L3 report's accounting.
  *Status (2026-11-11): 已实现（第一刀，0.10.0-alpha.2）— `src/retrieve/feedback.ts` + `search()` wiring + `feedbackWeighting` flat key + `search --explain` promotion trace; fixture baseline vs weighted numbers in `scripts/retrieval-eval.ts`. D79 的 embedding gate / 跨语言 rerank / 自动淘汰仍留给后续。*

- **D93 — deterministic pre-submit curation, first slice (2026-11-13).** Implements D78's **auto-apply** tier only, keeping the submit boundary explicit: `submit` now reports graph lint and auto-curates deterministic defects, but the human still chooses the ids and never has a share action performed for them. **Measurement first:** commit 1 (`4db3174`) added `scripts/curate-eval.ts` as a checked-in fixture with no product curation logic; its baseline is 9 lint findings (7 orphans, 1 dangling edge, 1 stale pair), 1 exact duplicate, 1 empty body, 2 title-normalization candidates, and 1 near-duplicate report. **Planner:** `src/curate.ts` (pure, smoke-tested) orders archive-empty → merge-duplicate → normalize-title, then by id. Exact duplicates are `contentHash()`-identical whitespace-normalized bodies; the canonical is the oldest free active record (ties by id), chain-managed records are never chosen, and a duplicate is appended at the oldest tail of the canonical's supersede chain so no history is dropped. Empty / whitespace-only bodies are archived, not deleted. Title normalization rewrites only the first non-empty line (trim + collapse internal whitespace) - line count and every other byte stay intact. Near-duplicates (`similarity() >= 0.8`) remain **report-only**; semantic merge/split and inferred type/tags need a human and are explicitly out of this slice. **Write half:** `src/store/curate.ts` applies actions through the existing lifecycle primitives (`atomicWriteTextSync`, `setStatus`, chain fields, append-only `review_history`) and immediately reindexes. Every applied action emits a receipt in `review_history`; merge and title actions are reversed by `open-memex curate undo <id>`, empty-body archives also by `open-memex status <id> active`. A title undo refuses if the first line changed after curation. **Submit wiring:** validate → branch/conflict preflight → lint report → deterministic apply → re-read and submit only records still `active` → copy + local commit. Lint is report-only and never blocks. A non-active record is history, not a submit candidate (`status is <x>, only active memories can be submitted`). Curated-out outbox files stay in appdata as history and are excluded from the pending count (`outboxHistory` in `sync-status`). If the submit fails before its local commit, applied curation is undone best-effort so the outbox returns to its prior state. `--no-curate` skips the apply tier but still prints lint; the boolean-flag parser accepts it before or after the ids. `graph lint` no longer flags an intentional supersede-chain duplicate as stale. **Result on the fixture:** curated submit reduces the report from 9 findings to 6 (orphans 7→4, dangling 1→1, stale 1→1), auto-applies exactly 3 actions (merge 1, archive 1, title 1), `--no-curate` applies 0, and all 3 undo checks pass; `typecheck`, build, `smoke-pure`, and `test-full` pass. **Still open (D78):** semantic merge/split, batch-confirm screen, inferred type/tags, the undo→confidence feedback loop, and attaching the curation summary to a PR description.
  *Status (2026-11-13): 部分实现（第一刀，0.10.0-alpha.3）— `src/curate.ts` + `src/store/curate.ts` + `submit` wiring + `--no-curate` + `curate undo`; `scripts/curate-eval.ts` pins baseline vs curated numbers. Batch-confirm 与语义合并仍开放。*
