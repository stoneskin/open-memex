/**
 * Synthetic retrieval-eval fixture (D77).
 *
 * 54 personal-scope memories + 44 queries with gold ids. Written BEFORE
 * running the eval — the fixture is the test, not tuned to the results.
 * All memories share one scope/tier so the measured ranking is pure BM25.
 * Mixed EN/ZH; includes paraphrase and synonym queries (the hard cases
 * from the retrieval-robustness question), near-duplicate distractors,
 * and D81 user-defined alias vocabulary (bidirectional query-time
 * expansion: 香蕉计划 ↔ 支付系统重构项目).
 */

export interface FixtureMemory {
  id: string;
  type: string;
  tags: string[];
  aliases?: string[];
  /** D81: user-defined alias vocabulary (nickname → referent). */
  alias?: string;
  target?: string;
  body: string;
}

export interface FixtureQuery {
  query: string;
  gold: string[];
  note: string;
}

export const MEMORIES: FixtureMemory[] = [
  // ---- deploy & CI ----
  { id: "mem-001", type: "decision", tags: ["deploy", "ci"], body: "Deploy to production only from the release branch. Merging to main triggers staging; the release branch is cut from main every Thursday and production deploys only from release/*." },
  { id: "mem-002", type: "gotcha", tags: ["ci", "github-actions"], body: "GitHub Actions macOS runners are 10x the per-minute cost of linux. The e2e job was moved to ubuntu-latest and macOS is kept only for the notarization step." },
  { id: "mem-003", type: "howto", tags: ["deploy", "rollback"], body: "To roll back a production deploy: revert the merge commit on the release branch, push, and the pipeline redeploys the previous artifact. Do not redeploy old artifacts manually from the Actions UI." },
  { id: "mem-004", type: "fact", tags: ["ci"], body: "CI runs lint, typecheck, unit tests, and the smoke suite on every PR. The full e2e suite runs only on the release branch to save minutes." },
  // distractor: shares deploy vocabulary, different topic
  { id: "mem-005", type: "fact", tags: ["deploy"], body: "The deploy dashboard is at deploys.internal.example.com. It shows who deployed what and when, but rollbacks must still go through the release branch revert flow." },

  // ---- testing ----
  { id: "mem-006", type: "preference", tags: ["testing"], body: "Prefer table-driven tests over copy-pasted cases. One test function, a slice of inputs and expected outputs — much easier to extend than five near-identical test blocks." },
  { id: "mem-007", type: "gotcha", tags: ["testing", "flaky"], body: "The checkout flow test is flaky on CI because it depends on wall-clock timing. It was quarantined with t.Parallel disabled and a retry wrapper; do not unquarantine without fixing the clock dependency." },
  { id: "mem-008", type: "decision", tags: ["testing", "coverage"], body: "Coverage gate is 80% on new code, measured by the CI coverage job. Legacy modules are exempt until they are touched — then the touched lines must be covered." },

  // ---- editor & tools ----
  { id: "mem-009", type: "preference", tags: ["editor", "vscode"], body: "VS Code: format on save with the workspace prettier config, never the global one. The workspace config lives in .vscode/settings.json and wins over user settings." },
  { id: "mem-010", type: "howto", tags: ["git"], aliases: ["how to undo last commit", "git revert commit"], body: "To undo the last local commit but keep the changes: git reset --soft HEAD~1. To discard everything including working tree: git reset --hard HEAD~1 (destructive, no undo)." },
  { id: "mem-011", type: "fact", tags: ["node"], body: "The repo pins Node 22.14.0 in .nvmrc. CI and the Dockerfile both use it; running 20.x locally causes the better-sqlite3 native binding to fail to load." },

  // ---- database ----
  { id: "mem-012", type: "gotcha", tags: ["postgres", "migrations"], body: "Postgres migrations must be backward compatible: never drop a column in the same release that stops writing to it. Expand first, migrate, then contract in the next release." },
  { id: "mem-013", type: "decision", tags: ["postgres", "index"], body: "Added a partial index on orders(status) WHERE status = 'pending' after the pending-orders query started sequential-scanning 40M rows. Query time went from 9s to 40ms." },
  { id: "mem-014", type: "howto", tags: ["sqlite"], aliases: ["sqlite busy timeout", "database is locked fix"], body: "SQLite 'database is locked' under concurrent writers: enable WAL mode and set a busy timeout (PRAGMA busy_timeout=5000). Readers never block writers in WAL." },

  // ---- API design ----
  { id: "mem-015", type: "decision", tags: ["api", "rest"], body: "Public API uses cursor pagination (opaque cursor param), never offset/limit. Offset breaks when rows are inserted concurrently; the cursor is the last seen id." },
  { id: "mem-016", type: "lesson", tags: ["api", "versioning"], body: "Lesson from the v2 migration: versioning the whole API at once was a mistake. Additive changes ship unversioned; only breaking changes get a new version prefix." },

  // ---- security ----
  { id: "mem-017", type: "constraint", tags: ["security", "secrets"], body: "Never commit secrets. The pre-commit hook runs gitleaks; if a secret lands in history it must be rotated immediately — rewriting history does not unexpose it." },
  { id: "mem-018", type: "howto", tags: ["security", "jwt"], aliases: ["refresh token rotation"], body: "JWT access tokens live 15 minutes; refresh tokens rotate on every use and are bound to the device fingerprint. A reused refresh token invalidates the whole token family." },

  // ---- performance ----
  { id: "mem-019", type: "gotcha", tags: ["performance", "n+1"], body: "The N+1 in the invoice endpoint came from lazy-loading line items per invoice in a loop. Fixed with a single JOIN fetch; p95 dropped from 2.1s to 180ms." },
  { id: "mem-020", type: "decision", tags: ["performance", "caching"], aliases: ["cache invalidation strategy"], body: "Cache invalidation uses write-through for the product catalog: writes update both DB and cache synchronously. Stale reads were worse than the write latency cost." },

  // ---- Chinese memories ----
  { id: "mem-021", type: "decision", tags: ["部署", "规范"], body: "生产环境只允许周四发布，紧急 hotfix 需要 TL 在发布群里 @所有人 说明原因。周五不发布，避免周末 oncall。" },
  { id: "mem-022", type: "gotcha", tags: ["微信", "小程序"], body: "微信小程序的 request 并发上限是 10，超过会直接失败不排队。批量上传图片必须自己做并发控制，分批 8 个一组发。" },
  { id: "mem-023", type: "preference", tags: ["代码风格"], body: "中文注释写在代码上方，不要写在行尾。行尾注释在窄屏和 diff 里经常被截断，上方注释可读性更好。" },
  { id: "mem-024", type: "howto", tags: ["git", "中文"], aliases: ["git 中文乱码", "commit message 乱码"], body: "Windows 上 git log 中文乱码：设置 git config --global core.quotepath false，同时把终端编码调成 UTF-8。" },
  { id: "mem-025", type: "fact", tags: ["考勤"], body: "每月 5 号之前提交上月考勤，逾期系统自动锁定找 HR 解锁。弹性工作制但 10 点前要到岗。" },
  // distractor sharing vocab
  { id: "mem-026", type: "fact", tags: ["发布"], body: "发布群是企业微信里的「发版通知」群，CI 成功后机器人会自动推送版本号和 changelog 链接。" },

  // ---- incidents ----
  { id: "mem-027", type: "lesson", tags: ["incident", "postgres"], body: "Incident 2026-08: the primary ran out of disk because WAL archiving stalled silently. Lesson: alert on archive_command failures, not just disk usage — disk was the symptom." },
  { id: "mem-028", type: "lesson", tags: ["incident", "dns"], body: "Incident 2026-09: DNS TTL of 24h turned a 5-minute failover into a day-long outage. Critical records now use 300s TTL; the long TTL only ever saved pennies." },

  // ---- architecture decisions ----
  { id: "mem-029", type: "decision", tags: ["architecture", "monorepo"], body: "Monorepo with pnpm workspaces won over polyrepo: cross-package refactors were the dominant pain and CI can already scope builds per changed package." },
  { id: "mem-030", type: "decision", tags: ["architecture", "queue"], body: "Chose SQS over RabbitMQ for the notification pipeline: at-least-once delivery is fine there, and we did not want to operate another stateful service." },
  { id: "mem-031", type: "fact", tags: ["architecture"], body: "The system has three services: api-gateway (edge), core (business logic), worker (async jobs). The worker scales independently on queue depth." },

  // ---- frontend ----
  { id: "mem-032", type: "gotcha", tags: ["react", "hooks"], body: "React useEffect with an empty dep array still re-runs in StrictMode dev double-invoke. Effects that POST must be idempotent or guarded by a ref — production is fine, dev double-fires." },
  { id: "mem-033", type: "preference", tags: ["css"], body: "Use CSS modules for component styles, global stylesheet only for resets and tokens. The one time we put component CSS global it leaked into the admin panel." },

  // ---- personal productivity ----
  { id: "mem-034", type: "preference", tags: ["productivity"], body: "Deep work block is 9–11am, no meetings. The calendar auto-declines invites in that window with a note pointing to the team agreement." },
  { id: "mem-035", type: "fact", tags: ["productivity", "standup"], body: "Standup is async in Slack #standup by 10am. Format: yesterday / today / blockers, one line each. No video call unless someone flags a blocker." },

  // ---- more distractors & variety ----
  { id: "mem-036", type: "fact", tags: ["ci"], body: "The CI badge in the README reflects the main branch only. PR builds show as checks on the PR itself, not on the badge." },
  { id: "mem-037", type: "howto", tags: ["docker"], body: "Multi-stage Docker build: first stage compiles with dev dependencies, final stage copies only dist/ and production node_modules. Image went from 1.2GB to 180MB." },
  { id: "mem-038", type: "gotcha", tags: ["docker", "arm"], body: "Docker builds on Apple Silicon default to arm64; the prod cluster is amd64. Always build with --platform linux/amd64 or the container crashes on deploy with exec format error." },
  { id: "mem-039", type: "decision", tags: ["logging"], body: "Structured JSON logs everywhere, no free-text log lines. The log aggregator parses fields; free text broke the error-rate dashboard twice." },
  { id: "mem-040", type: "preference", tags: ["code-review"], body: "Code review SLA: first review within 4 business hours. If you are blocked on review, ping in #dev — do not merge your own PR except for docs." },

  // ---- synonyms/paraphrase targets ----
  { id: "mem-041", type: "howto", tags: ["k8s"], aliases: ["kubernetes pod crashloop", "pod 一直重启"], body: "Kubernetes CrashLoopBackOff: check kubectl describe pod for the exit code first, then logs --previous. Nine times out of ten it is a missing env var, not the image." },
  { id: "mem-042", type: "fact", tags: ["oncall"], body: "Oncall rotation is weekly, Monday to Monday. The handoff note must list: active incidents, risky deploys this week, and anything with a TODO owner on vacation." },
  { id: "mem-043", type: "decision", tags: ["auth"], body: "SSO via OIDC is mandatory for all internal tools. Password-only auth was removed after the credential-stuffing scare in March; service accounts use mTLS instead." },
  { id: "mem-044", type: "gotcha", tags: ["timezone"], body: "Store all timestamps in UTC, convert at the display edge. The reporting bug that mixed server-local time with UTC took a week to untangle because both looked plausible." },
  { id: "mem-045", type: "howto", tags: ["ssh"], body: "SSH into prod goes through the bastion with agent forwarding disabled. Copy the key to the bastion instead — forwarding once let a compromised dev box pivot further." },
  { id: "mem-046", type: "preference", tags: ["meetings"], body: "No-meeting Wednesdays for the eng team. Recurring meetings that land on Wednesday get moved, not exempted." },
  { id: "mem-047", type: "fact", tags: ["vpn"], body: "The company VPN auto-disconnects after 12 hours. Long-running remote jobs should run on the dev server inside the network, not over a laptop VPN session." },
  { id: "mem-048", type: "lesson", tags: ["estimation"], body: "Estimates are given as ranges (3–5 days), never single numbers. The single-number estimates were wrong 80% of the time; ranges forced the uncertainty conversation upfront." },
  { id: "mem-049", type: "fact", tags: ["备份", "数据库"], body: "数据库备份每天凌晨两点执行，全量保留三十天，恢复演练每个季度做一次。" },
  { id: "mem-050", type: "decision", tags: ["发布", "测试"], body: "上线前必须跑完全量回归测试，测试报告要贴到发布群里，TL 确认后才能发。" },
  { id: "mem-051", type: "gotcha", tags: ["staging"], body: "The staging environment wipes itself every night at midnight. Never leave test data there overnight — it will be gone by morning." },

  // ---- D81 user-defined alias vocabulary (query-time expansion) ----
  { id: "mem-052", type: "fact", tags: ["alias"], alias: "香蕉计划", target: "支付系统重构项目", body: "香蕉计划是支付系统重构项目的内部代号，团队日常用香蕉计划指代这个项目。" },
  { id: "mem-053", type: "decision", tags: ["backend"], body: "支付系统重构项目决定用 Go 重写网关层，Q4 启动。" },
  { id: "mem-054", type: "fact", tags: ["planning"], body: "香蕉计划下周一启动评审，材料周五前提交。" },
];

