# OpenMemex 用户守则

> 本文档讲的是 open-memex 的**心智模型**：你的记忆住在哪里、怎么流动、谁能看到。
> in-repo 目录（§2、§6 的写路径）和 propose → promote → resolve 工作流（§5）
> 已在 `V2-dev-p2b` 分支实现；标有 **2B** 的功能属于 Phase 2B 待实现部分，
> 其余为 0.3.0 已有行为。

## 一句话

open-memex 是本地优先的记忆层：**Markdown 是真相，SQLite 只是可重建的索引**。索引丢了可以重建，
Markdown 丢了才是真的丢了。

## 1. 两种 Scope：personal 与 project

每条记忆都属于一个 scope，决定它**能走多远**：

| | personal | project |
|---|---|---|
| 存什么 | 关于你的事实：偏好、习惯、跨项目的信息 | 关于项目的事：技术栈、约定、决策、踩过的坑 |
| 存哪里 | 只在你本机（见 §2） | 本机 + 可进团队共享（见 §2、§6） |
| 一句话 | **永不离开这台机器** | 可以晋升为团队知识 |

关键词会自动路由（D18）：「记住…/我觉得…/我喜欢…」（我）→ personal；
「我们认为…/我们决定…/帮我们记住…」（我们）→ project。

## 2. 两个家：appdata 与 repo 目录

| | appdata（书桌） | repo `.ai/open-memex/`（书架） |
|---|---|---|
| 位置 | Windows `%APPDATA%/open-memex`，Linux `~/.local/share/open-memex` | 项目根目录下，默认 `.ai/open-memex/`（D23，可配置 `memoryDir`） |
| 放什么 | `memories/personal/` 个人记忆；project scope **草稿箱（outbox）**；`index.db` 本地索引 | 已提交的 project 记忆（`proposed` 及以上） |
| 进 git 吗 | 不进 | 进，git 就是它的搬运工 |
| 索引呢 | `index.db` 可重建，**永远不入库** | 不存索引，用时从 Markdown 重建 |

个人笔记本（personal）永远不上书架。这是铁律，不是配置项。

project 记忆先以**草稿**身份住在 appdata outbox——git 看不见、跟分支无关。
只有你亲手点名的草稿，才会被 `open-memex submit` 移上书架（§5）。
一个阶段只住一个地方：submit 成功后 outbox 原件消失；submit 之前，
repo 里什么都不知道。

## 3. 首轮注入：8 条和 5 条是怎么选出来的

Agent 第一轮发言前，open-memex 会塞一个 `[OPEN-MEMEX]` 上下文块进去，省得每次先调一次搜索。
默认注入 **project 8 条、personal 5 条**（`maxProjectMemories` / `maxProfileItems`，可调）。

入选标准只有一个：**最近更新优先**（`ORDER BY updated_at DESC`），并过滤掉已撤回/归档、
解析掉被替代的旧版本。不是"最重要的 N 条"，而是"最近在折腾的 N 条"——
你刚更新过的东西，最可能跟当前工作相关。

Token 账：每条压成一行（≤240 字符，约 60 token），8 条 ≈ 500 token 上限。
超过这个数收益递减——长尾靠 `memory_search` 按需查，全塞进首轮反而淹没信号。

调大：`open-memex config set maxProjectMemories 12`

## 4. 后续轮次：什么时候会再搜记忆

首轮注入只发生一次。之后**没有自动重搜机制**——MCP 是 request/response 模式，
server 不能主动推送，调不调 `memory_search` 全看 model 的判断。引导它的有两处：

- 注入块页脚："Use the `memory_search` tool to look up more."
- Copilot instructions（`init` 写入的）："问用户以前说过的事之前，先 `memory_search`；
  先试几个关键词变体，搜不到再问。"

也就是说：当对话触及历史决策、偏好、约定时，model **应该**先搜，但没有任何机制强制。
这是当前版本的已知缺口——Phase 2C 的原生插件 hooks（如 Claude Code 的
`UserPromptSubmit`）就是来补这块的。

## 5. 晋升工作流：记忆如何变成团队知识

个人观察变成团队知识只有一条路——**显式晋升，绝不自动同步**：

```
个人想法 ──propose──▶ 草稿箱 ──submit──▶ proposed ──┬──promote──▶ approved ──promote──▶ 已发布/共享
                                                    │                         │
                                                 --reject                  --reject
                                                    │                         │  （合并前可撤回批准）
                                                    ▼                         ▼
                                                 rejected ──resubmit──▶ proposed
```

- `open-memex propose <id...> --to project`：把一条或多条 personal 记忆**复制**到
  **appdata 草稿箱**进入评审（`review_state: draft`，每条独立新 id，
  `derived_from` 指回 personal 原件）。**复制而非移动——personal 原件保留。**
  全有或全无：id 有错整批回滚。这一步还不碰 repo——草稿箱 git 看不见、跟分支无关。
  单人开发可用 `--local-approve` 自批。
