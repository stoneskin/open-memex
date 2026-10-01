# open-memex

> 共享组织记忆层，帮助人与 AI 捕获、沉淀并复用组织知识。

[![npm version](https://img.shields.io/npm/v/open-memex.svg)](https://www.npmjs.com/package/open-memex)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

[English](./README.md)

给 AI 编程助手的本地优先持久记忆：一个 [opencode](https://opencode.ai) 插件，
加上一个通用 MCP server（VS Code Copilot、Cursor、Claude Code、Visual Studio 等）。

## 为什么需要 open-memex？

工程知识只存在于两个地方：代码里，和人的脑子里。
每个新的 AI 编程会话都从零开始——同样的项目背景要反复讲，同样的坑要反复踩，
同样的事故教训在聊天结束时就消失了。

open-memex 把值得记住的部分——决策、约束、教训——存成可 review 的 Markdown，
并在下一次会话开始时自动注入回去。

> No capture, nothing to inherit.（不记录，就无从传承。）

### 一份记忆，所有 Agent 通用

大多数开发者并不是只用一个 AI 工具——同一台电脑上可能装着 VS Code Copilot、
Cursor、opencode、Claude Code。但每个工具的记忆都是孤岛：在 A 里定好的决策，B 一无所知。

open-memex 天生与工具无关。记忆以 Markdown + SQLite 的形式存在项目旁边，
所有编辑器都通过同一个 MCP 接口读写。用 `open-memex init` 接上两三个客户端，
它们读写的是这台机器上的同一份记忆：在 VS Code 里记下的约束，opencode 会遵守；
在 Cursor 里学到的教训，Claude Code 也看得到。

> 记忆属于你，不属于工具。

它也补齐了 agentic 开发工作流（spec 驱动开发、plan/implement/verify 循环）缺的那一块：
plan 产出决策，verify 产出规则——open-memex 是让它们跨会话留存的记忆层，
而不是每次从头重新推导。

## 和其它方案的对比

| | open-memex | 云端记忆服务 | Wiki / 文档平台 | 聊天记录 |
|---|---|---|---|---|
| 数据在哪 | 你的机器 + 你的仓库 | 服务商服务器 | 中心服务器 | 聊天结束就没了 |
| 分享前 review | 有——outbox + PR | 不一定 | 有 | 没有 |
| Agent 回忆 | 会话开始注入 + 搜索 | 调 API | 人工去查 | 没有 |
| 人类可读 | 纯 Markdown 文件 | 后台 / API | 有 | 没有 |
| 跨 AI 工具通用 | 可以——同一台机器上的任何 MCP 客户端 | 按集成逐个对接 | 不可以 | 不可以 |

- **Markdown 文件**是 source of truth（人类可读、git 友好）
- **SQLite FTS5** 做可重建索引（BM25 关键词检索，`better-sqlite3`）
- **零云端**、零账号、零第三方 API
- 直接跑在 opencode 内嵌的 Bun 运行时里；CLI 和 MCP server 跑在 Node 下——开发时无需构建（发布的 npm 包带预编译好的 JS）、无需安装 Bun

## 架构

```text
                        ┌──────────────────┐
                        │     AI agent     │
                        │ Copilot / Cursor │
                        │ Claude / opencode│
                        └────────┬─────────┘
                                 │ MCP (stdio) — 11 tools
                                 │ session-start injection
                        ┌────────▼─────────┐
                        │    open-memex    │
                        │    MCP server    │
                        └──┬────────────┬──┘
                           │            │
              ┌────────────▼───┐  ┌─────▼──────────┐
              │ Markdown files │  │ SQLite FTS5    │
              │ source of truth│  │ rebuildable    │
              │ local-first    │  │ index (BM25)   │
              └─────────────┬──┘  └────────────────┘
                            │ submit (explicit,
                            │  local commit)
                    ┌───────▼────────┐
                    │    Git repo    │
                    │ .ai/open-memex/│
                    │  PR-reviewed   │
                    │  team memory   │
                    └────────────────┘

personal scope：只属于这台机器——永不同步，永远进不了仓库。
```

## 安装

### 前置要求

- **Node.js ≥ 22.6**（`open-memex doctor` 会帮你检查）

### 第一步——安装 CLI

#### 稳定版 vs Alpha 版

**稳定版**（推荐大多数用户）——`latest` 标签：

```sh
npm install -g open-memex
```

安装的是 `0.5.1` 正式版。

**Alpha 版**（最新开发版，给测试者）——`alpha` 标签：

```sh
npm install -g open-memex@alpha
```

```sh
open-memex init
```

不跑 `open-memex init` 把编辑器接上，安装就不算完成（支持 VS Code、Cursor、opencode）。

查看已发布版本：

```sh
npm view open-memex version         # 最新稳定版
npm view open-memex@alpha version   # 最新 alpha 版
```

Alpha 版可能有毛边——欢迎报 bug。

**免安装——用 npx 直接跑：**

```sh
npx -y open-memex <命令>          # 例如 npx -y open-memex init --client vscode
npx -y open-memex@alpha <命令>   # alpha 线，免安装
```

**从源码安装**（最新开发版，`main` 分支）：

```sh
git clone -b main https://github.com/stoneskin/open-memex.git
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

```sh
open-memex init --yes
# ……没先装包的话：
npx -y open-memex init --yes
```

不带 `--client` 时，`init` 会**自动检测本机装了哪些编辑器，一次全接上**——
支持用户级的编辑器走用户级（VS Code / Cursor 的 MCP 配置、opencode 原生插件），
一次 init，所有项目通用；项目里有 solution 文件时 Visual Studio 也会一起配。
想只配某一个编辑器？加 `--client`：

> **两个"全局"不是一回事，别搞混。**
> - `npm install -g open-memex` 是把*包*装到全局：让 `open-memex` 命令出现在
>   你的 PATH 里。
> - `init --global` 是把*编辑器配置*写到用户级而不是项目里：init 一次，
>   每个项目都生效。不管包是全局安装的还是用 npx 临时跑的，效果一样。

装完包还会打印一句提醒，让你跑 `open-memex init`——接线是独立的一步。
如果你在从没跑过 init 的机器上直接敲 `open-memex`，它会问你要不要现在
init（只在交互终端里问；脚本和 CI 里看到的还是原来的 usage）。
init 跑完会打印一个具体的下一步——用 `open-memex add` 存一条记忆，再让
agent 回忆它——让第一次用的用户一眼看到"跑起来了"是什么样子。

**VS Code**（Copilot）：

```sh
open-memex init --client vscode
# ……没先装包的话：
npx -y open-memex init --client vscode
```

配项目级 `.vscode/mcp.json` 和用户级 Copilot instructions，然后重新加载窗口，
在 Copilot Chat 的 MCP 面板里确认 `open-memex` server 已启动。终端交互模式下
`init` 会问你要配到项目级还是用户级，而不是替你猜；`--global` 直接强制
用户级。

**Cursor：**

```sh
open-memex init --client cursor
```

和 VS Code 一个套路：默认写项目级 `.cursor/mcp.json`，`--global`
（或终端里 `init` 问你时选用户级）就写用户级，外加用户级 Copilot
instructions。

**一次配置、所有项目通用（VS Code / Cursor）：**

```sh
open-memex init --client vscode --global --yes
```

把 server 条目写到编辑器的*用户级* MCP 配置（Windows 下是
`%APPDATA%\Code\User\mcp.json`，macOS 是
`~/Library/Application Support/Code/User/mcp.json`，Linux 是
`~/.config/Code/User/mcp.json`；Cursor 是 `~/.cursor/mcp.json`），
而不是写到项目里——init 一次，每个项目打开自动启动 server。
如果某个项目自己定义了 `.vscode/mcp.json`，项目级的优先。
如果用户级文件里带注释（VS Code 接受 JSONC），`init` 不会碰这个文件，
只打印可直接手贴的配置片段。

**opencode**（原生插件——推荐）：

```sh
open-memex init --client opencode --global --yes
```

把 `"plugin": ["file:///absolute/path/to/open-memex/src/index.ts"]` 合并进用户级
`~/.config/opencode/opencode.json`（如果你用的是 `opencode.jsonc`，就合并进那个）
——一次配置，每个项目自动生效，不用逐个项目
init。在 tools 之外还能获得关键词自动捕获和首轮上下文注入。（带注释的配置文件
不会被改动——那种情况请手动加 `plugin` 这一行。）

**opencode**（作为普通 MCP 客户端）：

```sh
open-memex init --client opencode
```

写项目级 `opencode.jsonc`（`type: "local"`）。只有当你更想要纯 MCP 而不是原生
插件时才需要。

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

**拆掉接线：**

```sh
open-memex uninstall --yes
```

`init` 的逆操作——删掉 MCP server 条目、opencode 插件行和 Copilot
instructions 里的 open-memex 段。不带 `--client` 时把检测到的编辑器全清掉
（项目级和用户级都清）；`--global` 只清用户级。你的记忆数据永远不会被碰。

`init` 说明：

- Copilot 记忆 instructions 默认写到**用户级**
  （`~/.copilot/copilot-instructions.md`；Visual Studio 是
  `%USERPROFILE%\copilot-instructions.md`）——所有项目生效，永不 checkin
  到 repo，没装 open-memex 的同事看不到、也不会出错。团队人人都用
  open-memex 时可用 `--instructions project` 改写
  `.github/copilot-instructions.md`。
- 不带 `--client` 时，`init` 自动检测已安装的编辑器（VS Code 看 `PATH` 有没有
  `code` / 安装位置 / 已有的用户级配置；Cursor 看 `PATH` 有没有 `cursor` 或
  `~/.cursor`；opencode 看 `PATH` 有没有 `opencode` 或其配置目录；项目里有
  `.sln` 时算上 Visual Studio），一次全接上——支持用户级的走用户级，
  一次 init，所有项目通用。
- 在终端里会列出检测到的编辑器，请你确认是一次全配还是只配一个，
  再问是否开启关键词自动捕获、是否在首轮注入记忆。`--yes` 全用默认值；
  脚本 / 非 TTY 环境不提问，直接配所有检测到的编辑器。
- 已有配置文件会被**合并，不会被覆盖**——重复运行是安全的。
  `--force` 强制覆盖。
- `--global` 把 MCP server 条目写到编辑器的用户级配置（VS Code / Cursor）——
  一次配置，所有项目通用。opencode 的 `--global` 走用户级原生插件，
  不用逐个项目 init；Visual Studio 按设计保持 solution 级。
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

## 记忆类型（Memory types）

11 种类型——`type` 说明这条记忆是什么，`tags` 说明它和什么有关：

| 类型 | 记录什么 |
|---|---|
| `fact` | 关于项目或世界的稳定事实 |
| `preference` | 某人做事的偏好 |
| `decision` | 做过的选择——为什么、权衡了什么 |
| `constraint` | 不能违反的规则 |
| `todo` | 以后要做的承诺 |
| `knowledge` | 持久的领域或架构知识 |
| `howto` | 验证过的做法 |
| `gotcha` | 要避开的坑 |
| `lesson` | 事故或错误教会我们的东西 |
| `observation` | 注意到的现象，还不是结论 |
| `reference` | 指向权威文档的指针（不复制内容） |

## 团队记忆工作流

个人笔记永远私有。项目知识走一条显式、可 review 的流水线——没有任何东西会自动分享：

```
capture → outbox（本地草稿）→ submit → 仓库（.ai/open-memex/）→ PR review → published → recall
```

1. **Capture**——正常工作中把决策、坑、教训存成草稿。
2. **Review**——草稿在本地 outbox 里等着；`sync-status`（或在聊天里说"同步记忆"）查看待处理项。
3. **Submit**——你点名要分享的记忆才会进 `<repo>/.ai/open-memex/`，并做本地 commit。open-memex 永远不会自动 push。
4. **PR review**——记忆就是纯 Markdown；reviewer 走正常的分支/PR 流程批准、要求修改或拒绝（`promote`、`pr-status`、`resolve`）。
5. **Recall**——已发布的记忆在会话开始时自动注入，也可随时搜索，人和 agent 都能用。

Reviewer 守则：[docs/CURATOR.md](./docs/CURATOR.md)。

## 安全与数据

- **本地优先：** 所有东西都在你的机器上（`%APPDATA%\open-memex` / `~/.local/share/open-memex`），加上你选择的仓库。零云端调用、零账号、零第三方 API、零遥测。
- **密钥进不来：** `<private>…</private>` 包裹的内容会被剥离；检测到的 API key / token 在保存前就地打码。先用 `open-memex capture --dry-run "…"` 预览。
- **个人 scope 永不同步：** `personal` 只属于这台机器——export 默认排除，也永远进不了仓库。
- **分享可审计：** 团队记忆只能靠显式的 `submit` 移动，走分支/PR review，每次 `promote` 状态流转都会追加到记忆的 `review_history`（谁/何时/为什么）。
- **文件是你的：** Markdown 是 source of truth——随手看、随手改、随手删；SQLite 索引可以从文件重建。

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
open-memex init [--client vscode|cursor|opencode|visualstudio]
              [--instructions personal|project] [--global] [--force] [--yes]
open-memex uninstall [--client vscode|cursor|opencode|visualstudio] [--global] [--yes]
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

在接了 MCP 服务器的 AI 对话里，直接说 **"同步记忆"**（或 "sync memory"）——
agent 会查状态、把 outbox 草稿逐条摘要、问你同步哪几条。服务器也会主动告诉
agent：新对话开始时握手里带待审草稿数，每次改记忆的 tool 返回里也带当前数（为零时不带）。

```sh
open-memex sync-status
# 看索引上次同步的时间和触发方、outbox（待同步）、repo 里的评审状态
# （draft / proposed / approved / published / rejected），
# 以及 repo 里还没 commit 的记忆文件。

open-memex submit <id...> [--branch <name>] [--base <branch>]
# 把你点名的草稿移入 .ai/open-memex/，状态变为 proposed：
# 复制、改 review_state、在当前分支本地 git commit。
# 永不自动建分支——建分支是你说了算（或 Agent 拿到你明确批准走全链时）。
# 全有或全无；冲突（同 id 不同内容）干净回滚。
# 打印 push + gh pr 命令；Agent 拿到你的 Yes 后会自己走完 push/PR。
# --branch <name> 先建分支再提交（Agent 全链路径）。
# PR 默认 base 是当前分支；--base 可改到 main 或集成支。

open-memex pr-status [--apply]
# 读分支的 GitHub PR，把它的状态映射到每条 in-repo 记忆：
# PR merged → published，PR approved → approved（approved_by = reviewer），
# changes requested 只给建议。默认只报告；--apply 在本地执行映射的流转（不 push）。

open-memex pull
# 从 git 远端拉共享记忆：fetch + 只允许 fast-forward。
# 分支 diverged 时直接报错退出——open-memex 永不强行 merge；
# 手工解决（rebase 或 merge）后再 pull。成功后本地索引重新同步。
# pull 默认只显式触发；`open-memex config set sync.autoPull true`
# 可在 MCP session start 时尝试自动 pull（失败永不阻塞 session）。

open-memex push
# 把当前分支（含已 submit 的记忆）push 到 git 远端。
# 只显式触发——open-memex 永不自动 push。

open-memex export [--scope project|personal|both] [--type T] [--tag t] [--all] [-o <file>]
# 把记忆打包成可携带的 .tar.gz（markdown 原件 + manifest.json），
# 用于搬到另一台机器或导入别的工具。默认排除 visibility:private 的记忆；
# --all / -a 全量包含（完整迁移）。

open-memex import <bundle.tar.gz> [--dry-run]
# 恢复 export 的包：personal 记忆进 personal 目录；project 记忆按当前
# 项目重新编号 scope_key，进 outbox 当草稿。内容相同的 id 跳过；
# 内容冲突的 id 只报告，永不覆盖。

open-memex distill-agents [--scope project|personal] [--type t1,t2] [--limit N] [-o <file>]
# 把项目记忆（decision/constraint/lesson/gotcha/howto）提炼成
# AGENTS.md 片段。默认打印到 stdout；-o 写文件。人工审阅后手工合并——
# open-memex 永不自动改写你的 AGENTS.md。片段末尾带一段"记忆卫生"
# （§3.5 蒸馏指引），让读 AGENTS.md 的 agent 学会在任务结束时提议蒸馏捕获。

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

打理共享记忆的人遵循 curator 公约——`docs/CURATOR.md`：
批什么、退回什么，以及防止共享记忆腐烂的卫生规则。

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
> 靠的是 agent 的 instructions：服务器在 MCP 握手的 `instructions` 里自带
> session-start 指引（含开场时的 outbox 待审草稿数；改记忆的 tool 返回里也会
> 带当前数，为零时不带），`init` 则把更完整的版本写进编辑器的 instruction
> 文件。两者都是建议性的——MCP 客户端没有强制的 session-start hook。

## 路线图（Roadmap）

**`0.3.0`（稳定版）：** 通用 MCP server、`open-memex` bin/CLI、
一键 `init` 配置、中文关键词捕获（含 personal/project 路由）、
`config` / `capture --dry-run` / `doctor` 助手命令、Visual Studio 支持。

**`0.4.0`（稳定版）：** 团队同步——用 git 做共享记忆：appdata 草稿箱 →
`sync-status` → `submit`（本地分支+commit，push/PR 拿你的 Yes 才做）
→ `promote` / `resolve` 评审工作流、仓库内 `.ai/open-memex/` 目录；
`export` / `import` 归档做用户可携带（Markdown + manifest，不造围墙花园；
private 默认不导出，`-a` / `--all` 全量迁移）；
distill-to-AGENTS.md 辅助（`distill-agents`，只提议不改写——人工合并）；
§3.5 蒸馏写进 MCP 握手指令和 init 指令文件
（agent 在任务结束时提议 1–3 条捕获，人来定）；找 1–2 个同事做 pilot。

**`0.5.0`（稳定版）：** init 体验整修——`init --global` 一次写好用户级编辑器接线（D45）；裸 `init` 自动检测已装编辑器并一次全接上（D46）；非标准 JSON 配置不再报错，而是原样保留并打印手贴片段（D47）；`uninstall` 逆转 `init` 且永不碰记忆数据（D48）；空配置文件按空白处理、不再误判为损坏（D49）。"一份记忆，所有 Agent 通用"：同一台机器上的每个编辑器，经由同一个 MCP 接口读写同一份记忆。

**`0.5.1`（稳定版）：** `--help` 文案准确性修正——`mcp` 帮助写明 server 暴露 11 个工具（含 opencode 插件的 5 个 memory 工具），安装提示改指稳定版而非 `@alpha`（F27）。

**未来（看信号再定，不承诺版本）：** 组织层——组织记忆仓库、curator 约定；
原生 agent 插件（Claude Code / Codex hooks，作为同一套 MCP tools 的增强路径）；
本地 embedding 做基准测试门控的实验（**未经明确 opt-in 绝不下载
embedding 模型**）；云端 `RemoteProvider` 定制只在多仓库共享、
ACL 或合规需求出现时才做。

设计细节：[docs/V2-DESIGN.md](./docs/V2-DESIGN.md)（append-only 决策日志）。

## 常见问题（FAQ）

**装完之后，每个项目都要初始化 open-memex 吗（像其他 app 那样）？**
分两层。数据层不需要——没有 per-project 初始化的概念：数据目录按需自动创建，
project scope 从当前目录的 git remote 或路径自动推导，记忆天然按项目隔离，
零配置。编辑器接线只需要一步：直接跑 `open-memex init`（不带参数），它会自动
检测你装好的编辑器（VS Code、Cursor、opencode；项目里有 `.sln` 时还有 Visual
Studio）并一次全接上——支持用户级配置的编辑器就写用户级，一次 init 所有项目
通用。只想接某一个编辑器？用
`open-memex init --client <vscode|cursor|opencode|visualstudio>`。
想给 VS Code / Cursor 强制写用户级？加 `--global`。
Copilot 记忆指令默认写用户级（`~/.copilot/`），那个是全局的。

**opencode 需要跑 `init` 吗？**
两条路。推荐：`open-memex init --client opencode --global`——自动把原生插件
合并进 `~/.config/opencode/opencode.json`。一次配置，所有项目生效，还多拿
关键词自动捕获和首轮记忆注入。想手写？往那个文件里加
`"plugin": ["file:///absolute/path/to/open-memex/src/index.ts"]`
（填 open-memex 的实际安装路径）就行。当纯 MCP 用：
`open-memex init --client opencode` 写项目级 `opencode.jsonc`（无 hooks）。
如果你的用户级配置里带注释，`init` 不会碰它，只打印手动步骤。

**VS Code 呢——跑一次就行，还是每个项目都要跑？**
跑一次就行。直接 `open-memex init` 会自动检测到 VS Code，把 MCP server 写进
VS Code 的用户级 `mcp.json`（Windows：`%APPDATA%/Code/User/mcp.json`；
macOS：`~/Library/Application Support/Code/User/mcp.json`；
Linux：`~/.config/Code/User/mcp.json`），每个项目打开 server 都在。
项目里如果有 `.vscode/mcp.json` 仍然优先；entry 里保留了
`cwd=${workspaceFolder}`，project scope 按窗口照常工作。
如果你的用户级 `mcp.json` 带注释（VS Code 接受 JSONC），`init` 不会碰它，
只打印可直接手贴的配置片段。空文件会被当作空白直接写入。

**怎么拆掉编辑器接线？**
`open-memex uninstall` 就是 `init` 的逆操作：删掉 MCP server 条目、opencode
插件行和 Copilot instructions 里的 open-memex 段。不带 `--client` 时把检测
到的编辑器全清掉；`--global` 只清用户级。你的记忆数据永远不会被碰。

## 许可证

[Apache-2.0](./LICENSE)