export const QUERIES: FixtureQuery[] = [
  // ---- exact-term queries ----
  { query: "production deploy release branch", gold: ["mem-001"], note: "exact terms" },
  { query: "GitHub Actions macOS runner cost", gold: ["mem-002"], note: "exact terms" },
  { query: "rollback production deploy revert", gold: ["mem-003"], note: "exact terms" },
  { query: "table driven tests", gold: ["mem-006"], note: "exact terms" },
  { query: "partial index pending orders", gold: ["mem-013"], note: "exact terms" },
  { query: "cursor pagination offset", gold: ["mem-015"], note: "exact terms" },
  { query: "WAL archiving disk full", gold: ["mem-027"], note: "exact terms" },
  { query: "JWT refresh token rotation", gold: ["mem-018"], note: "exact terms" },

  // ---- paraphrase queries (same meaning, different words) ----
  { query: "how do I undo my last commit", gold: ["mem-010"], note: "paraphrase; alias covers it" },
  { query: "sqlite locked concurrent writers", gold: ["mem-014"], note: "paraphrase; alias covers it" },
  { query: "k8s pod keeps restarting", gold: ["mem-041"], note: "paraphrase; alias covers it" },
  { query: "when can we ship to prod", gold: ["mem-001"], note: "paraphrase of deploy rule" },
  { query: "tests that fail randomly on CI", gold: ["mem-007"], note: "paraphrase: flaky" },
  { query: "why did the API versioning go wrong", gold: ["mem-016"], note: "paraphrase of lesson" },
  { query: "slow invoice endpoint fix", gold: ["mem-019"], note: "paraphrase: N+1" },

  // ---- synonym queries (no shared content words) ----
  { query: "shipping code to production safely", gold: ["mem-001"], note: "synonym: shipping/deploy" },
  { query: "unreliable test quarantine", gold: ["mem-007"], note: "synonym: unreliable/flaky" },
  { query: "database locking issue", gold: ["mem-014"], note: "synonym" },
  { query: "stale data problem cache", gold: ["mem-020"], note: "synonym: stale reads" },

  // ---- Chinese queries ----
  { query: "周四发布 hotfix 流程", gold: ["mem-021"], note: "CJK exact" },
  { query: "小程序并发限制", gold: ["mem-022"], note: "CJK exact" },
  { query: "git 中文显示乱码", gold: ["mem-024"], note: "CJK; alias covers it" },
  { query: "注释写在哪里比较好", gold: ["mem-023"], note: "CJK paraphrase" },
  { query: "考勤什么时候交", gold: ["mem-025"], note: "CJK paraphrase" },

  // ---- cross-language (expected hard) ----
  { query: "production release thursday rule", gold: ["mem-021"], note: "EN query, ZH memory — hard" },
  { query: "wechat miniprogram request limit", gold: ["mem-022"], note: "EN query, ZH memory — hard" },

  // ---- vocabulary-mismatch (translation pairs; the real-world slice LongMemEval-S lacks) ----
  // Written 2026-10-07 BEFORE any index-time expansion or embedding layer exists:
  // each query shares ~zero content words with its gold memory.
  { query: "database backup retention policy", gold: ["mem-049"], note: "EN query, ZH memory — 备份/保留" },
  { query: "full regression test before production release", gold: ["mem-050"], note: "EN query, ZH memory — 回归/上线" },
  { query: "预发布环境数据为什么会丢", gold: ["mem-051"], note: "ZH query, EN memory — staging/wipe" },
  { query: "单点登录强制要求", gold: ["mem-043"], note: "ZH query, EN memory — SSO/mandatory" },

  // ---- distractor resistance ----
  { query: "where is the deploy dashboard", gold: ["mem-005"], note: "must prefer mem-005 over mem-001/003" },
  { query: "CI badge meaning", gold: ["mem-036"], note: "must prefer mem-036 over mem-004" },
  { query: "docker image too big", gold: ["mem-037"], note: "must prefer mem-037 over mem-038" },
  { query: "container crashes on deploy", gold: ["mem-038"], note: "must prefer mem-038 over mem-037" },
  { query: "standup format", gold: ["mem-035"], note: "exact" },
  { query: "oncall handoff", gold: ["mem-042"], note: "exact" },
  { query: "monorepo or polyrepo", gold: ["mem-029"], note: "exact" },
  { query: "timestamps UTC or local", gold: ["mem-044"], note: "paraphrase" },

  // ---- synonym-only queries (round 1 sees none of these words; round 2 must catch them) ----
  { query: "how do we ship", gold: ["mem-001"], note: "synonym-only: ship→deploy/release" },
  { query: "pager schedule", gold: ["mem-042"], note: "synonym-only: pager→oncall" },
  { query: "my token got exposed", gold: ["mem-017"], note: "synonym-only: token→secret" },

  // ---- D81 alias-memory queries (bidirectional query-time expansion) ----
  { query: "香蕉计划用什么语言重写网关", gold: ["mem-053"], note: "alias→target: round 2 must find mem-053 via 支付系统重构项目" },
  { query: "支付系统重构项目什么时候启动评审", gold: ["mem-054"], note: "target→alias: round 2 must find mem-054 via 香蕉计划" },
  { query: "香蕉计划是哪个项目的代号", gold: ["mem-052"], note: "alias memory itself, round 1" },
];
