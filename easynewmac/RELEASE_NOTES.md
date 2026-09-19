## EasyNewMac 0.3.0

本次修复 App 内的迁移脚本生成器；下载新版 App 后重新导出，已有迁移脚本不会自动更新。

- 保留 Homebrew 默认升级。bundle 失败后补装缺失项目并重试一次，最终验证安装记录和 Brewfile；升级失败也会报告。
- Node / node@版本统一通过官方 nvm 安装最新 LTS 并设为默认版本。单选 nvm 只配置 nvm，不安装 Node。不再用 Homebrew 安装 nvm。
- 自动安装增加非 root、macOS 14+ 检查和持久日志；汇总验收通过、跳过和失败详情。
- 检查 nvm 环境变量、zsh 配置及 npm prefix/globalconfig 冲突；验收 Node LTS、npm 和新登录 shell。
- App Store 安装后验证记录，地区不可用单独汇总，网络或安装异常保留失败状态，并提示 Spotlight 排查。
- Brewfile、补装和验收共用源码中的项目清单；清理网页应用 utm_* 参数及问财临时 sign，保留功能参数。
- 修复仅手动提醒时的未初始化数组；不会自动接管已有同名 App。

发布包包含 EasyNewMac.app 和“首次使用.txt”。首次使用按说明在终端运行完整授权命令。
