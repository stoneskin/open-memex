# 概念 —— open-memex 是怎么工作的

[English](./CONCEPTS.md)

> 本文档解释 open-memex 的**心智模型**：你的记忆住在哪里、如何流动、谁能看见。
> 这不是操作手册——安装与命令请看 [README](../README.zh-CN.md)。当你想在
> open-memex 动手之前先预判它会怎么做时，读这份。

## 一句话

open-memex 是一个本地优先的记忆层：**Markdown 是事实来源；
SQLite 只是可重建的索引。**丢了索引可以重建。丢了 Markdown 就真的没了。

## 1. 两种作用域：personal vs project

每条记忆属于一个作用域，它决定**这条记忆最远能到哪**：

| | personal | project |
|---|---|---|
| 装什么 | 关于你的事实：偏好、习惯、跨项目信息 | 关于项目的事实：技术栈、约定、决策、坑 |
| 住在哪 | 只在你的机器上（见 §2） | 本地 + 可以进入团队共享（见 §2、§5） |
| 铁则 | **永不离开这台机器** | 可以被提升为团队知识 |

在 opencode 原生插件上，关键词捕获会自动分流：
"记住我… / 替我记… / 我觉得… / 我喜欢…"（关于我）→ personal；
"我们决定… / 帮我们记住…"（关于我们）和其余一切 → project。
其他接入方式下，作用域由 `memory_add` / `--scope` 明确给出。

## 2. 两个家：appdata vs 仓库目录

| | appdata（书桌） | 仓库 `.ai/open-memex/`（书架） |
|---|---|---|
| 位置 | Windows `%APPDATA%/open-memex`，macOS/Linux `~/.local/share/open-memex` | 项目根目录，默认 `.ai/open-memex/`（可用 `memoryDir` 配置） |
| 装什么 | `memories/personal/` 个人记忆；project 作用域的 **draft 发件箱**；`index.db` 本地索引 | 已提交的 project 记忆（`proposed` 及以上） |
| 进 git？ | 不进 | 进——git 是它的快递员 |
| 索引？ | `index.db` 可重建，**永不提交** | 不存索引；按需从 Markdown 重建 |

私人笔记本（personal）永远不上书架。这是铁则，不是设置项。

Project 记忆出生在 **appdata 发件箱里当 draft**——git 看不见、与分支无关。
只有你点名的 draft 才会通过 `open-memex submit`（§5）上书架。一个阶段一个家：
submit 成功后发件箱原件消失；成功之前，仓库什么都不知道。

## 3. 首轮注入：8 条 project + 5 条 personal 是怎么选出来的

在助手第一轮回复前，open-memex 会注入一个 `[OPEN-MEMEX]` 上下文块，
让它不必先调一次搜索就能进入状态。默认 **8 条 project + 5 条 personal**
（`maxProjectMemories` / `maxProfileItems`，可调）。

选择标准只有一个：**按最近更新优先**
（`ORDER BY updated_at DESC`），去掉已撤回/归档项，旧版本被
supersede 掉的也不算一份。不是"最重要的 N 条"，是"最近碰过的 N 条"。
你刚更新过的东西，最可能与你眼下在做的事有关。

Token 账：每条压成一行（≤240 字符，约 60 tokens），8 条最坏约 500 tokens。
再多收益递减——长尾是 `memory_search` 的活；把所有东西都塞进首轮只会淹没信号。

调大：`open-memex config set maxProjectMemories 12`

## 4. 后续轮次：什么时候会再次搜索记忆

首轮注入只发生一次。之后**没有自动重搜**——
MCP 是请求/响应模式，服务端没法主动推。调不调 `memory_search`
完全取决于模型自己的判断，靠两处引导：

- 注入块的页脚："Use the `memory_search` tool to look up more."
- `init` 写入的编辑器规则："before asking the user about something
  they may have told you before, call `memory_search` first — try a few keyword
  variants before giving up."

所以：当对话碰到过往决策、偏好或约定时，模型*应该*先搜——
但没有任何机制强制它。这是当前设计的真实边界：在 opencode 原生插件上
首轮注入是内建的，但后续轮次的回想仍取决于助手是否主动搜索；
走 MCP 时没有硬会话钩子，只有引导。

## 5. 一条记忆如何成为团队知识

个人观察变成团队知识只有一条路——
**显式提升，永不自动同步**：

```
personal idea ──propose──▶ outbox draft ──submit──▶ proposed ──┬──promote──▶ approved ──promote──▶ published/shared
                                                              │                        │
                                                           --reject                 --reject
                                                              │                        │  (merge 前撤回批准)
                                                              ▼                        │
                                                           rejected ──resubmit──▶ proposed
```

把四个动作的分工理清——大多数困惑都来自混淆它们：

