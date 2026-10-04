# 发布手册（Release Runbook）

发布时照着这一页走。npm publish 和 MCP Registry 发布都在维护者本机执行。

> 命令一条一条跑，不要整段一起贴：`publish` 之前有几道必须确认成功的关卡，顺序错了会把半成品发出去。

## 同步版本号的四个地方

- `package.json` 和 `package-lock.json`（同一个 commit 里一起改）
- `server.json`：根 `version` 和 `packages[0].version`（MCP Registry 用）
- `CHANGELOG.md`：发 stable 时把 `[Unreleased]` 的内容挪进新的版本节；alpha 不单独记

## 版本号怎么升

- 新功能：minor +1 并进入 alpha 线（如 `0.7.1` → `0.8.0-alpha.1`）
- alpha 线内迭代：`alpha.N` 的 N +1
- 纯修 bug：patch 线递增
- 已经 push 过的版本号，内容再有变化必须 bump，不能原地改

## 发布前检查（在仓库根目录执行，一条一条来）

先拉最新代码：

```powershell
git pull
```

再构建：

```powershell
npm run build
```

最后跑全量测试。`test-full` 之前必须先 `build`：测试里有 dist 内容指纹守卫，没 build 会误报失败。

```powershell
npm run test-full
```

测试全绿再往下走，中间任何一步报错就停。

## 本机前提（Windows）

- Node 必须 ≥ 22.14.0（better-sqlite3 13 的硬要求，低于它老版本会静默崩溃）。nvm-windows 切换：

```powershell
nvm use 22.23.3
```

确认版本已经切好：

```powershell
node -v
```

- nvm-windows 每个 Node 版本有独立的全局包目录：换完 Node 后在新版本下重装一次全局包（SQLite 驱动是 N-API 预编译的，不用为此重编译）：

```powershell
npm install -g open-memex
```

## 发 alpha

先确认 npm 登录态：

```powershell
npm whoami
```

输出的是自己的 npm 用户名再发布：

```powershell
npm publish --tag alpha
```

发完把版本号告诉小沐核验即可（例如"0.8.0-alpha.1 published"）。alpha 不打 git tag、不建 GitHub Release。

## 发 stable

1. main 上的版本号落到 `X.Y.Z`（可让小沐代提交），`CHANGELOG.md` 完成分节，`server.json` 同步到同一版本。
2. 一条一条执行：先确认登录态：

```powershell
npm whoami
```

再发布：

```powershell
npm publish
```

3. 把版本号告诉小沐（例如"0.7.2 published"）：小沐核验 npm latest，然后打 git tag `vX.Y.Z` 并建 GitHub Release。
4. 同步 MCP Registry。**必须等 npm 新版生效后再跑**：registry 会去 npm 抓新版本的实际包验 `mcpName` 和版本。`npm publish` 成功后先等 1–2 分钟，再执行发布（登录态过期时才需要先重跑 `login github`，也是一条一条来）：

```powershell
& "$env:USERPROFILE\tools\mcp-publisher\mcp-publisher.exe" publish
```

在仓库根目录执行。万一报版本相关的错，多半是 npm 元数据还没传播完，再等两分钟重跑这一条即可。

## 出问题先看这里

- `npm publish` 失败：先确认 `npm whoami` 的登录态，再看报错第一行。
- 本地装好后自检：`open-memex doctor`。
- 本机 Node 版本低于 22.14 时，所有 Node 入口（CLI、VS Code 的 MCP server）会无提示退出——先升 Node，别查代码。
