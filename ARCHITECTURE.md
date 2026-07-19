# 拆书 Bot 架构文档

> 版本: 2.0 · 更新: 2026-07-19

---

## 1. 系统概览

拆书 Bot 是一个**自动化知识拆解 + 飞书推送**系统。输入一本书名，DeepSeek AI 将其拆解为结构化知识卡片，归档到 Obsidian，同时推送飞书封面卡（含飞书文档链接）。

```
┌─────────────────────────────────────────────────────────────────────┐
│                         拆书 Bot 系统架构                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   ┌──────────┐     ┌───────────────┐     ┌──────────────────┐       │
│   │  飞书用户  │────▶│  WebSocket    │────▶│  handleFeishuMsg │       │
│   │  (@bot)   │◀────│  长连接 (SDK) │◀────│  指令解析/路由    │       │
│   └──────────┘     └───────────────┘     └────────┬─────────┘       │
│                                                    │                 │
│   ┌──────────┐     ┌───────────────┐               │                 │
│   │ HTTP API  │────▶│  http.create  │──────────────┘                 │
│   │  (curl)   │     │  Server(HTTP) │                                │
│   └──────────┘     └───────────────┘               │                 │
│                                                    ▼                 │
│                              ┌──────────────────────────────────┐   │
│                              │         processBook()             │   │
│                              │  ① DeepSeek API → 拆书 JSON       │   │
│                              │  ② fillTemplate() → Markdown      │   │
│                              │  ③ obsidianWrite() → Vault 归档   │   │
│                              │  ④ updatePreferences() → 偏好图谱 │   │
│                              │  ⑤ renderCards() → 封面 PNG       │   │
│                              │  ⑥ feishuUploadImage() → imageKey │   │
│                              │  ⑦ createFeishuDoc() → 文档链接   │   │
│                              │  ⑧ feishuPushCoverCard() → 推送   │   │
│                              └──────────────────────────────────┘   │
│                                                                      │
│   ┌──────────┐     ┌───────────────┐     ┌──────────────────┐       │
│   │ 每日调度  │────▶│  Scheduler    │────▶│  autoProcess()   │       │
│   │  (cron)   │     │  (setInterval)│     │  推荐 + 拆书      │       │
│   └──────────┘     └───────────────┘     └──────────────────┘       │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## 2. 项目结构

```
拆书/
├── ARCHITECTURE.md                     ← 本文档
├── README.md                           ← 用户文档
├── .env / .env.example                 ← 环境变量配置
│
├── prompts/                            ← AI Prompt 模板
│   ├── book-decompose-system.md        ← 拆书 System Prompt（JSON 输出规范）
│   └── recommendation-system.md       ← 推荐 System Prompt（选书策略）
│
├── templates/
│   └── 拆书模板.md                     ← Markdown 模板（Jinja 风格占位符）
│
├── scripts/                            ← 核心代码
│   ├── chaishu-server.js              ← 主服务器 ★
│   ├── recommendation-engine.js       ← 自生长偏好图谱引擎
│   ├── logger.js                       ← 结构化 JSON 日志
│   ├── md2card-render.js              ← 卡片渲染（API / Puppeteer）
│   ├── package.json                    ← 依赖声明
│   └── test-pipeline.sh               ← 集成测试
│
├── books/                              ← 拆书 Markdown 归档
│   ├── 书籍索引.md                     ← 偏好图谱 YAML + 已拆书单
│   └── YYYY-MM-DD-书名-chaishu.md     ← 拆书内容
│
├── cards/                              ← 生成的卡片 PNG（运行时产出）
│   └── 书名/                            ← 按书名分目录
│       ├── card_xxx_1.png              ← 封面图
│       ├── card_xxx_2.png              ← 内容页…
│       └── ...
│
└── preview-xhs-cards.html              ← 小红书卡片设计参考
```

## 3. 核心模块详解

### 3.1 chaishu-server.js — 主服务器

**职责**: 整个系统的中枢，负责 HTTP 服务、飞书长连接、消息路由、业务流程编排。

**端口**: `19876`（可通过 `CHAISHU_PORT` 配置）

**端点**:

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/chaishu` | 手动拆书 `{"book":"书名","author":"作者"}` |
| POST | `/auto` | 自动推荐 + 拆解 |
| POST | `/process` | n8n 兼容端点（支持自定义 prompt） |
| GET | `/health` | 健康检查 |
| POST | `/feishu-event` | 飞书事件订阅 URL 验证 |

**内部函数调用链**:

