# EasyNote AI 接入

EasyNote 通过本地 MCP stdio 桥接器让 AI 直接检索、读取和修改云端笔记：

```text
AI 客户端 → 本地 MCP 桥接器 → EasyNote Worker API → D1 / R2
PWA ───────────────────────────────────────────→ D1 / R2
```

MCP 桥接器不创建本地笔记副本。读取工具实时查询 EasyNote API，写入工具复用 PWA 的 revision、operationId、内容校验和历史版本逻辑。桥接器使用同一套 Node.js 代码，可运行于 macOS、Windows 和 Linux。

## 快速接入

AI 令牌表和版本审计字段属于 `0001_initial.sql` 基线；后续功能使用按序号命名的前向迁移。`bash dev.sh` 和 `bash deploy.sh` 会应用尚未执行的迁移，不要手工删除生产 D1 或本地 `.wrangler/state`。

### 1. 创建令牌

登录 EasyNote，打开“设置”，在“AI 接入”中填写：

- 名称：显示在令牌列表和历史版本中，例如“本机 Claude”。
- 权限：需要 AI 修改笔记时选择“读取和写入”，仅检索时选择“只读”。
- 有效期：30、90、365 天或永久。永久令牌会持续有效，直到用户主动撤销。

创建后立即复制令牌。明文令牌只显示一次，EasyNote 数据库仅保存 SHA-256 摘要。

### 2. 配置 MCP 桥接器

本机需要 Node.js 22.12 或更高版本。在 EasyNote 项目目录执行：

```bash
npm ci
npm run build
npm run ai:setup
```

安装程序交互式询问 EasyNote 地址和令牌，令牌输入不会回显，也不会进入 shell 历史。配置文件默认位置：

| 系统 | 路径 |
| --- | --- |
| macOS | `~/Library/Application Support/EasyNote/ai.json` |
| Windows | `%APPDATA%\EasyNote\ai.json` |
| Linux | `$XDG_CONFIG_HOME/easynote/ai.json`，未设置时使用 `~/.config/easynote/ai.json` |

macOS 和 Linux 上配置文件权限设置为 `0600`。Windows 使用当前用户配置目录继承的 ACL。

### 3. 连接 AI 客户端

`npm run ai:setup` 最后会输出可直接使用的 MCP 配置。通用结构如下：

```json
{
  "mcpServers": {
    "easynote": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/easynote/dist/ai/index.js",
        "mcp",
        "--config",
        "/absolute/path/to/ai.json"
      ]
    }
  }
}
```

路径必须使用绝对路径。保存配置并重启 AI 客户端后，应能看到以 `easynote_` 开头的工具。

## MCP 工具

所有读取都实时访问 EasyNote，不依赖本地索引。

| 工具 | 权限 | 用途 |
| --- | --- | --- |
| `easynote_search_notes` | 只读 | 按相关度搜索标题和正文，返回命中上下文、章节、行号和 Resource URI |
| `easynote_read_note` | 只读 | 按 ID 分段读取完整 Markdown |
| `easynote_read_notes` | 只读 | 按输入顺序批量读取最多 20 篇笔记 |
| `easynote_connection_status` | 只读 | 验证账号、令牌名称和权限 |
| `easynote_create_note` | 读写 | 创建笔记 |
| `easynote_update_note` | 读写 | 更新正文、标题、标签、置顶或归档状态 |
| `easynote_archive_note` | 读写 | 归档或取消归档 |
| `easynote_trash_note` | 读写 | 移入回收站 |

只读令牌不会注册写工具。MCP 不提供永久删除、账号管理、令牌管理或图片上传工具。

## MCP Resources

每篇笔记都可通过 `easynote://notes/{id}.md` 读取为 `text/markdown`。Resource 列表展示最近更新的正常和归档笔记，最多 100 篇；读取时实时访问 EasyNote API，不创建本地 Markdown 副本。搜索结果中的 `uri` 可直接交给支持 MCP Resources 的 AI 客户端。

## 建议的 AI 指令

