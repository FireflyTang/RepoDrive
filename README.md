# RepoDrive

把一个指定的 GitHub 代码仓当作轻量文件盘使用的桌面客户端。

首次打开时填写一次代码仓、分支和可选根目录，连接成功后会自动保存，以后浏览和传输都无需重复配置。随包的 `repodrive.config.json` 仅用于提供可选初始值，不会锁定设置。不要把访问 Token 写入该文件。

桌面端使用可展开、折叠的目录树显示仓库内容。文件夹和文件使用不同图标，下载与删除操作也有独立图标；macOS 当前选中的目录会作为上传目标并在界面中高亮显示。

## 能力与安全边界

- macOS：桌面客户端支持浏览、下载、上传和删除文件及完整目录；目录保持原层级，不压缩。
- Linux：CLI 和 Skill 支持浏览、下载与上传；桌面安装包暂未提供。
- Windows：独立的无上传构建，可浏览、下载和删除文件/目录。安装包不包含 macOS 主程序、CLI、上传界面、上传处理器或上传请求；删除是唯一允许的远程写操作。
- macOS、Windows 和 Linux CLI：都可指定 HTTP/HTTPS 代理。
- Token 使用 Electron `safeStorage` 加密后保存在当前用户的应用数据目录，不会写进代码仓。

RepoDrive 使用 GitHub Contents API，因此单文件不能超过 100 MB。它适合文档、图片、压缩包和小型项目资料，不适合频繁同步或超大文件。每次上传都会产生一个 Git commit；同名文件会更新。

目录上传会跳过 `.git` 文件夹，最多一次上传 1000 个文件。GitHub 本身不保存空目录，因此空目录不会出现在仓库中。目录下载会直接创建文件夹并逐项保存，不生成压缩包。

## GitHub Token

建议创建 fine-grained personal access token，并且只授权目标仓库：

- Windows 浏览/下载：公开仓可不填 Token，私有仓需要 Contents: Read-only
- Windows 删除：Repository permissions → Contents: Read and write
- macOS/Linux 上传：Repository permissions → Contents: Read and write

公开仓库浏览和下载可不填写 Token。macOS 桌面端以及 macOS/Linux CLI 可复用本机 GitHub CLI 登录；否则私有仓库和上传操作必须填写 Token。桌面端填写的 Token 会使用系统安全存储加密。

## 本地运行

```bash
npm install
npm start
```

## 命令行

CLI 会自动读取项目根目录的 `repodrive.config.json`。只需配置一次代码仓、分支、仓库内根目录和代理，之后每次命令无需重复指定。安装项目依赖后，可直接使用 `npm exec repodrive --`，或通过 `npm link` 安装全局的 `repodrive` 命令：

```bash
export REPODRIVE_TOKEN=github_pat_xxx

repodrive configure --repo owner/repository --branch main
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

Windows 安装包应当在 Windows 上构建。仓库附带 GitHub Actions 工作流；推送 `v*` tag 或手动运行后，会分别在 macOS 与 Windows 官方 runner 上生成安装包。也可运行 `npm run audit:win` 审计成品中的应用文件白名单、上传功能禁令以及仅允许 `DELETE` 的写入边界。

## 代理

在设置页填写如 `http://127.0.0.1:7890`。代理配置由 Electron 网络会话处理，并在连接测试前立即生效。

## 开发安全说明

Renderer 开启 context isolation 和 sandbox，并使用 Content Security Policy。所有 GitHub 请求、文件选择和本地写入都在主进程中执行。
