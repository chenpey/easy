# EasyNewMac

当前版本：`0.1.3`

EasyNewMac 在旧 Mac 上扫描已安装应用，让用户搜索、筛选和选择需要迁移的项目，然后导出可在新 Mac 上运行的安装脚本。

工具由一个轻量本地启动器和本地网页组成，不需要安装应用、Xcode、开发者账号或额外运行环境。

## 使用

1. 保留完整的 `EasyNewMac` 文件夹。
2. 首次使用时，双击 `首次打开 EasyNewMac.command`。
3. 终端完成应用完整性校验后会打开 EasyNewMac；以后可直接双击 `EasyNewMac.app`。
4. 在自动打开的本地页面中选择项目并预览脚本。
5. 点击“下载迁移脚本”。
6. 将 ZIP 带到新 Mac，解压后双击 `EasyNewMac-Migration.command`。

EasyNewMac 没有使用 Apple Developer ID 公证，因为项目没有付费开发者账号。首次打开脚本会先使用 `codesign` 验证应用包内容和固定 Bundle ID，再只移除 `EasyNewMac.app` 自身的下载隔离标记；它不会关闭 Gatekeeper、修改系统安全设置或请求管理员权限。

若首次打开脚本也被系统阻止，请前往“系统设置 → 隐私与安全性”，在安全性区域选择“仍要打开”。这是 macOS 对所有未使用 Developer ID 公证的互联网下载软件的系统提示。

## 识别范围

EasyNewMac 扫描：

- `/Applications`
- `~/Applications`
- 当前 Homebrew 安装记录
- 应用的 App Store ID
- 随应用内置的 Homebrew Cask 离线目录

项目分为：

- Homebrew Cask：通过本机安装记录、应用包文件名精确匹配，或显示名与文件名同时匹配唯一的官方 Cask 名称。
- App Store：应用元数据中存在有效 App Store ID。
- 命令行工具：`brew leaves` 返回的顶层 Formula。
- 网页应用：通过 Chrome/Edge 的 `CrAppModeShortcutURL` 元数据识别，保留宿主浏览器和原地址。
- 手动安装：没有可靠自动安装来源的普通应用。

EasyNewMac 不做模糊猜测。只有唯一且完全一致的 `.app` 文件名，或显示名和文件名完全相同的唯一官方名称才会映射到 Cask；重名项仍进入手动安装提醒。网页应用单独显示，并在脚本中提示使用原浏览器重新添加。

## 安全与隐私

- 扫描、搜索、选择和脚本生成全部在本机完成。
- 页面不发起网络请求，也不上传应用清单。
- EasyNewMac 不执行安装，只导出脚本。
- 只有在新 Mac 上运行导出的脚本时才会联网。
- 仅选择手动安装项目时，脚本不包含 Homebrew、`curl` 或下载命令。
- 仅选择网页应用时，脚本只列出宿主浏览器和原地址，不尝试自动安装。
- 自动安装开始前必须输入完整确认词 `install apps`。
- 下载文件是 ZIP，确保解压后的 `.command` 保留可执行权限。

页面打开后，临时扫描目录会在 30 分钟后删除。页面已经读取的数据仍保留在当前标签页内，但此后不要刷新页面。

## 项目结构

源码与生成文件严格分开：

```text
easynewmac/
├── VERSION                  # 版本源，由根目录版本脚本维护
├── assets/                  # 图标 SVG 源文件
├── catalog/                 # 随应用分发的离线 Cask 映射
├── scripts/                 # 扫描、启动、构建和目录更新脚本
├── test/                    # Node.js 核心测试
├── web/                     # 完全离线的选择与脚本预览页面
├── build/                   # 本地中间产物，不提交
└── dist/                    # Release 产物，不提交
```

- `build/EasyNewMac.app` 是本机调试、试用的可运行应用。
- `dist/EasyNewMac-v<版本>.zip` 是唯一对外发布包，包含应用和 README。
- 发布包还包含 `首次打开 EasyNewMac.command`，仅用于下载后的第一次启动。
- `dist/*.sha256` 用于验证发布包完整性。
- `build/` 和 `dist/` 均由 Git 忽略，可随时删除并重建。

清理所有本地产物：

```bash
./scripts/build.zsh --clean
```

## 开发与测试

运行真实扫描但不打开浏览器：

```bash
./scripts/scan-preview.zsh /tmp/easynewmac-test
```

运行核心测试：

```bash
EASYNEWMAC_SCAN_FIXTURE=/tmp/easynewmac-test/data.js \
  node --test test/core.test.cjs
```

运行核心测试后重新构建：

```bash
./scripts/scan-preview.zsh /tmp/easynewmac-test
EASYNEWMAC_SCAN_FIXTURE=/tmp/easynewmac-test/data.js \
  node --test test/core.test.cjs
./scripts/build.zsh
```

构建只依赖 macOS 自带的 `osacompile`、`sips`、`iconutil` 和 `codesign`。Ad-hoc 签名不需要 Apple 开发者账号。

单独预览生成的 macOS 图标：

```bash
./scripts/generate-icon.zsh
```

更新内置 Cask 离线目录：

```bash
node scripts/update-cask-catalog.mjs
```

该开发命令从 Homebrew 官方 API 生成精简映射。用户扫描和页面使用过程不会联网。

## 版本与发布

版本由仓库根目录的 [`versions.json`](../versions.json) 统一管理：

```bash
node ../scripts/version.mjs bump easynewmac patch
node ../scripts/version.mjs check
```

推送 `easynewmac-v<版本>` 标签后，GitHub Actions 会在 macOS Runner 上重新测试和构建，并创建 GitHub Release：

```bash
git tag -a easynewmac-v0.1.0 -m "发布：EasyNewMac v0.1.0"
git push origin easynewmac-v0.1.0
```

Release 附件为版本化 ZIP 和对应的 SHA-256 文件，不使用或上传本地 `build/`、`dist/` 中的历史产物。
