# open-memex

> 给你的 AI 编程助手装一个长期记忆——在本机上、用纯 Markdown 保存、你用的每个工具共享同一份。

[![npm version](https://img.shields.io/npm/v/open-memex.svg)](https://www.npmjs.com/package/open-memex)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

[English README](./README.md)

每次打开 AI 编程会话都是从零开始：你得重新解释项目背景，助手把同样的坑再踩一遍，昨天的决策在聊天结束时就消失了。open-memex 让你的助手拥有跨会话的记忆：说一次"记住：我们周五发布"，下周不管你用 Copilot、Cursor、opencode 还是 Claude Code，它都已经知道——因为它们读写的是同一台机器上的同一份本地记忆。

- **免费开源**（Apache-2.0）。无账号、无云端、无遥测——一切都在你本机，都是你能打开、能编辑的文件。
- **本地优先**：记忆是纯 Markdown 文件（事实来源），外加一个可重建的 SQLite 关键词索引。除非你明确要分享，否则任何东西都不会离开你的机器。
- **一份记忆，所有助手**：一条命令把几个编辑器都接上，它们共享同一份记忆，不再各存一份互不可见。

第一次接触？这份 README 带你在一分钟左右从安装走到"记忆生效"。跑通之后，[概念指南](./docs/CONCEPTS.zh-CN.md)会把心智模型讲透。

## 目录

- [快速开始](#快速开始)
- [核心概念](#核心概念)
- [编辑器与功能对照](#编辑器与功能对照)
- [安装](#安装)
- [为你的编辑器做设置](#为你的编辑器做设置)
- [init 到底改了你机器上的什么](#init-到底改了你机器上的什么)
- [捕获：记忆是怎么存下来的](#捕获记忆是怎么存下来的)
- [助手拿到的工具](#助手拿到的工具)
- [记忆类型](#记忆类型)
- [团队工作流：通过 Git 共享记忆](#团队工作流通过-git-共享记忆)
- [回想：记忆是怎么回来的](#回想记忆是怎么回来的)
- [安全与数据](#安全与数据)
- [局限性](#局限性)
- [升级](#升级)
- [存储布局](#存储布局)
- [配置](#配置)
- [CLI 参考](#cli-参考)
- [MCP 服务器](#mcp-服务器)
- [作用域详解](#作用域详解)
- [故障排查](#故障排查)
- [常见问题](#常见问题)
- [项目状态](#项目状态)

## 快速开始

需要 **Node.js ≥ 22.6**（用 `node -v` 检查）。然后：

```sh
npm install -g open-memex
open-memex init
```

`init` 会检测你已安装的编辑器（VS Code、Cursor、opencode，以及项目里有 solution 文件时的 Visual Studio），把每个编辑器都接到 open-memex 上。之后重启编辑器。

**亲眼看它生效**（30 秒）：

```sh
open-memex add "这个项目在周五发布"
```

然后在编辑器里开一个新聊天，问你的助手：*"这个项目什么时候发布？"*它已经知道了——不用你再解释一遍。这个"存一次、永久回想"的往返，就是这个产品的全部。下面都是细节。

可选但推荐——检查一切都接好了：

```sh
open-memex doctor
```

## 核心概念

三个概念能解释 open-memex 几乎所有的事。

**1. 两种作用域：`project` 和 `personal`。**
每条记忆属于两个地方之一：

- **project（项目）**——关于某个代码库的知识（决策、约束、教训）。按当前仓库自动归属，你永远不需要手动设置。
- **personal（个人）**——关于*你*的知识（偏好、习惯），在每个项目里都适用。它只存在于这台机器上，永远进不了任何仓库。

关于你的事实（"我喜欢简洁的 diff"）进 `personal`；其他默认进当前项目。

**2. 捕获 → 回想。**
记忆以小型 Markdown 文件保存，一条事实一个文件。每个新会话的第一轮，open-memex 自动把最相关的若干条交给你的助手，它一开场就已经知道。助手也能随时搜全量记忆。你永远不需要自己去"加载"任何东西。

**3. 你的文件，你做主。**
Markdown 文件是事实来源——打开、编辑、删除、用 grep 搜都行。旁边的 SQLite 索引只是搜索加速器，随时可以从文件重建（`open-memex reindex`）。团队共享（当你需要时）走的是和代码一样的评审流程：没有任何东西会被自动分享（见[团队工作流](#团队工作流通过-git-共享记忆)）。

## 编辑器与功能对照

open-memex 用两种方式接编辑器：原生的 **opencode 插件**，和标准的 **MCP 服务器**（任何支持 MCP 的编辑器都能用）。（MCP，即 Model Context Protocol，是编辑器给助手加工具的开放标准；open-memex 在你的编辑器里表现为一组 `memory_*` 工具。）你能得到什么，取决于编辑器走哪条路：

| 编辑器 | 设置方式 | 工具 | 会话开始时回想 | 关键词自动捕获 |
|---|---|---|---|---|
| opencode（原生插件，推荐） | `open-memex init --client opencode --global` | 5 个核心工具 | 内置——每个会话第一轮 | 有——`remember …`、`记住…` |
| VS Code（Copilot） | `open-memex init --client vscode` | 经 MCP 全 11 个 | 经 MCP 握手引导* | 无——你开口让助手保存 |
| Cursor | `open-memex init --client cursor` | 经 MCP 全 11 个 | 经 MCP 握手引导* | 无——你开口让助手保存 |
| Claude Code | `claude mcp add open-memex -- open-memex mcp` | 经 MCP 全 11 个 | 经 MCP 握手引导* | 无——你开口让助手保存 |
| Visual Studio 2022 17.14+ / 2026 | `open-memex init --client visualstudio` | 经 MCP 全 11 个 | 经 MCP 握手引导* | 无——你开口让助手保存 |
| Codex 与其他 MCP 客户端 | `open-memex mcp --print-config` | 经 MCP 全 11 个 | 经 MCP 握手引导* | 无——你开口让助手保存 |

\* MCP 没有硬性的会话开始钩子，所以 open-memex 在 MCP 握手中把引导发给助手（包括有多少草稿在等同步），`init` 还会把完整版写进编辑器的指令文件。实践中助手会遵循这些引导；只有 opencode 插件是真正的内置第一轮注入。[助手拿到的工具](#助手拿到的工具)一节列出了 5 个核心工具和另外 6 个工作流工具，"5 个 vs 11 个"的切分在那里写明白。

同一台机器上的所有编辑器读写的是**同一份**记忆——在 VS Code 里捕获的一条约束，在 opencode 里会被遵守；在 Cursor 里学到的教训，会出现在 Claude Code 面前。（不同机器之间不自动同步，见[常见问题](#常见问题)。）

`init` 还会给 VS Code 和 Cursor（以及 per-project MCP 模式下的 opencode）安装一个 **Agent Skill**（一份教懂 skill 的助手用 CLI 的短指令文件）。opencode 原生插件接好时，那里不装 skill——插件已经提供了记忆工具，再加一套指令只会让助手变话痨。

## 和别的方案比

| | open-memex | 指令文件（`CLAUDE.md`、`AGENTS.md` 等） | 云记忆服务 | 聊天记录 |
|---|---|---|---|---|
| 存在哪 | 你的机器 + 你的仓库 | 仓库里 | 服务商服务器 | 聊天结束就没了 |
| 谁维护 | 工作中顺手捕获、你评审 | 你手写并手动更新 | 服务商 | — |
| 跨 AI 工具 | 可以——任何 MCP 客户端（同机） | 每个工具有自己的约定文件 | 按集成逐个接 | 不行 |
| 分享前评审 | 有——outbox + Pull Request | 有——就是文件 | 看服务商 | 没有 |
| 人类可读 | 纯 Markdown 文件 | 可以 | 面板 / API | 不行 |

指令文件适合放少数常驻规则——继续用它（open-memex 甚至能从你的记忆里给它起草，见下文 `distill-agents`）。open-memex 管的是那堆不断增长的、没人记得要写下来的决策、教训和偏好。

## 安装

### 环境要求

- **Node.js ≥ 22.6**（`open-memex doctor` 会替你核查）

### 安装 CLI

```sh
npm install -g open-memex
```

这是稳定版。装包时可能会打印一行提醒让你运行 `open-memex init`——编辑器接线是单独的一步（下面第 2 步），没看到这行提醒也不用担心，直接运行 `init` 就行。

另有两种方式：

- **免安装，用 npx 直接跑**：`npx -y open-memex <command>` 免安装运行任意命令（如 `npx -y open-memex init --client vscode`）。启动慢一些，但无需安装卸载。
- **Alpha 版**（功能最新、毛边更多，给测试者）：`npm install -g open-memex@alpha`。用 `npm view open-memex version`（稳定版）和 `npm view open-memex@alpha version`（alpha 版）看当前发布了什么。

装完找不到 `open-memex` 命令，是 PATH 的问题——见[故障排查](#故障排查)。

### 从源码安装（给贡献者）

```sh
git clone -b main https://github.com/stoneskin/open-memex.git
cd open-memex
npm install
node --experimental-strip-types src/cli.ts <command>
```

## 为你的编辑器做设置

在**项目根目录**（你正在工作的仓库顶层文件夹）运行 `init`，让项目作用域正好落到这个仓库上：

```sh
open-memex init --yes
# ……或者不先装包，直接：
npx -y open-memex init --yes
```

`--yes` 表示接受 `init` 每个问题的推荐默认值（要接哪些编辑器、自动捕获、第一轮回想）。想逐题回答就去掉它。不带 `--client` 时，`init` 检测你已装的编辑器并全部接上——初始化一次，所有项目通用。只想接一个编辑器，就传 `--client`：

**VS Code**（Copilot）：

```sh
open-memex init --client vscode
```

写入 MCP 服务器配置并可干净重载；重载窗口，确认 Copilot Chat 的 MCP 面板里 `open-memex` 服务器已启动。默认把配置写到 VS Code 的*用户级*配置（每个项目都生效）；也可以写到项目级 `.vscode/mcp.json`。

**Cursor**：

```sh
open-memex init --client cursor
```

形态和 VS Code 一样：默认用户级 MCP 配置，可选项目级 `.cursor/mcp.json`，外加 Copilot 风格的指令文件。

**opencode**（原生插件——推荐）：

```sh
open-memex init --client opencode --global --yes
```

把原生插件并入你的用户级 `~/.config/opencode/opencode.json`（如果你已有的是 `opencode.jsonc`，就并进那个）——一次设置，每个项目都生效，不用逐项目 init。你会得到 5 个核心工具、关键词自动捕获和第一轮上下文注入。（配置文件里有注释时它不会动，`init` 会打印要手动加的那一行。）

**opencode**（作为普通 MCP 消费者）：

```sh
open-memex init --client opencode
```

写一个项目级 `opencode.jsonc`，里面放 MCP 服务器。只有当你偏好普通 MCP、不要原生插件时才需要——代价是没有关键词捕获和内置注入。

**Claude Code**（在项目根目录）：

```sh
claude mcp add open-memex -- open-memex mcp
# ……或者打印配置片段：open-memex mcp --print-config claude
```

**Visual Studio**（在 solution 目录）：

```sh
open-memex init --client visualstudio
```

写 solution 级 `.mcp.json`。需要 Visual Studio 2022 17.14+ 或 Visual Studio 2026（仅 Windows）。Visual Studio 也会自动发现 `.vscode/mcp.json` 和 `.cursor/mcp.json`，所以上面的 VS Code 设置同样有效。

**Codex**：暂时没有 `init` 客户端——用 `open-memex mcp --print-config` 的输出手动加服务器（`config.toml` 里的 `[mcp_servers]`，或 `codex mcp add`）。

### 一次设置、所有项目通用（VS Code / Cursor）

```sh
open-memex init --client vscode --global --yes
```

> **两个"全局"不是一回事，别搞混。**
> - `npm install -g open-memex` 是把*软件包*装到全局：让 `open-memex` 命令进 PATH。
> - `init --global` 是把*编辑器配置*写到用户级而不是项目级：一次初始化，所有项目都能用。包是全局装还是 npx 跑，它的效果都一样。

`--global` 形式把服务器配置写进编辑器的*用户级* MCP 配置（Windows 上是 `%APPDATA%\Code\User\mcp.json`，macOS 上是 `~/Library/Application Support/Code/User/mcp.json`，Linux 上是 `~/.config/Code/User/mcp.json`；Cursor 是 `~/.cursor/mcp.json`），而不是项目里——初始化一次，服务器在每个项目都会启动。项目自己定义了 `.vscode/mcp.json` 时，项目级的仍然优先。如果用户级文件里有注释（编辑器接受 JSONC），`init` 不会动它，会打印出需要手动粘贴的那段确切片段。

### `init` 的行为说明

- 已有配置文件是**合并、永不覆盖**——重复运行 `init` 是安全的。`--force` 会重写我们写入的条目。
- 当 PATH 上没有可持久使用的 `open-memex`（例如一次性 npx 运行时），`init` 会往配置里写一条 `npx -y open-memex mcp` 服务器命令，让设置之后照样能用。之后 `npm i -g open-memex` + `open-memex init --force` 可以切到更快的直连命令。
- 在交互终端上，`init` 会列出检测到的编辑器并请你确认；脚本和 CI 环境从不提问，会接上所有检测到的编辑器。
- 如果你在一台从未完成 init 的机器上只运行 `open-memex`（不带任何参数），它会问你要不要顺手跑 init（仅限交互终端）。

### 移除接线

```sh
open-memex uninstall --yes
```

撤销 `init`——移除 MCP 服务器条目、opencode 插件行、Agent Skill，以及编辑器指令文件里的 open-memex 段落。不带 `--client` 时会清理所有检测到的编辑器；`--global` 把清理范围限定在用户级接线。你的记忆数据永不触碰。

## init 到底改了你机器上的什么

`init` 写入的所有东西，一处列清：

- **记忆数据**（首次使用时创建，不是 `init` 本身写的）：Windows 上是 `%APPDATA%\open-memex\`，macOS/Linux 上是 `~/.local/share/open-memex/`——你的记忆文件和搜索索引。`uninstall` 永不修改这里的任何东西。
- **编辑器接线**（由 `open-memex uninstall` 移除）：
  - opencode：一条 `"plugin"` 条目，并入 `~/.config/opencode/opencode.json`（或 `.jsonc`）。改名之前遗留的 `my-o-memory` 旧条目会同时被清掉。
  - VS Code / Cursor：用户级或项目级 MCP 配置里的一条 `open-memex` 服务器条目，外加 Copilot 指令文件里的一段 open-memex 内容（默认是用户级 `~/.copilot/copilot-instructions.md`；`--instructions project` 改为写进仓库的 `.github/copilot-instructions.md`，适合团队全员都用 open-memex 的情况）。
  - Visual Studio：solution 旁边的 `.mcp.json`。
  - Agent Skill：VS Code（`~/.copilot/skills/`）、Cursor（`~/.cursor/skills/`）或 per-project MCP 模式下的 opencode（`~/.config/opencode/skills/`）各自一个 `skills/open-memex/` 文件夹。
- **你的仓库**：什么都不写。只有你明确运行 `submit` 时（见团队工作流），文件才会落进仓库——且只是本地提交，永不自动推送。

带注释（JSONC）或无法安全解析的文件永不被重写：`init` 会打印需要手动粘贴的那段确切片段。

## 捕获：记忆是怎么存下来的

三种存入方式：

- **关键词触发**（仅 opencode 原生插件）：说 `remember …`、`note that …`、`don't forget …`、`TIL …`、`save this …`——中文 `记住…` / `记一下` / `记录一下` / `别忘了…`——这句话就被存下来，不需要任何工具调用。捕获默认进当前 **project**；`remember for me …`、`记住我…`、`替我记…`、`我觉得…`、`我喜欢…` 这类"这是关于我"的信号会改为进 **personal**；`我们决定…`、`帮我们记住…` 等团队语境仍留在项目里。
- **助手主动保存**：在任何编辑器里，你让助手记住某件事（或者你陈述了一个值得记的事实、它自己判断该保存），它会调用 `memory_add`。上面的路由是启发式规则；你可以明说"存到我的个人记忆"，或用 CLI 加 `--scope` 明确指定。
- **CLI**：`open-memex add "…"`，可选 `--scope` / `--tags` / `--type`。

**脱敏。** 把敏感内容包在 `<private>…</private>` 里，它在保存前会被整段剥离。识别出的密钥（API key、token、高熵凭证）会被就地掩码——保留前 4 个字符（让你能认出是哪个 key），其余替换——记忆仍会保存。随时安全地预览一句话会被捕获成什么样：

```sh
open-memex capture --dry-run "…"
```

万一密钥还是溜进了记忆，`open-memex forget <id>` 把它删掉。

## 助手拿到的工具

MCP 服务器暴露十一个工具；opencode 原生插件暴露其中五个核心的（标 ●）。另外六个是团队评审工作流工具——只有当你通过 Git 共享记忆时才用得上。

| 工具 | 做什么 |
|---|---|
| ● `memory_add`       | 保存一条事实、偏好、决策、笔记 |
| ● `memory_search`    | 关键词搜索（BM25），横跨项目 + 个人记忆 |
| ● `memory_list`      | 列出某个作用域的记忆，最新在前 |
| ● `memory_supersede` | 用新版本替换一条记忆（保留 supersede 链） |
| ● `memory_forget`    | 按 id 删除一条记忆 |
| `memory_status`      | 显示同步队列：outbox 草稿、仓库评审状态、未提交文件 |
| `memory_submit`      | 把指定的草稿移进仓库记忆目录（本地分支 + 提交） |
| `memory_propose`     | 把个人记忆复制到项目作用域，作为评审候选 |
| `memory_promote`     | 推进 `proposed → approved → published`（或拒绝 / 重新提交） |
| `memory_resolve`     | 列出冲突的记忆文件 / 对某个做三方合并 |
| `memory_pr_status`   | 把分支 PR 的 GitHub 状态映射到每条记忆的评审状态 |

所以 MCP 接入的编辑器永远是全套；opencode 插件主攻捕获与回想，工作流类的事走 CLI 或 MCP 接入的编辑器。

## 记忆类型

每条记忆有一个 `type`（它是什么）和 `tags`（它关于什么）。内置十一种类型：

| 类型 | 捕获什么 |
|---|---|
| `fact` | 关于项目或世界的稳定事实 |
| `preference` | 某人喜欢怎么做事 |
| `decision` | 一个已做的选择——为什么选、代价是什么 |
| `constraint` | 不可违反的规则 |
| `todo` | 承诺以后要做的事 |
| `knowledge` | 耐久的领域或架构知识 |
| `howto` | 一个验证可行的步骤 |
| `gotcha` | 要避开的坑 |
| `lesson` | 一次事故或错误教会我们的东西 |
| `observation` | 注意到的现象，还不是结论 |
| `reference` | 指向权威文档的指针（不复制内容） |

`--type` 接受任意字符串，但坚持用内置这十一种，会让会话开始时的标签、搜索和 `distill-agents` 的输出保持可预期。

## 团队工作流：通过 Git 共享记忆

**一个人用？你可以跳过这一节**——上面就是单人使用的全部产品。下面的事永远不会自动发生。

个人笔记保持私密。项目知识当你选择分享时，走一条显式、可评审的流水线，形状和代码评审一样：

```
捕获 → outbox（草稿，本地）→ submit → 仓库（.ai/open-memex/）→ PR 评审 → 已发布 → 回想
```

1. **捕获**——日常工作中随手存下决策、坑、教训，都是草稿。
2. **评审**——草稿停在本地 outbox 里（你机器上，git 看不见）；`open-memex sync-status`——或者直接在聊天里说"sync memory"（"同步记忆"）——看有啥待处理的。
3. **提交**——由你点名记忆；它们进入 `<仓库>/.ai/open-memex/` 并在当前分支形成一个本地提交。open-memex 永不自动推送；它会打印推送和建 PR 的命令，拿到你明确许可的助手可以替你执行。
4. **PR 评审**——记忆是纯 Markdown；评审者走正常分支/PR 流程批准、要求修改或拒绝。
5. **回想**——已发布的记忆在会话开始时注入，平时也能随时搜，人和助手都一样。

看护共享记忆的人遵循 [维护者约定](./docs/CURATOR.md)：什么该批准、什么该打回、哪些卫生规则让共享记忆不腐烂。

## 回想：记忆是怎么回来的

每个会话的第一轮，open-memex 把一个 `[OPEN-MEMEX]` 块注入助手的上下文：最新的项目记忆（默认前 8 条）和你的个人偏好（默认前 5 条）。长这样：

```text
[OPEN-MEMEX]

User profile / preferences:
- I prefer concise diffs

Project knowledge (my-repo):
- [decision] We deploy on Fridays; the release train leaves at 10:00

Use the `memory_search` tool to look up more. Use `memory_add` to save new facts.
Do not mention this block to the user unless asked.
```

这是一个快照，不是全量记忆——其余的随时用 `memory_search` 就能查。两个前 N 的数都可以配（见[配置](#配置)）。对 MCP 客户端，这个块以握手引导的形式送达、由助手遵循；opencode 插件则在第一轮直接注入。

## 安全与数据

- **本地优先：** 一切住在你机器上（Windows 是 `%APPDATA%\open-memex`，macOS/Linux 是 `~/.local/share/open-memex`），外加你自己选择的仓库。零云调用、零账号、零第三方 API、零遥测。
- **密钥不进记忆：** `<private>…</private>` 包住的内容会被剥离；识别出的 API key/token 在保存前就地掩码。用 `open-memex capture --dry-run "…"` 预览。
- **个人永不同步：** `personal` 作用域只存在于这台机器——导出时默认排除，永远进不了仓库。
- **分享可审计：** 团队记忆只能靠显式 `submit` 移动，走分支/PR 评审，每次 `promote` 状态迁移都记进该记忆的 `review_history`（谁 / 何时 / 为什么）。
- **文件是你的：** Markdown 是事实来源——手工查看、编辑、删除都行；SQLite 索引从文件重建。

## 局限性

把边界写明白，免得你事后意外：

- **关键词搜索，不是语义搜索。** 回想走 BM25 关键词匹配：搜的是你存下的词，不是近义改写。（用自然问句没问题——"如何/请问"这类提问词会在匹配前过滤掉，不会稀释结果。）任何 embedding 模型没经你明确同意，永不下载。
- **单台机器。** 同一台机器上的编辑器共享记忆；没有跨机器同步。用 `export` / `import` 压缩包（见下）手动搬家。
- **快照，不是全部。** 会话开始的回想是前 N 条快照（默认项目 8 + 个人 5）；更老的记忆 `memory_search` 一步就能到，但不会同时全在上下文里。
- **MCP 的引导是建议性的。** opencode 之外，主动捕获和回想靠助手遵循握手指令——MCP 里没有硬性的会话开始钩子。工具本身在被调用时永远可靠。
- **捕获路由是启发式的。** 带"个人"信号的短语（`remember for me …`、`我喜欢…`）进个人作用域；其余默认进当前项目。猜错时，把作用域说出声，或者 CLI 加 `--scope`。

## 升级

```sh
npm install -g open-memex@latest   # 或 @alpha
```

编辑器配置指向已安装的 `open-memex` 命令，所以升级不需要重新接线。大版本升级后跑一次 `open-memex init --force`，把已装的 Agent Skill 和指令文件刷新到最新文案。如果你是从源码安装或挪过包的位置，`--force` 也会把 opencode 插件路径重新指好。

每个版本具体变了什么：见 [CHANGELOG](CHANGELOG.md)（英文）。

## 存储布局

```
%APPDATA%\open-memex\               (Windows)
~/.local/share/open-memex/          (macOS/Linux; 设置了 $XDG_DATA_HOME 则用它)
├── index.db                         # SQLite FTS5 索引（可重建）
└── memories/
    ├── personal/
    │   └── <id>.md
    └── project__<name>__<hash12>/
        └── <id>.md
```

每个 `.md` 文件是一条记忆：YAML frontmatter（`id, scope, type, tags, created_at, schema_version` 等）后跟正文。你可以手工编辑——索引会从文件重新同步，Markdown 永远是事实来源（`open-memex reindex` 从零重建索引）。

一旦你 `submit`，项目记忆还会以 Markdown 文件的形式住进 `<仓库>/.ai/open-memex/`（由 `memoryDir` 配置），跟着分支和 PR 像其他文件一样流转。

## 配置

设置放在 `~/.config/opencode/open-memex.jsonc`——路径里的 `opencode` 是历史名；这一个文件由所有客户端共享。用 `MY_O_MEMORY_CONFIG` 覆盖配置路径，用 `MY_O_MEMORY_HOME` 覆盖存储根目录（改名之前留下的旧环境变量名，仍然有效）。

默认值：

```jsonc
{
  "maxProjectMemories": 8,    // 第一轮注入的项目记忆条数上限
  "maxProfileItems": 5,       // 第一轮注入的个人条数上限
  "injectOnFirstTurn": true,  // [OPEN-MEMEX] 系统提示块
  "keywordCaptureEnabled": true,
  "logLevel": "info",          // info | debug
  "memoryDir": ".ai/open-memex" // 仓库内项目记忆目录，相对于仓库根
}
```

`open-memex config` 打印生效配置（默认值 + 文件）。安装后改设置：

```sh
open-memex config set keywordCaptureEnabled false
open-memex config set maxProjectMemories 12
open-memex config set sync.autoPull true   # MCP 会话开始时尽力而为地 pull
```

可设置的键：`maxProjectMemories`、`maxProfileItems`、`injectOnFirstTurn`、`keywordCaptureEnabled`、`logLevel`、`memoryDir`，以及 `sync.autoPull`（带点的键，写入嵌套的 `sync` 对象）。完整设计：[docs/V2-DESIGN.md](./docs/V2-DESIGN.md)。

## CLI 参考

设置与健康：

```sh
open-memex init [--client vscode|cursor|opencode|visualstudio]
              [--instructions personal|project] [--global] [--force] [--yes]
open-memex uninstall [--client vscode|cursor|opencode|visualstudio] [--global] [--yes]
open-memex config                                  # 打印生效配置
open-memex config set <key> <value>                # 改一个设置
open-memex doctor                                  # 环境健康检查
open-memex audit                                   # 记忆健康检查（近重复、陈旧、断链）
open-memex capture --dry-run "记住我喜欢简洁的回答"  # 预览关键词捕获
open-memex mcp --print-config vscode|cursor|claude|opencode|visualstudio
open-memex --help      # 这份参考
open-memex <command> --help  # 某个命令的帮助
open-memex --version   # 已安装版本
```

记忆操作：

```sh
open-memex add "This repo uses better-sqlite3" --type fact
open-memex search "auth flow"
open-memex search "auth flow" --explain   # 显示 FTS 表达式、分数、被生命周期藏掉的计数
open-memex list --scope project
open-memex supersede <id> "Updated content"
open-memex status <id> deprecated
open-memex forget <id>
```

团队评审工作流（两个家，一个阶段一个）：

项目草稿住在 **appdata outbox** 里（git 看不见、与分支无关）；只有你批准的草稿才进 `<仓库>/.ai/open-memex/`，在那里跟随分支和 PR。你不点名，什么都不动。在接了 MCP 服务器的 AI 聊天里，直接说 **"sync memory"**（或"同步记忆"）——助手会跑状态检查、把 outbox 草稿摘要给你、问你要同步哪些。服务器也会主动告知助手：会话开始的握手里报当前等待的草稿数，每个改记忆的工具结果在非零时也带这个数。

```sh
open-memex sync-status
# 显示索引上次同步的时间（和触发源）、outbox
# （待同步）、仓库评审状态
# （draft / proposed / approved / published / rejected）、
# 以及任何未提交的仓库记忆文件。

open-memex submit <id...> [--branch <name>] [--base <branch>]
# 把你点名的草稿移进 .ai/open-memex/，标为 "proposed"：
# 复制、翻转 review_state、在当前分支本地 git 提交。
# 永不自己建分支——建分支是你（或拿到完整链路明确许可的助手）的事。
# 全有全無；冲突（同 id 不同内容）干净地中止。
# 打印 push + gh pr 命令；持有你 Yes 的助手可以一并执行 push/PR。
# --branch <name> 先建分支（助手全链路路径）。PR base 默认是当前分支
# （记忆 PR 叠在你的工作分支上）；--base 可改指到 main 或你的评审分支。

open-memex pr-status [--apply]
# 读分支的 GitHub PR，把状态映射到每条仓库内记忆：
# PR 合并 → published，PR 批准 → approved（approved_by = 评审者），
# 要求修改 → 只给建议。默认只报告；--apply 在本地执行映射的迁移（不推送）。

open-memex pull
# 从 git 远程拉共享记忆：fetch + 純 fast-forward。
# 分支分叉则明确报错失败——open-memex 永不强制合并；手工解决后再 pull。
# 成功后本地索引重新同步。pull 默认显式触发；设置
# `open-memex config set sync.autoPull true` 可在 MCP 会话开始时尽力拉一次
# （拉失败永不阻塞会话）。

open-memex push
# 把当前分支（连同已提交的记忆）推送到 git 远程。
# 只能显式触发——open-memex 永不自作主张推送。

open-memex export [--scope project|personal|both] [--type T] [--tag t] [--all] [-o <file>]
# 把记忆打包成可移植的 .tar.gz（markdown + manifest.json），用于
# 搬到另一台机器或另一个应用。默认排除 visibility:private 的记忆；
# --all / -a 包含全部（完整迁移）。

open-memex import <bundle.tar.gz> [--dry-run]
# 恢复一个包：个人记忆进个人目录；项目记忆
# 重新键到当前项目、作为草稿落进 outbox。
# 同 id 的跳过；冲突的 id 只报告、永不覆写。

open-memex distill-agents [--scope project|personal] [--type t1,t2] [--limit N] [-o <file>]
# 从项目记忆中提炼出一段 AGENTS.md 片段
# （决策、约束、教训、坑、howto）。打印 markdown；
# -o 写进文件。你评审后手工并入——open-memex
# 永不自己改写你的 AGENTS.md。片段末尾带一节
# “记忆卫生”内容，让读 AGENTS.md 的助手在任务结束时学会主动提出提炼捕获。

open-memex propose <id...> --to project [--local-approve]
# 一次提议一条或多条个人记忆（一个分支、一个 PR）；
# 每条复制并生成新 id。全有全無：任何一条 id 出错，整批中止，绝不半途。
# 把一条个人记忆复制到项目作用域作为评审候选
# （是复制不是移动——个人原件保留）。结果落进 outbox；
# 准备进仓库时再跑 sync-status / submit。
open-memex promote <id> [--reject] [--resubmit] [--note "..."] [--by NAME]
# 向前推进一步：proposed → approved → published（或带说明拒绝）。
# 每次迁移都记进该记忆的 review_history（谁/何时/为什么）。
# 被拒绝不会删除文件——由你决定：接受（关掉 PR、删分支）、改完 --resubmit 再来一轮，或留着做 [rejected] 记录。
open-memex resolve [id-or-path]
# 列出冲突的记忆文件，或对某一个做字段级三方合并。
# 语义冲突只报告、永不自动解决。
```

看护共享记忆的人遵循维护者约定——`docs/CURATOR.md`：什么该批准、什么该打回、哪些卫生规则让共享记忆不腐烂。

维护：

```sh
open-memex where        # 显示存储与配置路径
open-memex scopes       # 列出各项目作用域及记忆计数
open-memex reindex      # 从 markdown 重建 SQLite 索引
open-memex audit        # 记忆健康检查：近重复对、陈旧记忆、断裂的取代链
open-memex migrate --to-v2 [--dry-run]   # v1 数据 → v2（把 user 作用域改名为 personal）
```

CLI 在 Node 22 下运行。从源码 checkout 跑时用内置的实验性 TypeScript 加载器（免构建步骤）；发布到 npm 的包是预编译好的 JS（发版时 `npm run build`）。从源码 checkout 时，每条命令前面加 `node --experimental-strip-types src/cli.ts`（简单情况可用 `npm run cli -- <command>`——npm 会吞掉不认识的 `--flag` 参数，所以优先用直连 `node`）。

## MCP 服务器

同一组记忆工具，走 Model Context Protocol、经 stdio 服务器提供——不需要任何宿主专用插件。任何 MCP 客户端都能用 open-memex。

```sh
open-memex mcp               # 全局安装后
npx -y open-memex mcp        # 无需安装
```

项目作用域由进程当前工作目录解析，所以配置服务器时把 cwd 设到项目根（`init` 会替你处理）。

> **注意：** MCP 是请求/响应模型——它给助手的是工具，不是 opencode 插件那种自动关键词捕获或第一轮注入。主动用记忆靠助手的指令：服务器在 MCP 握手 `instructions` 里发会话开始引导（包括会话开始时的 outbox 草稿实时数、以及每个改记忆的工具结果非零时附带的待处理数），`init` 把完整版写进编辑器的指令文件。两者都是建议性的——没有任何 MCP 消费者提供硬性的会话开始钩子。

## 作用域详解

- **project（项目）**——限定在当前仓库，键由 git origin URL 的 hash 派生（所以同一仓库的多个 clone 共享一个作用域），没有远程时退回到当前工作目录路径。新记忆的默认作用域。
- **personal（个人）**——横跨你的所有项目，仅限本机，永不向外同步。放个人偏好用。（v1 里叫 `user`；`migrate --to-v2` 会改名。）

完整的 scope 模型（键派生、迁移、可见性、保留名）见 [docs/SCOPES.md](./docs/SCOPES.md)。[概念指南](./docs/CONCEPTS.zh-CN.md)把心智模型完整走了一遍。

## 故障排查

**`open-memex` 无法识别 / 命令找不到。**
全局 `npm install -g` 把 `open-memex` 启动器放在 npm 的全局 bin 文件夹里。终端找不到命令，就是这个文件夹不在 PATH 上：

1. 找到这个文件夹：`npm config get prefix`
   - **Windows：** 启动器（`open-memex.cmd`）直接在这个文件夹里，如 `C:\Users\<你>\AppData\Roaming\npm`
   - **macOS / Linux：** 在 `<prefix>/bin`，如 `/usr/local/bin` 或 `~/.nvm/versions/node/v22.x.x/bin`
2. 把它加进 PATH：
   - **Windows：** 设置 → 系统 → 关于 → 高级系统设置 → 环境变量 → 把文件夹加到*用户*的 `Path` → **重启终端**。用 `where open-memex` 验证。
   - **macOS / Linux：** 往 `~/.zshrc`（或 `~/.bashrc`）加 `export PATH="$(npm prefix -g)/bin:$PATH"`，重启 shell，用 `command -v open-memex` 验证。
3. 没有管理员权限 / 不想动 PATH？用 npx 形式——`npx -y open-memex <command>` 自己解析包，不需要改 PATH。

**`EBUSY` / `EPERM` 报错落在 `better_sqlite3.node` 上（Windows）。**
Windows 上已加载的 DLL 是锁定的：如果 open-memex 的 MCP 服务器正在运行（VS Code 的 MCP 面板、Cursor 等），`npm install -g open-memex` 换不掉 `better_sqlite3.node`，会以 `EBUSY` / `EPERM` 失败。先停掉 MCP 服务器（或退出编辑器），再重装。若仍失败，删掉全局 npm 根目录下的 `node_modules/open-memex` 和任何 `node_modules/.open-memex-*` 临时文件夹，再装一次。

**`init` 说某个配置文件它没动。**
你的编辑器配置里有注释（JSONC）或 JSON 不合法，open-memex 永不重写它无法安全解析的文件。`init` 已经把要加的确切片段打印出来了——手动粘贴进去就好。opencode 配置同理：有注释时，手动把 `"plugin"` 那一行加上。

**感觉有问题——跑 `open-memex doctor`。**
它检查 Node 版本、配置来源、当前目录的作用域解析、存储可写性，并确认 VS Code 没有把 MCP 禁用；然后启动一个真实 MCP 服务器，对它跑 `initialize` + `tools/list`——十一个工具必须全部出现。它还会报告改名之前遗留的 `my-o-memory` 引用（如果某编辑器配置里还留着旧包名的话）。

## 常见问题

**需要用 git 吗？**
不需要。捕获和回想在任何文件夹里都能用——没有 git 仓库时，项目作用域就按文件夹路径键。只有团队工作流（`submit` / PR 评审）需要 git，而且它是可选的。

**我用好几个编辑器，它们真共享一份记忆吗？**
真的——在同一台机器上。每个接好的编辑器读写的是同一份本地记忆；每个编辑器具体能得到什么，见[编辑器与功能对照](#编辑器与功能对照)。在 VS Code 里存的决策，到 opencode 里会被遵守。

**我在公司和家里两台电脑工作，记忆能同步吗？**
不能自动同步——记忆按设计是逐机器存的，你的个人作用域永远不离开它被创建的那台机器。手动搬家：在一个机器跑 `open-memex export`，在另一台跑 `open-memex import`。通过 Git 共享的项目记忆（团队工作流）会随仓库走，所以在第二台克隆仓库就把*已发布的项目*记忆带过去了——个人的会故意留在原地。

**真的是免费的吗？需要账号吗？**
免费开源（Apache-2.0）。无账号、无注册、无遥测、无云调用。它永远不"打电话回家"，因为压根没有家可打：open-memex 唯一会碰的网络，是你明确推送时你自己的 git 远程。

**我不小心把一个密钥粘进了记忆，怎么办？**
`open-memex search "<其中一段>"` 找到那条记忆，再 `open-memex forget <id>` 删掉。下次要避免：把敏感文本包在 `<private>…</private>` 里（保存前被剥离）——识别出的 API key 和 token 还会自动掩码。任何一句话都能先安全预览：`open-memex capture --dry-run "…"`。

**每个项目都要跑一遍 `init` 吗？**
不用。数据层什么都不需要——项目作用域由当前目录的 git 远程或路径自动派生，记忆天然按项目隔离、零设置。编辑器接线是每台机器一次 `open-memex init`（编辑器支持时就是用户级）。升级后（`--force`）或换编辑器时再跑。

**opencode 需要 `init` 吗？**
两条路。推荐：`open-memex init --client opencode --global`——它把原生 open-memex 插件并入 `~/.config/opencode/opencode.json`。一次设置、所有项目生效，还多出关键词自动捕获和第一轮记忆注入。想全手动？把 `"plugin": ["file:///absolute/path/to/open-memex/src/index.ts"]`（已安装包的路径）加进那个文件也行。走普通 MCP 的话：`open-memex init --client opencode` 写一个项目级 `opencode.jsonc`（没有钩子）。你的 用户级配置带注释时，`init` 不会动它，会打印手动步骤。

**VS Code——`init` 跑一次还是每个项目跑？**
跑一次就够。直接 `open-memex init` 会自动检测 VS Code 并把 MCP 服务器条目写进 VS Code 的用户级 `mcp.json`（Windows 在 `%APPDATA%/Code/User/mcp.json`，macOS 在 `~/Library/Application Support/Code/User/mcp.json`，Linux 在 `~/.config/Code/User/mcp.json`），服务器在每个项目都会启动。项目里有项目级 `.vscode/mcp.json` 时仍以它优先，而该条目保留 `cwd=${workspaceFolder}`，所以项目作用域按窗口各自解析。如果你的 用户级 `mcp.json` 里有注释（VS Code 接受 JSONC），`init` 不动它，会打印确切片段让你手动添加。空文件会被当作空白，直接写入。

**怎么移除编辑器接线？**
`open-memex uninstall` 撤销 `init`：移除 MCP 服务器条目、opencode 插件行、Agent Skill 目录，以及 Copilot 指令里的 open-memex 段落。不带 `--client` 时清理所有检测到的编辑器；`--global` 把清理限制在用户级接线。你的记忆永不被动。

## 项目状态

open-memex 是稳定且日常在用的；当前稳定线以 `latest` 发到 npm 上，`alpha` 构建给测试者。发版历史在 [GitHub Releases](https://github.com/stoneskin/open-memex/releases)；设计决策记录在只追加的日志 [docs/V2-DESIGN.md](./docs/V2-DESIGN.md) 里。

在望的方向（不承诺版本号）：更多编辑器的原生助手插件（作为在同一组 MCP 工具之上的增强路径）；本地 embedding 作为可选择开启的实验（没经询问，永不下载任何模型）；只有在真实多仓库共享、ACL 或合规需求出现时才做 org 层。

## 许可证

[Apache-2.0](./LICENSE)
