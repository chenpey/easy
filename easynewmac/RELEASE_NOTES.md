## EasyNewMac 0.3.1

修复 App 内生成器的 shell 配置判断。请用新版 App 重新导出；旧迁移脚本不会自动更新。

- 删除 NVM_DIR 的字符串解析，由 zsh 读取最终生效的目录；兼容官方条件表达式、单引号、条件赋值与 ZDOTDIR。
- 真正的自定义 nvm 目录保持不变并明确提示。无法读取启动配置单独报告，不再误报目录冲突。
- 从基础 PATH、清除继承 nvm 变量的登录 shell 验证环境。Homebrew 缺少持久配置时追加对应 shellenv，再确认找到同一个 brew；重复运行不重复追加。
- Node 验收直接检查 shell 启动后的版本，不再提前执行 nvm use 掩盖启动配置的实际结果。
- 增加独立 shell 回归测试和可选的真实官方 nvm/LTS 联网安装测试。

保留默认 brew 升级、失败补装与重试、Node LTS、日志和 App Store 三态汇总。
发布包仍包含 EasyNewMac.app 和“首次使用.txt”。