```
processBook(book, author)
  │
  ├── callDeepSeek(systemPrompt, userPrompt)
  │     └── httpPost(DEEPSEEK_URL, ...) → JSON content
  │
  ├── fillTemplate(parsed) → { markdown, file_name, date, ... }
  │
  ├── validateContent(markdown) → { ok, issues }
  │     └── (失败时自动重试一次)
  │
  ├── obsidianWrite(filePath, markdown)
  │     └── https.request(PUT, Obsidian Local REST API)
  │
  ├── updatePreferences(result)
  │     └── execSync(recommendation-engine.js update --file)
  │
  ├── renderCards(fileName) → [coverPng, ...]
  │     └── exec(md2card-render.js --render)
  │
  ├── feishuUploadImage(coverPng) → imageKey
  │     └── https.request(multipart, im/v1/images)
  │
  ├── createFeishuDoc(markdown) → docUrl
  │     ├── feishuDriveUpload() → fileToken
  │     ├── httpPost(import_tasks) → ticket
  │     ├── httpRequest(GET, import_tasks/{ticket}) → poll
  │     └── httpRequest(PATCH, permissions/{doc}/public)
  │
  └── feishuPushCoverCard(options) → 飞书封面卡
        └── fallback: feishuPushChunked(title, markdown)
```

**飞书消息处理**:

```
handleFeishuMessage(event)
  │
  ├── 帮助/指令 ──→ sendFeishuReply(chatId, 菜单文本)
  │
  ├── 拆了哪些书 ──→ getBookList() + sendFeishuReply(chatId, 书单)
  │
  ├── 再读《X》 ──→ findBook(X) + pushExistingBook(md, existing)
  │
  ├── 拆《X》(新) ──→ processBook(X) + sendFeishuReply(status)
  │
  ├── 拆《X》(已有)─→ pushExistingBook(md, existing)
  │
  └── 任意文字 ──→ callDeepSeek(讨论模式) + sendFeishuReply(chatId, reply)
```

### 3.2 recommendation-engine.js — 偏好图谱引擎

**职责**: 维护 `书籍索引.md` 中的 YAML 偏好图谱，每次拆书后自动更新。

**用法**:
```bash
node recommendation-engine.js read              # 输出当前偏好
node recommendation-engine.js update --file <path>  # 用拆书结果更新
```

**更新逻辑**:

```
updatePreferences(bookResult)
  │
  ├── 1. 在书籍索引表格中追加新行
  ├── 2. 更新 frontmatter 日期
  ├── 3. 合并标签权重 (已知 +0.3, 新标签 1.0)
  ├── 4. 更新 recent_focus (权重 top 3)
  ├── 5. 移除已覆盖的知识缺口
  ├── 6. 从关联推荐提取新缺口
  ├── 7. 更新阅读路径 (current_book + branches)
  ├── 8. 更新 book_count / depth_level
  └── 9. 写回 书籍索引.md
```

**深度层级**:
- `book_count ≤ 3` → 入门
- `book_count ≤ 10` → 进阶
- `book_count > 10` → 深入

### 3.3 md2card-render.js — 卡片渲染

**职责**: 将 Markdown 渲染为 1080×1440 像素的小红书风格卡片 PNG。

**方案**:
1. **主方案**: MD2Card REST API（需 `MD2CARD_API_KEY`）
2. **降级方案**: Puppeteer 本地渲染（全页 HTML → 截图切片）

**CLI**:
```bash
node md2card-render.js books/xxx.md cards/xxx/ --theme xiaohongshu --render
```

**渲染流程**:
```
markdown → buildHTML() → 1080px 流动长页 → Puppeteer.page.screenshot()
  ├── Page 0 (y=0):    封面 — 渐变背景 + 书名 + 一句话总结
  ├── Page 1 (y=1440): 知识点 1-2
  ├── Page 2 (y=2880): 知识点 3-5 + 金句 + 行动清单
  └── Page N:          ...
```

### 3.4 logger.js — 结构化日志

**职责**: 零依赖的 JSON 格式日志，`LOG_LEVEL` 环境变量控制级别。

**级别**: `debug < info < warn < error`

**格式**: `{"timestamp":"...","level":"info","message":"...","data":{...}}`

### 3.5 prompts/ — AI Prompt 模板

| 文件 | 用途 | 输出格式 |
|------|------|----------|
| `book-decompose-system.md` | 拆解书籍为结构化知识 | JSON (book_title, key_points[5], ...) |
| `recommendation-system.md` | 根据偏好图谱推荐下一本 | JSON (recommended_book, strategy, ...) |

## 4. 数据流

### 4.1 拆书全流程数据流