```text
检索 EasyNote 时先调用 easynote_search_notes，根据 matches 判断相关性。
需要多篇正文时优先调用 easynote_read_notes；单篇超出限制时再用 easynote_read_note 和 nextOffset 继续读取。
也可直接读取搜索结果返回的 easynote:// Resource URI。
不要猜测笔记 ID 或 revision。
修改前使用 easynote_read_note 获取最新 revision，并将其作为 expected_revision。
遇到 409 冲突时停止写入，重新读取笔记并向用户说明差异。
笔记标题不带 #；正文顶级章节从 ## 开始。
删除只能使用 easynote_trash_note 移入回收站，不得尝试永久删除。
```

## 一致性与冲突

- 搜索使用 D1 FTS5 trigram 索引和 BM25 排序，标题完全匹配优先；再用参数化 `LIKE` 校验字面子串，避免把分词近似结果误当成命中。
- 中文、英文、代码标识符和带空格短语都支持连续子串检索；少于 3 个字符的查询自动回退到 `LIKE`，行为接近本地 `grep`。
- 搜索结果单页最多 20 篇，每篇返回最多 3 个命中上下文。
- 批量读取单次最多接收 20 个 UUID，并保持输入顺序。
- 完整正文按 ID 读取；单次 MCP 返回最多 50000 字符，可通过 `nextOffset` 继续读取。
- 更新、归档和移入回收站必须提交最近读取到的 `expected_revision`。
- 如果用户或其他 AI 已更新笔记，服务端返回 `409` 和当前版本，不会静默覆盖。
- AI 写入正常生成历史版本，并在 PWA 中标记为 `AI：<令牌名称>`。
- 网络失败返回完整 HTTP 方法、接口路径、状态和 JSON 正文，不静默重试写入。

## 安全边界

- 浏览器使用 HttpOnly Cookie、同源检查和 CSRF；AI 使用独立 Bearer 令牌，两者不混用。
- 创建令牌需要有效登录会话、同源请求和 CSRF 令牌；每个账号最多保留 10 个有效令牌。
- 令牌可以随时在 PWA 设置中撤销。
- MCP 使用本地 stdio，不监听本地 TCP 端口。
- 不要将 `ai.json` 或令牌提交到 Git，也不要把 MCP 配置交给不受信任的 AI 客户端。

## API

AI Bearer 令牌使用以下接口：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/integrations/status` | 验证令牌 |
| `GET /api/integrations/notes` | 搜索并返回命中上下文和 Resource URI |
| `GET /api/integrations/notes/batch?ids=:id1,:id2` | 批量读取完整笔记 |
| `GET /api/integrations/notes/:id` | 读取完整笔记 |
| `POST /api/integrations/notes/:id` | 创建笔记 |
| `PUT /api/integrations/notes/:id` | 按 revision 更新笔记 |

请求头：

```http
Authorization: Bearer enai_<64 hex characters>
```

写入正文与 PWA 使用相同结构：

```json
{
  "title": "示例笔记",
  "content": "## 正文",
  "tags": ["示例"],
  "pinned": false,
  "archived": false,
  "deletedAt": null,
  "revision": 3,
  "operationId": "550e8400-e29b-41d4-a716-446655440000"
}
```

## 故障排查

```bash
node dist/ai/index.js --help
node dist/ai/index.js mcp
```

- `401`：令牌无效、已过期或已撤销。
- `403`：令牌为只读，无法调用写入接口。
- `409`：笔记 revision 已变化，应重新读取后再决定是否修改。
- `410`：笔记已永久删除，不能通过旧 ID 重建。
- `Request timed out`：检查 EasyNote 地址和网络。

## MCP 评估数据

[`test/fixtures/ai-evaluation-notes.json`](../test/fixtures/ai-evaluation-notes.json) 提供固定测试笔记，
[`test/ai-evaluation.xml`](../test/ai-evaluation.xml) 包含 10 个只读问题。`npm run test:ai` 会把测试数据写入隔离运行时，并通过真实 MCP stdio 客户端检查命中摘要、单篇和批量读取、Resources、权限隔离和 revision 冲突。