- **propose 跨界**（personal → project 发件箱；唯一一步跨作用域拷贝）。
  它把一条或多条个人记忆*拷贝*进发件箱当评审候选，各自生成新 id、
  `derived_from` 指回原件。原件永远保留。单人开发？`--local-approve` 自批。
- **submit 把 draft 搬进仓库**（发件箱 → `.ai/open-memex/`，
  `draft → proposed`）。它在你的**当前分支**上做**本地** commit——
  绝不自作主张建分支、绝不 push。全有全无：同 id 不同内容会中止，交人裁决。
- **promote 只翻状态标签**，文件已在 `.ai/open-memex/` 里
  （`proposed → approved → published`，或 `--reject` 附说明——
  也可从 `approved` 驳回，即 merge 前撤回批准）。它从不在目录间搬文件。
  每次流转都追加进该记忆的 `review_history`（谁/何时/从→到/为什么），
  轨迹熬得过 PR 关掉。
- **git 负责运输**（push、PR、merge）。

评审本身不需要专用 UI。一个记忆 PR **只含记忆文件**，
与代码 PR 分开评审审计；审稿人看的是"这是真的吗？能共享吗？有密钥吗？"——
这是代码 PR 的 CI 永远不查的事。"Request changes" 不需要命令：
PR 开着时改文件、commit、push 即可，状态保持 `proposed`，PR 就是评审机制。

两个助手把 GitHub 和本地索引的圈闭上：

- `open-memex pr-status [--apply]` 把分支 PR 的状态映射回每条仓库内记忆
  （已合并 → `published`，已批准 → `approved`，要求修改 → 仅建议、绝不自动驳回）。
  默认只报告；`--apply` 在本地执行这些流转。
- `open-memex resolve [id]` 列出冲突的记忆文件，或对某条做字段级三路合并。
  语义冲突**只报告、绝不自动解决**。

**驳回永远不删任何东西。**文件留在你的分支上，接下来由人决定：

1. **接受**：关 PR 删分支——文件随之而去；
2. **修改重提**：改文件、`promote --resubmit`、commit、push——同一 PR 继续评审；
3. **留作记录**：留着，带 `[rejected]` 标签和你的说明，
   让团队看见考虑过什么、为什么没过。

最后：`list` / `search` 会在 project 记忆旁标出评审状态
（`[draft]` / `[proposed]` / `[approved]` / `[published]` / `[rejected]`），
并且检索排序让已评审知识（`approved` / `published`）压过未评审的发件箱 draft——
draft 找得到，但绝不冒充已审。

## 6. 同步：git 是快递员，不是大脑

- **写**：`memory_add`（project 作用域）→ 写**appdata 发件箱**
  并更新本地索引。**永不碰仓库、永不自动 commit、永不自动 push。**
- **提交**（显式、你说了算）：`open-memex submit <id...>` → 本地 commit
  入 `.ai/open-memex/`；push/PR 命令打出来给你看（或你的助手在你点头后代劳）。
- **拉**：`open-memex pull`（永远显式、永不自动）→ git fetch +
  fast-forward → 扫 `.ai/open-memex/*.md` → 按文件 mtime 合入本地 `index.db`。
  检索永远走 SQLite，不翻 git。
- **personal 作用域**：永不同步（§1 铁则）。
- **无 git 的项目**：照常工作；project 作用域退化为按路径索引的本地记忆，
  并给出明确提示。什么都不会坏。

## 7. 安全模型

- **记忆是数据，不是命令。**记忆以文本形式回到助手的上下文里，
  是*用的*，不是*听的*——包括通过同步拉来的、或别人写的记忆。
  共享记忆没有自动化筛查；真正的边界是 §5 的人工评审
  （"这是真的吗？能共享吗？有密钥吗？"）加上这条数据/指令分离。
  读共享记忆，要像读陌生人编辑过的 wiki 页面。
- **出处随文件旅行。**每条记忆记着 `source`，
  评审轨迹里的记忆还带 `proposed_by` / `approved_by`
  和只追加的 `review_history`——全部写在 Markdown 文件自身里，
  所以轨迹熬得过分支、PR 和导出。
- **密钥在写入时拦下。**`<private>…</private>` 段在保存前剥掉；
  识别出的 API 密钥/token 就地打码（保留前 4 位，方便认出是哪把）
  然后继续写。用 `open-memex capture --dry-run` 预览。
- **personal 永不进 git**（§1）——`submit` 不行、`export` 默认不行、
  任何方式都不行。

---

*设计记录：`docs/V2-DESIGN.md`（只追加的决策日志）。按作用域的细节：
`docs/SCOPES.md`。审稿人约定：`docs/CURATOR.md`。*
