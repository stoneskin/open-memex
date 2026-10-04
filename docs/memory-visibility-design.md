# OpenMemex 3-C 设计稿：记忆可见性 inventory（v2 · 已按 review 修订）

## 为什么先做这个（已定）

2026-10-03 拍板：auto-draft 姿态等 3-C 记忆可见性出来再开。理由是信任顺序不能反——在用户能一眼看清"你到底记了我什么、每条是哪来的、怎么删"之前，agent 不经询问就往草稿箱里塞东西，只会读作监控而不是帮忙。3-C 就是补上这个"看得见、删得掉"的面。

现状盘点（已核对代码，见文末"事实校正"）：

- `memory_list`（D64 已支持 `scope: both`）输出是开发者格式：`- [type] [review_state] id=ULID — 片段`。**没有**生命周期状态、没有时间、没有来源（`source`/`created_at` 在 DB 里但没进 SELECT）。
- `memory_status` 管的是同步队列（草稿箱/待审），不是"记忆全貌"。
- 删除只有 `memory_forget`（硬删文件，无 undo）和 CLI `status retracted`（软藏，工具面没有这个动作）。
- provenance 字段其实齐全：`source`（user/tool/keyword/inference/import）、`created_at`、`review_state`、`review_history`、`derived_from` 都在 frontmatter 里。**这是展示问题，不是 schema 问题**——3-C 不动 schema。

## 三条硬约束（review 追加，先于功能）

1. **personal 不出机器。** 单一产物不得默认落在 git 工作树里。报告同时含 personal + project 内容，`-o` 指到仓库里就是一次泄露——这不是概率问题，是一次误操作就到。
2. **协议是冻结的（v0.2）。** 动 `memory_list` 的入参和输出格式就是动协议面：形状必须在实现前定死，实现 PR 里追加 D 条目，事后加就是破坏性变更。
3. **可见性面不许静默截断。** 截断必须自报（与 D66 `sync-status` 的教训同源）。用户问"你记得我什么"而答案被悄悄砍掉一半，比没有这个面更伤信任。

## 3-C 做什么

### 一、聊天内清单（A 面，先做）

把 `memory_list` 的输出改成**结构化行 + 稳定句柄**，让任何宿主的 agent 能直接拿它回答"你记得我什么"：

```
## 关于你（personal）
3. [fact] id=01K6AB3XZQ7WVD9J1M2N4P5Q6R7 created=3d source=user — 喜欢简洁的 diff
7. [preference] id=01K6AB3XZQ7WVD9J1M2N4P5Q6R8 created=12d updated=2d source=inference — 家里网络是双线负载
## 当前项目（open-memex）
1. [decision] id=01K6…R9 created=2d source=keyword [draft] — 发布走 alpha 线
… 另有 34 条未显示（--limit 100，或用 memory_search 查具体内容）
```

要点：

- **序号与 id 永远同时出现。** 序号是给嘴用的（"删掉第 3 条"），id 是给机器用的契约。删除确认语里带 id。
- **时间用 `created_at`（学会的时间），不是 `updated_at`。** list 的排序键是 `updated_at`，而它在 supersede/promote 时会动；两者不同才补一个 `updated=`。别把"3 天前学的、2 天前改过"说成"2 天前"。
- **输出里保留原始枚举，不写死中文短语。** `source=user` 对模型比对"你亲口说的"更可靠，也不锁语言、不锁措辞；人话短语（user→"你亲口说的"、inference→"我推断的"、keyword→"关键词自动抓的"）放进工具描述 + SKILL.md + MCP 握手，由 agent 按对话语言转述。仓库规则是"一个声音说指引"，不是"一个声音说数据"。
- **入参（协议面，D68）**：`include: "active" | "all"`，默认 `active`。注意：**现在的 list 完全没有状态过滤**，所以"默认只列 active"是新行为——必须显式参数化并在 CHANGELOG 写明，不能悄悄改默认（依赖旧默认的 agent 会突然找不到 superseded 的链条）。`archived`/`retracted` 只在 `all` 下出现。
- **截断自报。** `limit` 默认 20、上限 100 是既有事实。输出必须带真实总数 + 截断说明行（文案见上）。
- **序号只在本次清单内有效**（顺序依赖 `updated_at`，会话中途一次 supersede 就可能重排）。指引里写死：被要求删某条时若只记得序号，先重新 `memory_list` 再复述内容确认，不要凭上一轮的序号映射。
- review_state 标签沿用现状（personal 不显示，因为 `hitStateLabel` 对 personal 返回空）；`published` 常态不提。`memory_status` 的待审队列另有去处，两个面不混。
- 指引文案四处同步（SKILL.md、`memory_list` 工具描述、MCP 握手、`distill-agents` 输出的 AGENTS.md 片段）：被问"你记得我什么"时调 `memory_list(scope: both)` 并用大白话复述、别甩内部 id；用户点名删某条时先复述那条内容确认再调 `memory_forget`。

