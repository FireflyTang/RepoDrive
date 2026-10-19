# RepoDrive

把一个指定的 GitHub 代码仓当作轻量文件盘使用的桌面客户端。

首次打开时填写一次代码仓、分支和可选根目录，连接成功后会自动保存，以后浏览和传输都无需重复配置。随包的 `repodrive.config.json` 仅用于提供可选初始值，不会锁定设置。不要把访问 Token 写入该文件。

桌面端使用可展开、折叠的目录树显示仓库内容。文件夹和文件使用不同图标，下载、重命名与删除操作也有独立图标；macOS 当前选中的目录会作为按钮上传目标并在界面中高亮显示。把文件或目录拖进整个文件框时，则固定上传到仓库根目录。

## 能力与安全边界

- macOS：桌面客户端支持浏览、下载、上传、重命名和删除文件及完整目录；目录保持原层级，不压缩，并支持拖放到根目录上传。
- Linux：CLI 和 Skill 支持浏览、下载、上传与重命名；桌面安装包暂未提供。
- Windows：独立的无上传构建，可浏览、下载、删除、清空文件和清除历史。安装包不包含 macOS 主程序、CLI、上传界面、上传处理器或上传请求。
- macOS、Windows 和 Linux CLI：都可指定 HTTP/HTTPS 代理。
- Token 使用 Electron `safeStorage` 加密后保存在当前用户的应用数据目录，不会写进代码仓。

RepoDrive 使用 GitHub API，因此单文件不能超过 100 MB。它适合文档、图片、压缩包和小型项目资料，不适合频繁同步或超大文件。一次选择或拖入的多个文件会合并为一个 Git commit；重命名会复制到新名称后删除旧名称，也会产生提交。

macOS 客户端还支持直接粘贴剪贴板图片或文字、勾选多个项目后一次提交删除，以及保留当前文件并将当前分支重置为单个根提交。历史重置类似 force push，需要输入完整仓库名并再次确认；它不会保证 GitHub 服务端立即物理擦除不可达对象。

桌面客户端的代理设置留空时会跟随操作系统代理；也可以填写 `http://127.0.0.1:端口` 来固定使用指定 HTTP/HTTPS 代理。

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
repodrive rename archive/photos photos-2026
repodrive list --json
```

也可以不设置 `REPODRIVE_TOKEN`；如本机已通过 GitHub CLI 登录，会自动读取 `gh auth token`。不要把 Token 写进命令参数或脚本。Windows 上 `upload` 和 `rename` 命令会在联网前直接拒绝。

`skill/repo-drive` 可安装为 Codex Skill。Release 中同时提供 Skill ZIP 和 CLI npm 包；使用可移植 Skill 前，请先全局安装对应的 CLI 包。

## 打包

```bash
npm run pack:mac
npm run pack:win
```

macOS 发布流程会在生成 DMG/ZIP 前封装并校验应用签名，随后重新挂载最终
DMG 做严格验签。公开构建没有 Apple Developer ID；首次打开时如 macOS 提示
无法验证开发者，请在 Finder 中右键 RepoDrive，选择“打开”。

Windows 安装包应当在 Windows 上构建。仓库附带 GitHub Actions 工作流；推送 `v*` tag 或手动运行后，会分别在 macOS 与 Windows 官方 runner 上生成安装包。也可运行 `npm run audit:win` 审计成品中的文件白名单、上传功能禁令和仅允许删除及限定清理操作的请求策略。

## 代理

在设置页填写如 `http://127.0.0.1:7890`。代理配置由 Electron 网络会话处理，并在连接测试前立即生效。

## 开发安全说明

Renderer 开启 context isolation 和 sandbox，并使用 Content Security Policy。所有 GitHub 请求、文件选择和本地写入都在主进程中执行。

## 排序与仓库清理

两端 GUI 在每一级目录内按最近上传/更新时间倒序显示，时间采用该路径最后一次提交的时间，同时间按名称排序。GitHub 不提供独立上传时间；每个路径首次加载需要额外查询提交记录，按分支快照缓存并限制并发。

- **清空全部文件**：删除已配置根目录内全部内容（根目录留空则清空当前分支），保留范围外文件，生成一个普通提交。旧内容仍在历史中。
- **清除历史（force push）**：保留当前文件，将整个当前分支重写为一个根提交；不受根目录设置限制。清除后旧上传时间无法保留。

两项操作都要求输入完整仓库名并再次确认，需要 Contents 写权限。历史重置可能被分支保护拒绝。请暂停其他人的推送；应用会检查分支是否变化，但 GitHub REST force 更新没有原子 force-with-lease 条件。其他分支、标签或 PR 可能引用旧对象，GitHub 不保证立即回收空间。