- `open-memex sync-status`：看草稿箱（待同步）、repo 里的评审状态
  （`draft / proposed / approved / published / rejected`），以及 repo 里还没
  commit 的记忆文件。你的 agent 会在会话开始和关键节点跑这个，然后问你
  哪些草稿（如果有）要同步。
- `open-memex submit <id...>`：把**你点名的草稿**移入 `<repo>/.ai/open-memex/`，
  状态变为 `proposed`。它会建 `mem/sync-<timestamp>` 分支（或用 `--onto`
  留在当前分支，跟代码走同一个 PR），复制文件、改 `review_state`、做一次
  **本地** git commit——全有或全无、幂等、crash-safe。它打印 `git push` +
  `gh pr create` 命令；如果你的 agent 已经拿到你这次的 Yes，它会自己走完
  push 和 PR。PR 默认 base 是当前分支；`--base` 可改到 `main` 或集成支。
  分支上同 id 但内容不同——**直接中止**，等人裁决，绝不覆盖。
  - 四个动作分工要分清：**propose 是跨界**（personal → project 草稿箱，
    唯一跨越"私有/共享"边界的动作）；**submit 把草稿搬进 repo**
    （outbox → `.ai/open-memex/`，`draft → proposed`）；**promote 只改状态标签**
    （文件一直在 `.ai/open-memex/` 里没动过，只是 `review_state`
    从 proposed → approved → published）——它不在目录之间搬文件；
    **git 负责运输**（push、PR、合并）。
- 独立的记忆 PR **只含记忆文件，不含代码**，跟代码 PR 分开评审、分开审计。
  审的是"这条是真的吗？能给全团队看吗？有没有 secret？"——代码 PR 的 CI 不会查这些。
  也可以搭代码 PR 的车（`submit --onto <branch>`）。
- "要求修改"不需要命令：PR 开着的时候，作者直接改同一个文件（自己改，
  或在 chat 里让 agent 改），commit、push。状态一直是 `proposed`，
  PR 本身就是评审机制。
- `open-memex promote <id>`：把记忆往阶梯上推一步
  （`proposed → approved → published`）。`--reject --note "..."` 驳回并附注原因
  （合并前也可从 `approved` 驳回，即撤回批准）。PR 合并后，再跑一次
  `promote <id>` 标记为 `published`。（project 记忆提升到 org 级是 Phase 4 的事。）
- **驳回不删任何东西。**文件留在你的分支上，之后怎么处理由人决定：
  1. **接受**：关 PR、删分支——文件跟着走（本地索引下次 sync 自己清掉）；
  2. **改完重提**：改文件，跑 `open-memex promote <id> --resubmit`，
     commit、push——同一个 PR 里继续评审；
  3. **留作记录**：不动它；它带着 `[rejected]` 标签和你的注记一直可见，
     团队以后能看到"这个考虑过，为啥没要"。
- `open-memex resolve [id]`：不带参数列出冲突中的记忆文件；带 id 则尝试
  **字段级 3-way 合并** YAML frontmatter（`tags` 取并集、`updated_at` 取最新、
  只有一边改了 body 才合）。语义冲突——两边改了同一字段或 body 各改各的——
  **只报告、不自动解决**：文件原样不动，等人来裁决。
- `list` / `search` 会在评审中的记忆旁显示 `[proposed]` / `[approved]` /
  `[published]` / `[rejected]` 标签。

## 6. 同步：git 是搬运工，不是大脑

- **写**：`memory_add`（project scope）→ 写 **appdata 草稿箱**，同时更新本地索引。
  **不碰 repo、不自动 commit、不自动 push**。
- **交**（显式，你说了算）：`open-memex submit <id...>` → 本地分支 + 本地 commit
  进 `.ai/open-memex/`；push/PR 命令打印给你（或你的 agent 拿着你的 Yes 自己做）。
- **拉** **2B**：`open-memex pull`（必须显式，没有自动）→ git fetch + fast-forward →
  扫描 `.ai/open-memex/*.md` → 按文件 mtime 合进本地 `index.db`。检索永远走 SQLite，不 walk git。
- **personal scope**：永远不同步（§1 铁律）。
- **没 git 的项目**：照常用，project scope 降级为纯本地并明确提示，不会坏掉。

## 7. 安全底线

- 记忆默认是**数据**，不是指令——外来内容（同步拉回的、别人晋升的）入库前要过
  admission 检查；共享文件的 prompt-injection 筛查只是启发式的，真正的边界是数据/指令分离。
- 每条记忆带出身证明：`source` + `confidence` + `via` + 作者。共享写操作进 audit log。
- pre-commit hook 扫描共享 scope 的 secret，防止 history rewrite。
- `<private>…</private>` 包裹的内容在写入时直接剥离；命中的 secret 模式做掩码后写入继续。

---

*配套设计文档：`docs/V2-DESIGN.md`（D1–D24 决策记录）。*
