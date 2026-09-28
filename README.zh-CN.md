# open-memex

[English](./README.md)

给 AI 编程助手的本地优先持久记忆：一个 [opencode](https://opencode.ai) 插件，
加上一个通用 MCP server（VS Code Copilot、Cursor、Claude Code、Visual Studio 等）。

- **Markdown 文件**是 source of truth（人类可读、git 友好）
- **SQLite FTS5** 做可重建索引（BM25 关键词检索，`better-sqlite3`）
- **零云端**、零账号、零第三方 API
- 直接跑在 opencode 内嵌的 Bun 运行时里；CLI 和 MCP server 跑在 Node 下——开发时无需构建（发布的 npm 包带预编译好的 JS）、无需安装 Bun

## 安装

### 前置要求

- **Node.js ≥ 22.6**（`open-memex doctor` 会帮你检查）

### 第一步——安装 CLI

**npm（推荐）：**

```sh
npm install -g open-memex
```

安装的是 `0.3.0` 正式版。

**免安装——用 npx 直接跑：**

```sh
npx -y open-memex <命令>   # 例如 npx -y open-memex init --client vscode
```

**从源码安装**（最新开发版，`V2-dev-p2` 分支）：

```sh
git clone -b V2-dev-p2 https://github.com/stoneskin/open-memex.git
cd open-memex
npm install
node --experimental-strip-types src/cli.ts <命令>
```

#### 提示 "'open-memex' 不是内部命令"？——PATH 设置

`npm install -g` 会把 `open-memex` 启动器放到 npm 的全局 bin 目录。
如果终端找不到它，说明该目录不在你的 `PATH` 里：

1. 先找到这个目录：`npm config get prefix`
   - **Windows：** 启动器（`open-memex.cmd`）就在该目录下，例如
     `C:\Users\<你>\AppData\Roaming\npm`
   - **macOS / Linux：** 在 `<prefix>/bin` 下，例如 `/usr/local/bin`
     或 `~/.nvm/versions/node/v22.x.x/bin`
2. 把它加进 `PATH`：
   - **Windows：** 设置 → 系统 → 关于 → 高级系统设置 → 环境变量 →
     把该目录加到*用户*的 `Path` 里 → **重启终端**。用 `where open-memex` 验证。
   - **macOS / Linux：** 在 `~/.zshrc`（或 `~/.bashrc`）里加一行
     `export PATH="$(npm prefix -g)/bin:$PATH"`，重启 shell，
     用 `command -v open-memex` 验证。
3. 没有管理员权限 / 不想动 `PATH`？用上面的 npx 形式——npx 自己解析包，
   不需要改 `PATH`。

#### Windows 重装报 "`EBUSY` / `EPERM`（`better_sqlite3.node`）"

Windows 下被进程加载的 DLL 是锁死的：如果 open-memex MCP server 正在运行
（VS Code MCP 面板、Cursor 等），`npm install -g open-memex` 替换不了
`better_sqlite3.node`，就会报 `EBUSY` / `EPERM`。先停掉 MCP server
（或退出编辑器），再重跑安装。还不行的话，手动删掉全局 npm 目录下的
`node_modules/open-memex` 和 `node_modules/.open-memex-*` 临时目录，再装。

### 第二步——给你的编辑器一键配置

在**项目根目录**下运行（这样 project scope 会解析到这个仓库）：

**VS Code**（Copilot）：

```sh
open-memex init --client vscode
# ……没装全局包的话：
npx -y open-memex init --client vscode
```

自动写 `.vscode/mcp.json` 和用户级 Copilot instructions，然后重新加载窗口，
在 Copilot Chat 的 MCP 面板里确认 `open-memex` server 已启动。

**Cursor：**

```sh
open-memex init --client cursor
```

自动写 `.cursor/mcp.json` 和用户级 Copilot instructions。

**opencode**（作为普通 MCP 客户端）：

```sh
open-memex init --client opencode
```

写项目级 `opencode.jsonc`（`type: "local"`）。想用原生插件？
在 `~/.config/opencode/opencode.jsonc` 里加
`"plugin": ["file:///absolute/path/to/open-memex/src/index.ts"]`——
在 tools 之外还能获得关键词自动捕获和首轮上下文注入。

**Claude Code**（在项目根目录运行）：

```sh
claude mcp add open-memex -- open-memex mcp
# ……或打印配置片段：open-memex mcp --print-config claude
```

**Visual Studio**（在 solution 目录运行）：

```sh
open-memex init --client visualstudio
```

写 solution 级 `.mcp.json` 和用户级 Copilot instructions。需要
Visual Studio 2022 17.14+ 或 Visual Studio 2026（**仅 Windows**）。
Visual Studio 也会自动发现 `.vscode/mcp.json` 和 `.cursor/mcp.json`，
所以上面的 VS Code 配置同样可用。

**Codex：** 暂无 `init` 客户端——以 `open-memex mcp --print-config` 为起点手动添加
（`config.toml` 的 `[mcp_servers]`，或 `codex mcp add`）。

`init` 说明：

- Copilot 记忆 instructions 默认写到**用户级**
  （`~/.copilot/copilot-instructions.md`；Visual Studio 是
  `%USERPROFILE%\copilot-instructions.md`）——所有项目生效，永不 checkin
  到 repo，没装 open-memex 的同事看不到、也不会出错。团队人人都用
  open-memex 时可用 `--instructions project` 改写
  `.github/copilot-instructions.md`。
- 在终端里会交互式询问：配哪个编辑器、是否开启关键词自动捕获、
  是否在首轮注入记忆。`--yes` 全用默认值；脚本 / 非 TTY 环境不提问
  （编辑器默认 VS Code）。
- 已有配置文件会被**合并，不会被覆盖**——重复运行是安全的。
  `--force` 强制覆盖。
- 如果 `PATH` 上没有可用的 `open-memex`（比如一次性 npx），`init` 会把
  `npx -y open-memex mcp` 写进配置，配置照样能用。
  以后 `npm i -g open-memex` + `open-memex init --force` 可切换到更快
  的直接调用。

### 第三步——验证

```sh
open-memex doctor
```

检查：Node 版本、配置来源、当前目录的 scope 解析、存储可写性，
然后启动一个真实的 MCP server 做 `initialize` + `tools/list`——
十一个 tools 都必须出现。

## Agent 可用的 tools

| Tool | 作用 |
|---|---|
| `memory_add`       | 保存事实、偏好、决定、笔记 |
| `memory_search`    | BM25 关键词检索，跨 project + personal 记忆 |
| `memory_list`      | 按 scope 列出记忆，最新的在前 |
| `memory_supersede` | 用新版本替换一条记忆（保留替换链） |
| `memory_forget`    | 按 id 删除一条记忆 |
| `memory_status`    | 显示同步队列：outbox 草稿、repo 评审状态、未提交文件 |
| `memory_submit`    | 把点名的草稿移入 repo memory 目录（建本地分支 + commit） |
| `memory_propose`   | 把 personal 记忆复制到 project scope 作为评审候选 |
| `memory_promote`   | 推进 `proposed → approved → published`（或 reject / resubmit） |
| `memory_resolve`   | 列出冲突的记忆文件 / 对单个做三路合并 |
| `memory_pr_status` | 把分支 PR 的 GitHub 状态映射到每条记忆的评审状态 |

## 捕获（Capture）

- **关键词触发**（opencode 原生插件，扫描用户消息）：中文 `记住…` /
  `记一下` / `记录一下` / `别忘了…`，英文 `remember …` / `note that …` /
  `don't forget …` / `TIL …` / `save this …`。
  Scope 路由：第一人称单数进 **personal**（`记住我…`、`替我记…`、
  `我觉得…`、`我喜欢…`、`remember for me`）；第一人称复数进当前
  **project** scope（`我们认为…`、`我们决定…`、`帮我们记住…`）。
- **Agent 主动调用** `memory_add`
- **脱敏**：`<private>…</private>` 标签内的内容会被剥离；检测到的密钥
  （API key、token、高熵凭据）就地打码——保留前 4 个字符，其余替换为 `x`——
  然后照常保存。用 `open-memex capture --dry-run "…"` 预览一条消息会被如何捕获。

## Scope

- **project** — 绑定当前仓库（用 git origin URL 哈希做 key，无 remote 则用 cwd）。新记忆默认进这里。
- **personal** — 跨所有项目全局，**仅本机，永不上传/同步**。放个人偏好。（v1 叫 `user`，`migrate --to-v2` 会自动改名。）

完整 scope 模型（key 推导、迁移、visibility、保留名）见
[docs/SCOPES.md](./docs/SCOPES.md)。

## 检索（Retrieval）

每个会话的首轮，`open-memex` 会往 system prompt 里注入一个 `[OPEN-MEMEX]` 块，
包含 top-N 最新 project 记忆 + top-N 个人偏好。Agent 也可以随时调用
`memory_search` 按需检索。

## 存储布局

```
%APPDATA%\open-memex\               (Windows)
$XDG_DATA_HOME/open-memex/          (Linux/macOS)
├── index.db                         # SQLite FTS5 索引（可重建）
└── memories/
    ├── personal/
    │   └── <id>.md
    └── project__<name>__<hash12>/
        └── <id>.md
```

每个 `.md` 文件是 v2 YAML frontmatter（`id, scope, scope_key, visibility, role,
type, importance, status, tags, created_at, updated_at, schema_version` 等）+
记忆正文。可以手工编辑——插件启动时按文件 mtime 重新同步。
Markdown 是 source of truth，SQLite 索引是派生的、可重建的
（`open-memex reindex`）。

## 配置（Config）

可选文件 `~/.config/opencode/open-memex.jsonc`（可用 `MY_O_MEMORY_CONFIG`
改路径；`MY_O_MEMORY_HOME` 改存储根目录）。

默认值：

```jsonc
{
  "maxProjectMemories": 8,    // 首轮注入的 project 记忆条数
  "maxProfileItems": 5,       // 首轮注入的个人偏好条数
  "injectOnFirstTurn": true,  // [OPEN-MEMEX] system-prompt 块
  "keywordCaptureEnabled": true,
  "logLevel": "info",          // info | debug
  "memoryDir": ".ai/open-memex" // 仓库内项目记忆目录，相对于仓库根目录
}
```

project scope 的记忆以"一个记忆一个 Markdown 文件"的形式存放在
`<仓库>/<memoryDir>/`（默认 `.ai/open-memex/`）下，可经 git 共享；
personal 记忆只存本地 appdata，永不离开本机。已有的 appdata 项目文件会在
首次写入/同步时自动搬进仓库目录。

`open-memex config` 打印生效配置（默认值 + 文件）。
安装后改设置：

```sh
open-memex config set keywordCaptureEnabled false
open-memex config set maxProjectMemories 12
```

可设置的 key：`maxProjectMemories`、`maxProfileItems`、`injectOnFirstTurn`、
`keywordCaptureEnabled`、`logLevel`、`memoryDir`。完整设计见
[docs/V2-DESIGN.md](./docs/V2-DESIGN.md)。

## CLI 参考

安装与健康检查：

```sh
open-memex init [--client vscode|cursor|opencode|visualstudio] [--force] [--yes]
open-memex config                                  # 打印生效配置
open-memex config set <key> <value>                # 改设置
open-memex doctor                                  # 环境健康检查
open-memex capture --dry-run "记住我喜欢简洁的回答"  # 预览关键词捕获
open-memex mcp --print-config vscode|cursor|claude|opencode|visualstudio
open-memex --help      # 本帮助
open-memex <command> --help  # 单个命令的帮助
open-memex --version   # 已安装版本
```

记忆操作：

```sh
open-memex add "This repo uses better-sqlite3" --type project-config
open-memex search "auth flow"
open-memex list --scope project
open-memex supersede <id> "Updated content"
open-memex status <id> deprecated
open-memex forget <id>
```

团队评审工作流（Phase 2B —— 两个家，各管一段）：

project 草稿先住在 **appdata outbox**（git 看不见、跟分支无关）；只有你
点名批准的草稿，才会被移入 `<repo>/.ai/open-memex/`，之后随分支和 PR 走。
没经过你点名，什么都不会动。

```sh
open-memex sync-status
# 看索引上次同步的时间和触发方、outbox（待同步）、repo 里的评审状态
# （draft / proposed / approved / published / rejected），
# 以及 repo 里还没 commit 的记忆文件。

open-memex submit <id...> [--onto <branch>] [--base <branch>]
# 把你点名的草稿移入 .ai/open-memex/，状态变为 proposed：
# 建 mem/sync-<timestamp> 分支（或 --onto 当前分支，跟代码走同一个 PR），
# 复制、改 review_state、本地 git commit。全有或全无；冲突（同 id 不同内容）
# 干净回滚。打印 push + gh pr 命令；Agent 拿到你的 Yes 后会自己走完 push/PR。
# PR 默认 base 是当前分支；--base 可改到 main 或集成支。

open-memex pr-status [--apply]
# 读分支的 GitHub PR，把它的状态映射到每条 in-repo 记忆：
# PR merged → published，PR approved → approved（approved_by = reviewer），
# changes requested 只给建议。默认只报告；--apply 在本地执行映射的流转（不 push）。

open-memex propose <id...> --to project [--local-approve]
# 一次 propose 一条或多条（一个分支、一个 PR），每条独立新 id。
# 全有或全无：id 有错整批回滚，不会留半截。
# 把一条 personal 记忆复制到 project scope 进入评审（复制而非移动，
# personal 原件保留）。结果落在 outbox；准备好进 repo 时再 sync-status / submit。
open-memex promote <id> [--reject] [--resubmit] [--note "..."] [--by NAME]
# 晋升一步：proposed → approved → published（或用 --reject 驳回并附注原因）。
# 每次流转都追加到记忆的 review_history（谁、何时、为什么）。
# 驳回不删文件，由你决定：接受（关 PR 删分支）、改完 --resubmit 再审、
# 或留着当 [rejected] 记录。
open-memex resolve [id-or-path]
# 列出冲突中的记忆文件，或对其中一个做字段级 3-way 合并。
# 语义冲突只报告、不自动解决。
```

维护：

```sh
open-memex where        # 显示存储与配置文件路径
open-memex scopes       # 列出 project scope 及记忆条数
open-memex reindex      # 从 markdown 重建 SQLite 索引
open-memex migrate --to-v2 [--dry-run]   # v1 数据 → v2
```

CLI 跑在 Node 22 下。从源码 checkout 使用时走内置的实验性 TypeScript loader（无需构建）；
发布的 npm 包带预编译好的 JS（发布时间执行 `npm run build`）。
从源码 checkout 使用时，每条命令前加
`node --experimental-strip-types src/cli.ts`（简单场景也可用
`npm run cli -- <命令>`——但 npm 会吞掉未知的 `--flag` 参数，
所以推荐直接用 `node`）。

## MCP server

同一个十一个 memory tools，走 Model Context Protocol 的 stdio server——
不需要宿主专属插件，任何 MCP 客户端都能用 open-memex。

```sh
open-memex mcp               # 全局安装后
npx -y open-memex mcp  # 免安装
```

project scope 从进程工作目录解析，所以配置 server 时 cwd 要指向项目根目录
（`init` 会帮你处理好）。

> **注意：** MCP 是请求/响应式的——它给 agent 提供 tools，但没有 opencode
> 插件的关键词自动捕获和首轮上下文注入。想让 agent 主动用记忆，
> 靠的是 agent 的 instructions（`init` 写的 Copilot instructions）。

## 路线图（Roadmap）

**`0.3.0`（本版）：** 通用 MCP server、`open-memex` bin/CLI、
一键 `init` 配置、中文关键词捕获（含 personal/project 路由）、
`config` / `capture --dry-run` / `doctor` 助手命令、Visual Studio 支持。

**进行中 —— `0.4.0`：** 团队同步——用 git 做共享记忆：appdata 草稿箱 →
`sync-status` → `submit`（本地分支+commit，push/PR 拿你的 Yes 才做）
→ `promote` / `resolve` 评审工作流、仓库内 `.ai/open-memex/` 目录，
找 1–2 个同事做 pilot。

**Coming —— `0.3.0`（稳定版）：** 组织层——组织记忆仓库、
curator 约定、distill-to-AGENTS.md 辅助。

**未来（看信号再定，不承诺版本）：** 原生 agent 插件
（Claude Code / Codex hooks，作为同一套 MCP tools 的增强路径）；
本地 embedding 做基准测试门控的实验（**未经明确 opt-in 绝不下载
embedding 模型**）；云端 `RemoteProvider` 定制只在多仓库共享、
ACL 或合规需求出现时才做。

设计细节：[docs/V2-DESIGN.md](./docs/V2-DESIGN.md)（append-only 决策日志 D1–D20）。

## 许可证

[Apache-2.0](./LICENSE)
