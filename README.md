# Easy

这个仓库集中管理三个相互独立的实用工具。每个项目拥有自己的依赖、配置、数据存储和使用文档；不要在项目之间复用 Cloudflare D1/R2 资源或本地运行产物。

## 项目目录

### [EasyDrop](easydrop/)

基于 Cloudflare Workers 的跨设备文本与文件分享工具。提供隔离的多用户空间、管理员控制的注册与账号管理、文本分享、分片并发和断点续传、客户端 WebP 缩略图、限时免登录文件链接，以及带退避恢复的跨设备历史同步。D1 保存账号、文本和上传状态，私有 R2 保存原文件与可选缩略图。

技术栈：JavaScript、Cloudflare Workers、D1、R2。

本地运行先进入目录执行 `npm ci`、`npm run setup` 和 `npm run dev`；生产部署执行 `bash deploy.sh`，通过交互式 API Token 流程创建或复用 Worker、D1、私有 R2 和公开入口。

详细说明见 [EasyDrop README](easydrop/README.md)。

### [EasyNote](easynote/)

基于 Cloudflare Workers 的多用户自托管 Markdown 图片笔记应用。用户即租户，笔记、附件、离线缓存和 AI 令牌完全隔离；管理员可管理用户及审批注册。提供自动保存、任务中心、PWA Share Target 快速收集、Obsidian/Markdown 导入、带逐页预览的跨平台 PDF 导出、可撤销限时只读分享、私有图片、搜索、回收站、版本历史、完整离线笔记库和并发冲突保护，并适配桌面与移动端。

技术栈：React、TypeScript、CodeMirror、pdfmake、PDF.js、Cloudflare Workers、D1、R2。

本地使用只需进入目录运行 `bash dev.sh`；生产部署运行 `bash deploy.sh`。初始管理员、密码恢复和 Cloudflare 凭据均通过交互式流程处理。

详细说明见 [EasyNote README](easynote/README.md)。

### [EasyNews](easynews/)

用于新闻采集、关键词粗筛、语义判断校验、统计和 Excel 台账导出的纯 Python 工具。脚本负责准备全文分片、校验判断结果和导出，语义判断由当前 AI 会话完成，不内置或自动切换外部模型服务。

技术栈：Python 3.12、uv、Beautiful Soup、openpyxl。

详细说明见 [EasyNews README](easynews/README.md)。

## 使用

三个项目相互独立，所有命令都应在对应项目目录中执行：

- EasyDrop 和 EasyNote 需要 Node.js 22 或更新版本；部署凭据和初始账号均通过各自 README 规定的交互流程处理。
- EasyNews 需要 Python 3.12 和 uv，使用 `uv sync --locked` 安装依赖，不使用共享虚拟环境或系统 Python 直接运行。

具体启动、测试、部署、配置和安全边界以各项目 README 为准。
