# OpenMemex 测试计划（v0.5.1）

> 自动化部分：`node --experimental-strip-types scripts/test-full.ts`
> 62 项全过（26 个 CLI 命令 + 11 个 MCP tool），隔离环境运行，不碰真实数据。
> 下面是机器/账号相关的部分，需要 Stone 在真机上过一遍。

## A. Windows 真机 + VS Code Copilot

- [ ] `npm i -g open-memex` 全局安装（稳定版），`open-memex --version` 显示正确版本
- [ ] 在一个真实项目目录跑 `open-memex init`（不加 `--yes`，走一遍交互）
  - 确认 `.vscode/mcp.json` 生成，`~/.copilot/copilot-instructions.md` 合并写入（不覆盖已有内容）
- [ ] 重启 VS Code，Copilot Chat 里问 "what do you remember about this project?"
  - 预期：MCP 连接成功，能调用 memory_search
- [ ] `open-memex add "windows 真机测试" --type fact`，再让 Copilot 搜出来
- [ ] 中文路径项目、中文记忆内容各试一条（CJK 索引）

## B. 真实 GitHub PR 全流程（review 工作流）

在一个真实 repo 里：

- [ ] `open-memex add "PR流程测试" --scope personal` → `propose --to project` → `sync-status` 看到 outbox draft
- [ ] `open-memex submit <id>`（留在当前分支，本地 commit）
- [ ] 手动 `git push` + 开 PR
- [ ] 在 PR 里点 Approve → 回来跑 `open-memex pr-status`（先看 report），再 `pr-status --apply`
  - 预期：memory 变成 approved，`approved_by` 是 reviewer
- [ ] 找一条让 reviewer 点 "Request changes" → `pr-status --apply`
  - 预期：只给 suggestion，**不**自动 reject（D32）
- [ ] Merge PR → `pr-status --apply`
  - 预期：memory 变成 published
- [ ] `open-memex resolve` 无冲突时输出 "(no conflicted memory files)"

## C. 其他编辑器 MCP 集成

- [ ] Cursor：`open-memex mcp --print-config cursor` → 贴到 Cursor MCP 配置 → 能连上
- [ ] opencode：`open-memex init --client opencode` → `opencode.jsonc` 生效
- [ ] `open-memex init --yes`（不带 --client）→ 自动检测已装编辑器并一次全接上
- [ ] opencode：`open-memex init --client opencode --global` → `~/.config/opencode/opencode.json` 的 `plugin` 数组合并（带注释的 jsonc 不动、只给手动提示）
- [ ] Claude Code：`open-memex mcp --print-config claude` 给出的 `claude mcp add` 命令能跑通

## D. 跨机迁移（export/import 真实场景）

- [ ] 本机：`open-memex export --all -o migration.tar.gz`（含 private 的全量）
- [ ] 本机：`open-memex export -o share.tar.gz`（默认排除 private）→ 解包检查 manifest，确认没有 visibility:private 的条目
- [ ] 另一台机器：`open-memex import migration.tar.gz --dry-run` 先看预览，再正式 import
  - 预期：project memory re-key 到新机器的 project scope，进 outbox 当 draft；personal 进 personal
- [ ] 同一个 bundle 导两次 → 第二次 "skipped N identical"

## E. Agent 会话行为（D42 / §3.5）

- [ ] 新开一个 agent 会话（MCP 已接），看 initialize 返回的 instructions 里有没有 session-start 同步指引
- [ ] 对 agent 说 "sync memory" / "同步记忆"
  - 预期：agent 走 memory_status → 摘要 → 问你要同步哪条（而不是直接翻 appdata）
- [ ] 长对话中 agent 是否在检查点提议蒸馏（§3.5），提议后是否等你批准才保存（D42）

## F. 冲突解决（3-way merge）

- [ ] 两台机器（或两个 clone）同时改同一条 project memory，各自 submit + push，一边 pull 制造 diverged
  - 预期：`open-memex pull` 明确报错退出，不自动 merge
- [ ] 手动 merge 后 `open-memex resolve <id>` 看 3-way 展示（base/outbox/repo），手动解决

## G. 同事 pilot（1–2 人，Stone 私下选）

- [ ] 对方 `npx -y open-memex init` 走通
- [ ] 对方能 propose → 你这边能看到 PR → promote 流程走通
- [ ] 收集反馈：哪里卡、哪里不符合直觉

## I. init/uninstall 行为（D47–D49）

- [ ] 空的 `mcp.json`：`open-memex init --client vscode` 直接写入，不再报 "not valid JSON"（D49）
- [ ] 带注释的 `mcp.json`：`init` 不动文件，只打印手贴片段（D47）
- [ ] `open-memex uninstall --client vscode` 移除接线条目，记忆数据不动；再跑 `init` 可恢复（D48）
- [ ] 裸 `open-memex uninstall`（交互终端）会先确认再清所有编辑器；`--yes` 跳过确认

## H. 已知问题观察

- [ ] better-sqlite3 在 Node 24 退出时偶发 crash（exit 134）：注意是否丢数据（预期：不丢，只影响退出码）
- [ ] `memory_list` 默认只列 project scope 是否符合预期（Stone 已定保持现状）

---

测试中发现的 bug 直接记到 GitHub issue；改完后更新本文档的复选框。
