# EasyNote 灾难恢复

## 三种导出

| 类型 | 内容 | 用途 |
| --- | --- | --- |
| 网页“导出 ZIP” | 当前笔记、回收站、引用文件 | 迁移和普通归档 |
| 网页“导出草稿” | 当前浏览器未同步草稿、已缓存引用文件 | 网络或同步异常时抢救本机内容 |
| `backup.sh` | 完整 D1、所有 D1 记录对应的 R2 对象 | 账号级灾难恢复 |

网页 ZIP 用于笔记迁移；完整账号、会话、AI 令牌哈希、历史版本和删除墓碑由 `backup.sh` 备份。

## 远程授权

所有带 `--remote` 的备份、预检、恢复和密码重置命令都要求交互式终端，并在每次运行时隐藏输入 Cloudflare 自定义 API Token。使用与部署相同的最小权限组合：目标账号范围内的 Workers Scripts (Edit)、D1 (Edit) 和 Workers R2 Storage (Edit)。

脚本在每次远程操作时通过终端隐藏读取 Token，Token 生命周期限定在本次运行。`wrangler.deploy.json` 保存 Account ID、Worker 名以及 D1/R2 资源标识。灾备和部署使用 Cloudflare API Token，EasyNote AI 集成令牌用于 MCP。

## 创建备份

生产备份：

```bash
bash backup.sh --remote
```

本地开发数据：

```bash
bash backup.sh --local
```

可使用 `--output DIR` 指定新的备份目录。脚本执行：

1. 通过 Wrangler 导出全部 D1 业务表 SQL；可重建的 FTS5 搜索索引不进入备份。
2. 从该 SQL 快照读取所有状态为 `ready` 的私有文件记录。
3. 按 `<user_id>/<file_id>` 下载对应 R2 对象。
4. 对照 D1 中的大小和 SHA-256 逐个校验。
5. 写入带数据库、迁移和对象校验值的 `manifest.json`。

备份包含密码验证器、会话哈希和 AI 令牌哈希，目录权限设为仅当前用户可读写。应将备份复制到加密、离线且有独立保留策略的位置。

## 恢复预检

先创建全新的 D1 和 R2 资源，并写入独立的 `wrangler.deploy.json`，恢复目标保持为空。

```bash
bash restore.sh /path/to/easynote-backup --remote --check
```

预检只读执行以下检查：

- 清单、D1 SQL、当前全部迁移和全部 R2 对象哈希一致。
- 目标 D1 尚未初始化，或已有完整但无数据的 EasyNote Schema。
- 目标 D1 的账号、笔记和文件记录数均为零。
- 备份将写入的每一个 R2 Key 在目标桶中都不存在。

全部条件通过后才能进入正式恢复。

## 执行恢复

```bash
bash restore.sh /path/to/easynote-backup --remote
```

输入确认文本后，脚本会在需要时依次应用当前迁移，重新检查目标为空，先恢复 R2 对象，再导入 D1 数据。笔记导入时会自动重建全文索引。中途失败时保留输出用于排查，并对新的空资源重新执行恢复。

恢复后应立即：

1. 运行 `bash reset-password.sh --remote`。
2. 重新创建仍需使用的 AI 令牌。
3. 登录网页，抽查笔记、历史版本、图片和附件。
4. 再创建一份新的灾备并执行 `--check`。

## 恢复演练

正式上线前至少完成一次隔离恢复：

1. 创建临时 D1 和私有 R2 桶。
2. 为临时资源生成独立配置。
3. 对最新备份运行恢复预检。
4. 执行恢复并部署临时 Worker。
5. 核对 D1 各表数量、R2 对象数量及代表性文件。
6. 完成后删除临时 Worker、D1 和 R2。

Cloudflare 资源由管理员显式创建、删除和切换；远程备份按管理员设定的周期执行并离线保管。
