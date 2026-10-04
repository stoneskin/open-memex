# OpenMemex 3-C 设计稿：记忆可见性 inventory（待 review）

## 为什么先做这个（已定）

2026-10-03 拍板：auto-draft 姿态等 3-C 记忆可见性出来再开。理由是信任顺序不能反——在用户能一眼看清"你到底记了我什么、每条是哪来的、怎么删"之前，agent 不经询问就往草稿箱里塞东西，只会读作监控而不是帮忙。3-C 就是补上这个"看得见、删得掉"的面。

现状盘点（已核对代码）：

- `memory_list`（D64 已支持 `scope: both`）输出是开发者格式：`[type] id=ULID — 片段`。有 status/review_state，但没有时间、没有来源（source 没进 list 查询），非 CLI 用户看不懂。
- `memory_status` 管的是同步队列（草稿箱/待审），不是"记忆全貌"。
- 删除只有 `memory_forget`（硬删文件，无 undo）和 CLI `status retracted`（软藏，工具面没有这个工具）。
- provenance 字段其实齐全：`source`（user/tool/keyword/inference/import）、`created_at`、`review_state`、`review_history` 都在 frontmatter 里。**这是展示问题，不是 schema 问题**——3-C 不动协议。

## 3-C 做什么

### 一、聊天内清单（A 面，先做）

把 `memory_list` 的输出升级成大白话清单，让任何宿主的 agent 能直接拿它回答"你记得我什么"：

```
## 关于你（personal，跨所有项目）
1. 喜欢简洁的 diff — 3 天前你亲口说的
2. 家里网络是双线负载 — 上周我推断的，你确认过
## 当前项目（open-memex）
3. 发布走 alpha 线 — 2 天前，关键词自动抓取
4. doctor 巡检口径…… — 还在草稿箱，没进仓库
```

要点：

- 每条带**序号**：用户说"删掉第 3 条"，agent 能映射回 id（指引文案里写死这个交互）。
- **时间相对化**："3 天前"而不是 RFC3339 时间戳。
- **来源人话化**：user→"你亲口说的"、inference→"我推断的"、keyword→"关键词自动抓的"、import→"导入的"、tool→"你让我存的"。
- **状态人话化**：draft→"还在草稿箱，没进仓库"、published→省略（常态不提）、superseded→不进清单（默认只列 active；翻旧账走 search）。
- 清单默认只列 **active**，`memory_status` 的待审队列另有去处，两个面不混。
- `list` 查询补 `source`、`created_at` 两列（DB 里都有，只差 SELECT）。
- 指引文案（SKILL.md + 工具描述 + MCP 握手）加一条：被问"你记得我什么"时调 `memory_list(both)` 并用大白话复述，别甩内部 id；用户点名删某条时，先复述那条内容确认，再调 `memory_forget`。

### 二、HTML 报告（B 面，紧随）

CLI 新增 `open-memex inventory`：生成一个本地单文件 HTML（默认写到数据目录并打印路径，`--output` 可指定），浏览器打开即看：

- 按 scope 分组（个人 / 各项目），每条：内容、类型、时间、来源、状态，纯静态、无脚本外链、无网络请求。
- 页面内带一个前端过滤框（本地 JS，单文件内嵌）供条数多时查找。
- **只读**：页面上不放删除按钮。每条底部给一句固定提示——"要删这条？回聊天里对你的 agent 说：删掉‘<内容前 12 字>…’"。理由：HTML 回连本地服务是重机制（要起 server、管端口和生命周期），违背本地优先的简单性；删除动作本来就该在有确认语的对话里发生。
- 草稿箱（outbox）和待审状态在报告里有独立一节："还没进仓库的"单独成组——这正是将来 auto-draft 的可见性门面。

### 三、纠正动作的诚实边界

- **删除 = 硬删，无 undo**。设计上明说，不假装有回收站。防呆靠对话层：agent 删除前复述内容、用户点头（写进指引）。文件若已进 git，仓库历史里还在——报告页脚注提一句，不当卖点。
- "先藏起来"不做成工具：`retracted` 语义留给 CLI 用户；聊天清单里只提供删，不提供藏，避免两个相似动作把小白绕晕。
- 清单和报告都不显示已 retracted/archived/superseded 的条目（默认），`memory_list` 加不加 `--all` 式开关留实现时定，默认不加。

### 四、与 auto-draft 的解锁关系

3-C 落地后 auto-draft 的解锁条件（写在这里，将来开 auto-draft 时回来对照）：

1. A 面指引已教会 agent 在检查点汇报草稿箱存量（"我新存了 2 条草稿，你可以随时让我列出来"）；
2. B 面报告的草稿箱一节存在且与 `memory_status` 计数一致；
3. 删除路径在清单语境里验证过（序号→id 映射、确认语）。

三条齐了才谈开 auto-draft；本组不实现 auto-draft 本身。

## 不做（明确划出）

- 本地 Web 服务 / 可点击回连的 UI（起 server 那套）。
- undo / 回收站机制。
- 新 frontmatter 字段、新 schema 版本。
- 报告的自动定时生成（用户想看时手动跑，或让 agent 跑）。

## 实现清单（估大小）

| 块 | 内容 | 量 |
|---|---|---|
| 清单格式 | list 查询补 source/created_at；ops 输出改大白话（序号、相对时间、来源/状态映射） | 小 |
| 指引文案 | SKILL.md、memory_list 工具描述、MCP 握手各加清单/删除确认指引 | 小 |
| HTML 报告 | `open-memex inventory` CLI：读两 scope、拼单文件 HTML、草稿箱一节 | 中 |
| 测试/文档 | test-full 加清单格式 + inventory 生成用例；README 双语、CHANGELOG、D 条目同 commit | 小 |

版本号：本稿不动版本；实现时按当时 alpha 线递增（Stone 2026-10-03 定："3C 时换版本号"）。

## 后续一件（3-C 之后单独实现，不进本组）

**用户自定义关键词触发模式**（Stone 2026-10-03 提出）：D67 把 `don't forget …` 裸形收紧为需要分隔符/that，但裸形正是部分用户的习惯说法（Stone 本人就是）。默认保持收紧，另给用户一条加回自己说法的路：在默认模式之外，允许用户在配置里追加自己的触发模式（追加式，不替换整表），比如把 `don't forget …` 裸形加回来。形态待定（`config set` 支持列表键，或专门的 `capturePatterns` 追加项），3-C 落地后再做。

## 待你拍板（不回我按推荐走）

1. **A、B 都做吗？** 我推荐都做、A 先（一个 PR 内 A+B 也行，B 是自包含 CLI 命令，风险低）。
2. **命令名** `open-memex inventory` 可以吗？（备选 `report`。我选 inventory，和"清单"一个词到底。）
3. **清单里显示"为什么存这条"吗？** 有些条目有 review_note/derived_from，有些没有。我推荐：有来源上下文就显示（如"从你的个人记忆提议来的"），没有就不硬凑，只给来源+时间。
4. **删除确认语**写进指引（删除前 agent 必须复述内容等用户点头）——我推荐要，这是无 undo 的前提。
