# RepoDrive

把一个指定的 GitHub 代码仓当作轻量文件盘使用的桌面客户端。

> 本仓库中的 `repodrive.config.json` 是预配置文件。自行部署时，请在打包前把其中的代码仓地址改成自己的固定文件盘仓库；不要把访问 Token 写入该文件。

## 能力与安全边界

- macOS：浏览、下载、上传文件及完整目录；目录保持原层级，不压缩。
- Windows：独立的纯只读构建，只包含浏览、目录/文件下载和设置代码。安装包不包含 macOS 主程序、CLI、上传界面、上传处理器或写请求；连接时还会拒绝 GitHub 报告为可写的 Token。
- macOS 和 Windows：都可指定 HTTP/HTTPS 代理。
- Token 使用 Electron `safeStorage` 加密后保存在当前用户的应用数据目录，不会写进代码仓。

RepoDrive 使用 GitHub Contents API，因此单文件不能超过 100 MB。它适合文档、图片、压缩包和小型项目资料，不适合频繁同步或超大文件。每次上传都会产生一个 Git commit；同名文件会更新。

目录上传会跳过 `.git` 文件夹，最多一次上传 1000 个文件。GitHub 本身不保存空目录，因此空目录不会出现在仓库中。目录下载会直接创建文件夹并逐项保存，不生成压缩包。

## GitHub Token

建议创建 fine-grained personal access token，并且只授权目标仓库：

- Windows 浏览/下载：Repository permissions → Contents: Read-only（必须；可写 Token 会被拒绝）
- macOS 上传：Repository permissions → Contents: Read and write

公开仓库浏览和下载可不填写 Token。macOS 会优先复用本机 GitHub CLI 的登录；否则私有仓库和上传操作必须填写 Token。填写的 Token 会使用系统安全存储加密。

## 本地运行

```bash
npm install
npm start
```

## 命令行

先在项目根目录的 `repodrive.config.json` 中固定填写代码仓、分支、仓库内根目录和代理。安装项目依赖后，可直接使用 `npm exec repodrive --`，或通过 `npm link` 安装全局的 `repodrive` 命令：

```bash
export REPODRIVE_TOKEN=github_pat_xxx

repodrive list
repodrive download documents --output ./documents
repodrive upload ./photos --path archive
repodrive list --json
```

也可以不设置 `REPODRIVE_TOKEN`；如本机已通过 GitHub CLI 登录，会自动读取 `gh auth token`。不要把 Token 写进命令参数或脚本。Windows 上 `upload` 命令会在联网前直接拒绝。

`skill/repo-drive` 可安装为 Codex Skill。Release 中同时提供 Skill ZIP 和 CLI npm 包；使用可移植 Skill 前，请先全局安装对应的 CLI 包。

## 打包

```bash
npm run pack:mac
npm run pack:win
```

Windows 安装包应当在 Windows 上构建。仓库附带 GitHub Actions 工作流；推送 `v*` tag 或手动运行后，会分别在 macOS 与 Windows 官方 runner 上生成安装包。也可运行 `npm run audit:win` 审计成品中的应用文件白名单和写入功能禁令。

## 代理

在设置页填写如 `http://127.0.0.1:7890`。代理配置由 Electron 网络会话处理，并在连接测试前立即生效。

## 开发安全说明

Renderer 开启 context isolation 和 sandbox，并使用 Content Security Policy。所有 GitHub 请求、文件选择和本地写入都在主进程中执行。
