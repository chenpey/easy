# Easy Suite

Easy Suite 集中管理四个相互独立的实用工具。每个项目使用专属依赖、配置、数据存储和使用文档，Cloudflare D1/R2 资源与本地运行产物也分别管理。

## 版本

<!-- versions:start -->
| 项目 | 当前版本 |
| --- | --- |
| [EasyDrop](easydrop/) | `1.1.5` |
| [EasyNewMac](easynewmac/) | `0.1.4` |
| [EasyNote](easynote/) | `0.3.2` |
<!-- versions:end -->

## 项目目录

### [EasyDrop](easydrop/)

基于 Cloudflare Workers 的跨设备文本与文件分享工具。提供隔离的多用户空间、管理员控制的注册与账号管理、文本分享、分片并发和断点续传、客户端 WebP 缩略图、限时免登录文件链接，以及带退避恢复的跨设备历史同步。D1 保存账号、文本和上传状态，私有 R2 保存原文件与可选缩略图。

技术栈：JavaScript、Cloudflare Workers、D1、R2。

本地运行先进入目录执行 `npm ci`、`npm run setup` 和 `npm run dev`；生产部署执行 `bash deploy.sh`，通过交互式 API Token 流程创建或复用 Worker、D1、私有 R2 和公开入口。

详细说明见 [EasyDrop README](easydrop/README.md)。

### [EasyNote](easynote/)

基于 Cloudflare Workers 的多用户自托管 Markdown 图片笔记应用。用户即租户，笔记、附件、离线缓存和 AI 令牌完全隔离；管理员可管理用户及审批注册。提供自动保存、任务中心、Obsidian/Markdown 导入、带逐页预览的跨平台 PDF 导出、限时或永久只读分享及集中管理、私有图片、搜索、回收站、版本历史、默认开启的完整离线笔记库和并发冲突保护，并适配桌面与移动端。

技术栈：React、TypeScript、CodeMirror、pdfmake、PDF.js、Cloudflare Workers、D1、R2。

本地使用进入目录运行 `bash dev.sh`；生产部署运行 `bash deploy.sh`，通过一个交互式 Cloudflare API Token 自动发现账号并创建或复用 Worker、D1、私有 R2 和公开入口，公开入口支持 `workers.dev` 或自动绑定自定义域名。远程部署和维护使用一个限定到目标账号的 Cloudflare 自定义 API Token，由脚本在每次运行时通过终端隐藏读取，生命周期限定在当前进程。配置文件保存资源标识。1000 篇以内的个人笔记通常可落在 Workers、D1 和 R2 免费额度内，详细假设与权限图见子项目文档。

详细说明见 [EasyNote README](easynote/README.md)。

### [EasyNewMac](easynewmac/)

用于从旧 Mac 扫描 Homebrew、Mac App Store 和普通应用，让用户搜索、筛选并选择需要迁移的项目，预览后导出新 Mac 安装脚本。工具由无终端窗口的本地启动器和本地网页组成，不需要 Xcode、开发者账号或额外运行环境；扫描清单不上传，EasyNewMac 本身也不执行安装。

技术栈：AppleScript、Zsh、HTML、CSS、JavaScript。

详细说明见 [EasyNewMac README](easynewmac/README.md)。

### [EasyNews](easynews/)

用于新闻采集、关键词粗筛、语义判断校验、统计和 Excel 台账导出的纯 Python 工具。脚本负责准备全文分片、校验判断结果和导出，语义判断固定由当前 AI 会话完成。

技术栈：Python 3.12、uv、Beautiful Soup、openpyxl。

详细说明见 [EasyNews README](easynews/README.md)。

## 使用

四个项目相互独立，所有命令都应在对应项目目录中执行：

- EasyDrop 和 EasyNote 需要 Node.js 22 或更新版本；部署凭据和初始账号均通过各自 README 规定的交互流程处理。
- EasyNewMac 需要 macOS 13 或更新版本，解压发布包后双击 `EasyNewMac.app` 即可使用。
- EasyNews 需要 Python 3.12 和 uv，使用 `uv sync --locked` 创建并使用项目专属环境。

具体启动、测试、部署、配置和安全边界以各项目 README 为准。

## 版本管理

版本源文件是 [`versions.json`](versions.json)，不要直接修改各项目的版本文件、`package.json` 或 README 版本行。准备提交功能更新时，在仓库根目录执行：

```bash
node scripts/version.mjs bump easynote patch
# 或：node scripts/version.mjs bump easynewmac minor
node scripts/version.mjs check
```

脚本会同步项目的版本文件、`package.json`、锁文件、运行时版本、README 和根目录版本表。`patch` 适合兼容性修复，`minor` 适合新增功能，`major` 适合不兼容变更。随后使用带版本号的提交信息，例如 `发布：EasyNewMac v0.1.0`。

## 清空重建

仓库根目录的 `reset.sh` 用于清空 EasyNote 或 EasyDrop：

```bash
bash reset.sh easynote --local
bash reset.sh easydrop --local
bash reset.sh easynote --remote
bash reset.sh easydrop --remote
```

本地模式删除所选项目的 `.wrangler/state`，保留 `.dev.vars` 中的本地管理员配置，并提示清除对应浏览器站点数据。远程模式读取该项目的 `wrangler.deploy.json`，要求输入完整确认文本及隐藏的 Cloudflare API Token，然后删除 Worker、清空并重建同名 R2 bucket、重建 D1 Schema。完成后进入对应项目执行 `bash deploy.sh` 即可重新部署。

远程清理要求 R2 中的对象均由应用记录。若 bucket 中存在孤立对象，脚本会在删除 bucket 时停止；先在 Cloudflare Dashboard 对该 bucket 执行 **Empty Bucket**，再重新运行清理命令。