```
书名 "关键对话"
   │
   ▼
DeepSeek API ──────────────────────────────────────
  │ system: book-decompose-system.md
  │ user:   请拆解《关键对话》，作者 Kerry Patterson
  │ response_format: json_object
  │ model: deepseek-v4-pro
  ▼
parsed JSON
  { book_title, key_points[5], golden_quote, action_items[3], next_suggestions[3], ... }
   │
   ▼
fillTemplate(parsed) → Markdown (frontmatter + body)
   │
   ├─────────────────────────────┐
   ▼                             ▼
Obsidian REST API           formatForFeishu()
PUT /vault/books/xxx.md     (fallback only)
   │
   ▼
updatePreferences()
   │
   ▼
renderCards() → cover.png
   │
   ▼
feishuUploadImage() → img_xxx (image_key)
   │
   ▼
createFeishuDoc() → https://xxx.feishu.cn/docx/ABC
   ├── Drive upload → file_token
   ├── Import task → ticket → poll → doc_token
   └── Public permission (anyone with link)
   │
   ▼
feishuPushCoverCard(cover_image + doc_url)
   │
   ▼
飞书群聊: 封面卡 + 点击跳转飞书文档
```

### 4.2 飞书交互流程

```
用户: @bot 拆 《关键对话》
  → handleFeishuMessage()
    → 匹配正则: /^拆(?:书|解)?\s*[《]?(.+?)[》]?\s*$/
    → findBook("关键对话") → null (新书)
    → sendFeishuReply("🔍 正在拆解...")
    → processBook("关键对话", "")
    → sendFeishuReply("✅ 拆解完成！")

用户点击封面卡的「📖 阅读完整拆解」
  → 飞书客户端打开内嵌浏览器
  → 加载 https://xxx.feishu.cn/docx/ABC
  → 飞书原生文档阅读体验
```

## 5. 外部依赖

| 服务 | 用途 | API |
|------|------|-----|
| **DeepSeek** | AI 拆书 + 推荐 | `POST /chat/completions` |
| **Obsidian** | 知识库归档 | Local REST API `PUT /vault/{path}` |
| **飞书** | 消息推送 + 文档 | `im/v1/messages`, `drive/v1/*`, `auth/v3/*` |
| **MD2Card** | 卡片渲染 (可选) | `POST /api/generate` |
| **Puppeteer** | 本地卡片渲染 (降级) | `page.screenshot({ clip })` |

## 6. 环境变量

| 变量 | 必需 | 默认值 | 说明 |
|------|:---:|------|------|
| `DEEPSEEK_API_KEY` | ✅ | — | DeepSeek API Key |
| `OBSIDIAN_API_KEY` | ✅ | — | Obsidian Local REST API Key |
| `OBSIDIAN_API_URL` | — | `https://127.0.0.1:27124` | Obsidian API 地址 |
| `FEISHU_APP_ID` | 可选 | — | 飞书应用 ID |
| `FEISHU_APP_SECRET` | 可选 | — | 飞书应用密钥 |
| `FEISHU_CHAT_ID` | 可选 | — | 推送目标群聊 ID |
| `FEISHU_VERIFY_TOKEN` | 可选 | — | 事件订阅验证 token |
| `FEISHU_EVENT_ENCRYPT_KEY` | 可选 | — | 事件加密密钥 |
| `CHAISHU_PORT` | — | `19876` | 服务器端口 |
| `CHAISHU_DEBUG` | — | `false` | Debug 模式 |
| `SCHEDULE_CRON` | — | `0 8 * * *` | 每日自动推荐时间 |
| `LOG_LEVEL` | — | `info` | 日志级别 |
| `MD2CARD_API_KEY` | 可选 | — | MD2Card API Key |
| `MD2CARD_TEMPLATE` | — | `warm` | MD2Card 主题 |

## 7. 飞书后台配置

1. **开放平台** → 应用 → **事件订阅** → 开启「使用长连接接收事件」
2. 添加事件: `im.message.receive_v1`
3. **权限管理**:
   - `im:message:read_as_bot`
   - `im:message:send_as_bot`
   - `im:message.group_at_msg:readonly`
   - `drive:drive:import` (飞书文档创建)
   - `drive:drive:read` (读取文档信息)
4. **发布新版本**

## 8. 启动

```bash
cd scripts && npm install && node chaishu-server.js
```

## 9. 技术栈

- **Runtime**: Node.js ≥ 16
- **AI**: DeepSeek API (deepseek-v4-pro)
- **Event**: 飞书 SDK `@larksuiteoapi/node-sdk` WebSocket 长连接
- **Storage**: Obsidian Local REST API
- **Render**: Puppeteer + MD2Card API
- **Config**: `.env` 环境变量
- **Logging**: 自定义 JSON 结构化日志 (zero-dependency)
