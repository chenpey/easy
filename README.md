# Easy

这个仓库用于集中管理几个相互独立的实用工具。每个项目拥有自己的依赖、配置和使用文档。

## 项目目录

### [EasyDrop](easydrop/)

基于 Cloudflare Workers 的跨设备文本与文件分享工具。使用 D1 保存数据、R2 存储文件，并提供登录鉴权、限时免登录文件链接、历史记录、断点上传和用户管理功能。

技术栈：JavaScript、Cloudflare Workers、D1、R2。

详细说明见 [EasyDrop README](easydrop/README.md)。

### [EasyNote](easynote/)

基于 Cloudflare Workers 的自托管 Markdown 图片笔记应用。提供自动保存、私有图片、标签与搜索、回收站、版本历史、本地草稿恢复、冲突保护和 ZIP 导入导出，并适配桌面与移动端。

技术栈：React、TypeScript、CodeMirror、Cloudflare Workers、D1、R2。

本地使用只需进入目录运行 `bash dev.sh`；生产部署运行 `bash deploy.sh`。账号和 Cloudflare 凭据均通过交互式流程处理。

详细说明见 [EasyNote README](easynote/README.md)。

### [EasyNews](easynews/)

用于新闻采集、关键词粗筛、语义判断、统计和 Excel 台账导出的 Python 工具。

技术栈：Python 3.12、uv、Beautiful Soup、openpyxl。

详细说明见 [EasyNews README](easynews/README.md)。

## 使用

三个项目相互独立。进入对应目录后，按照该项目 README 中的说明安装依赖、运行测试或启动工具。