### 二、inventory 命令（B 面，三段走：text → json → html）

CLI 新增 `open-memex inventory`，一个数据源、三种渲染：

- `--format text`（默认，先行）：纯文本清单，~30 行代码，可在任何终端/CI 里 diff。**先用它验证清单格式本身对不对**，再谈 UI。
- `--format json`：给 agent 用。agent 不该去解析 HTML——这条也让 A 面和 B 面共用同一份数据，未来加字段只改一处。
- `--format html`（最后）：本地单文件，浏览器打开即看。按 scope 分组、纯静态、无脚本外链、无网络请求；页内一个本地过滤框（内嵌小 JS）。

硬规则：

- **HTML 必须全量转义。** 记忆正文可能来自 `import` 出来的包或粘贴的网页内容，`file://` 下一个没转义的 `<script>` 就是在用户自己浏览器里执行。过滤逻辑用 `input` + 事件委托，不用 `innerHTML`。
- **默认输出到数据目录，不落工作树。** `--output` 指到 git 工作树内时**拒绝**，除非显式 `--allow-personal`（报告含 personal，这是 D62/铁律的边界，不是洁癖）。`export` 已有同类先例可循。
- **每条给可复制的 id。** 不再只给"内容前 12 字"——截断、引号、内容改动都会让那句提示失效，而 id 不会。
- **独立分节**：还没进仓库的（outbox，与 `memory_status` 计数一致）、折叠的"已替换 / 已隐藏"（含 `supersedes` 链接）。聊天清单里不出现历史，但报告里必须可审计——否则用户发现答案过时了却查不出它怎么变成过时的，最可能的反应是把旧事实重新加一遍。
- **复用 `export.ts` 的 manifest/序列化**，不写第二个序列化器。两份实现必然漂移。
- **规模**：条数很大时给分页或显式截断说明，不静默砍。默认 `--scope` 全量（personal + 当前项目），可加 `--scope` 过滤。
- 报告只读，不放删除按钮、不回连本地服务（起 server 管端口违背本地优先的简单性，删除本来就该发生在有确认语的对话里）。

### 三、纠正动作的诚实边界

- **删除 = 硬删，无 undo。** 不假装有回收站。防呆全在对话层：agent 删除前**复述内容**、用户点头（写进指引）。复述的是内容不是序号。
- **新增并列的软动作："先藏起来"（`retracted`）。** 语义现成（检索会排除 `retracted`），只是工具面没有——把它暴露成 `memory_forget --soft` 或一个 `memory_status` 入参即可。理由：不可撤销的动作有两种时，用户才敢选；只给"删"的清单会让人不敢删。不确定是不是该删的，就先藏。
- **删除在序号上不做猜测。** 用户只给序号时，agent 先重新列清单、把候选内容念出来让用户点名。
- 已进仓库的记忆被删 = 工作树删除，要 commit 才算数（`memory_forget` 已有该提示，保持；报告页脚注提一句，不当卖点）。
- 清单和报告默认都不显示 `retracted`/`archived`/`superseded`（走 `include`/`--all`），报告的"已替换/已隐藏"折叠节是唯一的例外。

### 四、与 auto-draft 的解锁关系

3-C 落地后 auto-draft 的解锁条件（将来开 auto-draft 时回来对照）：

1. A 面指引已教会 agent 在检查点汇报草稿箱存量（"我新存了 2 条草稿，你可以随时让我列出来"）；
2. B 面报告存在，且草稿箱一节与 `memory_status` 计数一致；
3. 删除路径在清单语境里验证过（序号→id 映射、复述确认语、仓库内删除的 commit 提示）；
4. 软藏（retract）路径在清单语境里验证过（agent 能藏、能列出被藏的、用户知道怎么取消——若不做，则明确记录"只有硬删"是当前的诚实边界）。

**回滚条款（现在就写下来）：** 开了 auto-draft 之后，如果用户仍说不清库里到底有什么、或者第一反应是要求清库而不是用起来，就退回 D61 的 propose 姿态（agent 提议、用户点头），而不是继续加提示。

**度量：** 本地优先、不带遥测，所以度量只能是人工的：找 5–10 个真实用户做同一个任务——"在 30 秒内找到并删掉一条你知道被记下来的事"，记录卡在哪一步（找不到 / 不敢删 / 不知道删的是哪条）。这个任务同时验证可见性和纠正动作，比任何问卷都准。

## 事实校正（review 逐条核对代码，与原稿有出入的地方）

