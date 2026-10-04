# 发布手册（Release Runbook）

发布时照着这一页走。npm publish 和 MCP Registry 发布都在维护者本机执行。

## 同步版本号的四个地方

- `package.json` 和 `package-lock.json`（同一个 commit 里一起改）
- `server.json`：根 `version` 和 `packages[0].version`（MCP Registry 用）
- `CHANGELOG.md`：发 stable 时把 `[Unreleased]` 的内容挪进新的版本节；alpha 不单独记

## 版本号怎么升

- 新功能：minor +1 并进入 alpha 线（如 `0.7.1` → `0.8.0-alpha.1`）
- alpha 线内迭代：`alpha.N` 的 N +1
- 纯修 bug：patch 线递增
- 已经 push 过的版本号，内容再有变化必须 bump，不能原地改

## 发布前检查（在仓库根目录执行）

```powershell
git pull
npm run build
npm run test-full
```

`test-full` 之前必须先 `build`：测试里有 dist 内容指纹守卫，没 build 会误报失败。

## 本机前提（Windows）

- Node 必须 ≥ 22.14.0（better-sqlite3 13 的硬要求，低于它老版本会静默崩溃）。nvm-windows 切换：

```powershell
nvm use 22.23.3
node -v
```

- nvm-windows 每个 Node 版本有独立的全局包目录：换完 Node 后在新版本下重装一次全局包（SQLite 驱动是 N-API 预编译的，不用为此重编译）：

```powershell
npm install -g open-memex
```

## 发 alpha

```powershell
npm whoami
npm publish --tag alpha
```

发完把版本号告诉小沐核验即可（例如"0.8.0-alpha.1 published"）。alpha 不打 git tag、不建 GitHub Release。

## 发 stable

1. main 上的版本号落到 `X.Y.Z`（可让小沐代提交），`CHANGELOG.md` 完成分节，`server.json` 同步到同一版本。
2. 发布：

```powershell
npm whoami
npm publish
```

3. 把版本号告诉小沐（例如"0.7.2 published"）：小沐核验 npm latest，然后打 git tag `vX.Y.Z` 并建 GitHub Release。
4. 同步 MCP Registry（在仓库根目录执行；`login` 登录态过期时才需要重跑）：

```powershell
& "$env:USERPROFILE\tools\mcp-publisher\mcp-publisher.exe" login github
& "$env:USERPROFILE\tools\mcp-publisher\mcp-publisher.exe" publish
```

## 出问题先看这里

- `npm publish` 失败：先确认 `npm whoami` 的登录态，再看报错第一行。
- 本地装好后自检：`open-memex doctor`。
- 本机 Node 版本低于 22.14 时，所有 Node 入口（CLI、VS Code 的 MCP server）会无提示退出——先升 Node，别查代码。
