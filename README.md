# 拆书工作流

基于 DeepSeek AI 的自动化拆书系统，支持飞书 Bot 交互、Obsidian 归档、偏好图谱自生长。

## 项目结构

```
拆书/
├── README.md                          ← 本文档
├── .env / .env.example                ← 环境变量配置
├── books/                             ← 拆书 Markdown 归档
│   ├── 书籍索引.md                     ← 偏好图谱 + 已拆书单
│   └── YYYY-MM-DD-书名-chaishu.md     ← 拆书内容
├── prompts/                           ← AI Prompt 模板
│   ├── book-decompose-system.md       ← 拆书 System Prompt
│   └── recommendation-system.md      ← 推荐 System Prompt
├── templates/
│   └── 拆书模板.md                     ← 拆书 Markdown 模板参考
├── scripts/                           ← 核心代码
│   ├── chaishu-server.js              ← 主服务器（HTTP + 飞书 + 调度）
│   ├── recommendation-engine.js      ← 自生长偏好图谱引擎
│   ├── logger.js                      ← 结构化 JSON 日志
│   ├── md2card-render.js              ← 卡片渲染（MD2Card API / Puppeteer）
│   └── test-pipeline.sh              ← 集成测试脚本
└── preview-xhs-cards.html             ← 小红书卡片设计参考
```

## 核心能力

### 1. AI 拆书

- 调用 DeepSeek API，将任意书籍拆解为结构化内容
- 输出：一句话总结、核心框架、5 个知识点（含关键洞见 + 实践建议）、金句、行动清单、关联推荐
- 自动审查内容质量，失败时重试

### 2. 飞书 Bot 交互（双向）

基于飞书 SDK `@larksuiteoapi/node-sdk` 长连接，支持：

| 指令 | 说明 |
|------|------|
| `拆 《书名》` | 触发拆书，已拆过的直接返回历史内容 |
| `拆了哪些书` | 查看历史书单 |
| `再读 《书名》` | 重新推送某本书，进入讨论模式 |
| `帮助` | 显示指令菜单 |
| 任意文字 | 基于当前书籍与 DeepSeek 深度讨论 |

- 群聊 @bot 消息自动剥离 @mention 前缀
- 消息去重（message_id），防止重复触发
- 支持多轮对话历史（最近 4 条）

### 3. 每日自动推荐

- 每天 8:00 根据偏好图谱自动推荐一本书
- 基于 DeepSeek 分析偏好图谱，智能选书
- `SCHEDULE_CRON` 环境变量可配置

### 4. Obsidian 归档

- 拆书结果写入 Obsidian vault（`books/` 目录）
- 使用 Obsidian Local REST API
- UTF-8 安全传输，无乱码

### 5. 自生长偏好图谱

- 每次拆书自动更新偏好：标签权重、知识缺口、阅读路径
- `书籍索引.md` 的 YAML 块记录完整图谱
- 表格自动追加已拆书单
- `book_count` 和 `depth_level` 自动计算

### 6. Debug 模式

- `CHAISHU_DEBUG=true`：只生成文档不推送飞书
- `CHAISHU_DEBUG=false`（默认）：完整功能

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/chaishu` | POST | 手动拆书 `{"book":"书名","author":"作者"}` |
| `/auto` | POST | 自动推荐 + 拆解 |
| `/process` | POST | n8n 兼容（支持自定义 system_prompt / user_prompt） |
| `/health` | GET | 健康检查 |
| `/feishu-event` | POST | 飞书事件订阅 URL 验证 |

## 环境变量

| 变量 | 必需 | 说明 |
|------|------|------|
| `DEEPSEEK_API_KEY` | ✅ | DeepSeek API Key |
| `OBSIDIAN_API_KEY` | ✅ | Obsidian Local REST API Key |
| `OBSIDIAN_API_URL` | ✅ | Obsidian API 地址 |
| `FEISHU_APP_ID` | 可选 | 飞书应用 ID |
| `FEISHU_APP_SECRET` | 可选 | 飞书应用密钥 |
| `FEISHU_CHAT_ID` | 可选 | 推送目标群聊 ID |
| `CHAISHU_PORT` | 可选 | 服务器端口（默认 19876） |
| `CHAISHU_DEBUG` | 可选 | Debug 模式（true/false） |
| `SCHEDULE_CRON` | 可选 | 每日推送时间（默认 0 8 * * *） |
| `LOG_LEVEL` | 可选 | 日志级别（debug/info/warn/error） |
| `MD2CARD_API_KEY` | 可选 | MD2Card 卡片渲染 API Key |
| `MD2CARD_TEMPLATE` | 可选 | MD2Card 主题 |

## 启动

```bash
cd scripts
npm install
node chaishu-server.js
```

## 测试

```bash
# 集成测试
bash scripts/test-pipeline.sh

# Debug 模式测试
CHAISHU_DEBUG=true node scripts/chaishu-server.js
curl -X POST http://127.0.0.1:19876/chaishu -d '{"book":"测试书名"}'
```

## 飞书后台配置

1. 开放平台 → 事件订阅 → 开启「使用长连接接收事件」
2. 添加事件：`im.message.receive_v1`
3. 权限管理：`im:message:read_as_bot`、`im:message:send_as_bot`、`im:message.group_at_msg:readonly`
4. 发布新版本

## 技术栈

- Node.js（零外部依赖，仅 puppeteer + ws + yaml + @larksuiteoapi/node-sdk）
- DeepSeek API（deepseek-v4-pro）
- Obsidian Local REST API
- 飞书 SDK 长连接
- MD2Card API（可选卡片渲染）

## 更新日志

- 2026-07-18：移除卡片图片生成，改为纯文字推送；新增指令系统、去重、飞书格式化
- 2026-07-17：修复 UTF-8 乱码、飞书长连接集成、偏好图谱表格自动写入、Debug 开关
- 2026-07-15：初始版本，n8n 工作流迁移为独立 Node.js 服务器