- `list()` 只显示 `review_state`，**不显示生命周期 `status`**；而且 `hitStateLabel` 对 personal 直接返回空串（`src/retrieve/search.ts:73`）。原稿"有 status/review_state"只对了一半。
- 索引里的 `created_at`/`updated_at` 是 INTEGER epoch ms（`src/store/db.ts:46-47`），RFC3339 只存在于 frontmatter。
- `list()` 的排序键是 `updated_at DESC`，`limit` 默认 20、上限 100（`src/retrieve/search.ts:217-225`）——"3 天前"和"截断"两个问题都源于此。
- 索引里 `source` 列已存在（`src/store/db.ts:43`），补 SELECT 即可，不需要重建索引。
- `loadConfig` 是浅合并 `{...DEFAULT_CONFIG, ...parsed}`（`src/config.ts:226`）：用户自定义 `keywordPatterns` 会**整表替换** 12 条默认 pattern。这是"后续一件"的形态依据，也是现在的脚枪。
- 坏正则被静默跳过（`src/capture/keywords.ts` 的 `catch { continue }`）——自定义 pattern 校验要补的就是这一条。
- `loadConfig` 已有"对用户可写的字段做加载期校验"的先例（`memoryDir`，`src/config.ts:231`），列表键照此办理。

## 不做（明确划出）

- 本地 Web 服务 / 可点击回连的 UI（起 server 那套）。
- undo / 回收站机制（软藏 `retracted` 不是回收站：它不进清单，但也不可恢复）。
- 新 frontmatter 字段、新 schema 版本（"你确认过"这类概念本稿不承诺——schema 里没有确认态，只有 `source` 和 `review_history`）。
- 报告的自动定时生成（用户想看时手动跑，或让 agent 跑）。
- 任意正则的自定义触发词（先做 curated 开关，见下）。

## 实现清单（估大小）

| 块 | 内容 | 量 |
|---|---|---|
| 清单格式 | list 查询补 `source`/`created_at`；`include` 入参；输出改结构化行（序号+id+相对时间+来源）、截断自报 | 小 |
| 纠正动作 | `memory_forget --soft`（或 status 入参）；指引文案里的复述确认语与序号失效规则 | 小 |
| inventory text | `--format text`：复用 manifest 序列化，两 scope + outbox 一节 | 小 |
| inventory json | `--format json`：同一数据源，给 agent | 小 |
| inventory html | 单文件 HTML：转义、过滤框、`--output` 工作树拒绝、折叠历史节、规模处理 | 中 |
| 测试/文档 | test-full 加清单格式/截断自报/软藏/html 转义/工作树拒绝；README 双语、CHANGELOG、V2-DESIGN 追加 D68 同 commit | 小 |

建议 PR 切分：A（清单格式 + 纠正动作 + text/json）一个 PR，HTML 一个 PR——HTML 是呈现层，格式先被 text/json 验证过再上。

版本号：本稿不动版本；实现时按当时 alpha 线递增（Stone 2026-10-03 定："3C 时换版本号"）。实现 PR 必须同时在 `docs/V2-DESIGN.md` 追加 D68（协议面改动：`memory_list` 入参 + 输出格式）。

## 后续一件（3-C 之后单独实现，不进本组）

**用户自定义关键词触发模式**（Stone 2026-10-03 提出）：D67 把 `don't forget …` / `别忘了…` 裸形收紧为需要分隔符或 `that`，但裸形正是部分用户的习惯说法（Stone 本人就是）。默认保持收紧，另给一条加回来的路，分两步：

1. **curated 开关（先做）**：`narrationTriggers: false`（默认关）。打开即恢复 D67 收紧的那几个裸形。代价写在文档里——召回上去了，误捕叙事的风险也回来了，这是明确的取舍而不是 bug。
2. **追加式自定义 pattern（后做）**：`keywordPatternsExtra` / `keywordPersonalPatternsExtra`，**追加**在默认表之后（不是替换——`config.ts:226` 的浅合并会让整表替换，用户加一条就丢掉其余 12 条）。需要：`config set` 的列表键校验、set 时编译正则并报错（现在坏正则被静默跳过）。

## 待你拍板（剩余项；不回我按推荐走）

1. **软藏进不进工具面？** 推荐进：`memory_forget --soft`（最小改动，复用现有语义与检索排除逻辑），可撤回的前提是"能藏"这个动作存在。
2. **HTML 过滤框的交互？** 推荐：条数 ≤ 50 全展开，超过则历史折叠、内容按 scope 折叠；过滤框始终可见。
3. **`inventory --scope` 默认值？** 推荐默认全量（personal + 当前项目），因为"看不见"正是本组要治的病。
4. **D68 落在哪个 PR？** 推荐随 A 面那个 PR 一起落（协议面与实现同 commit）。