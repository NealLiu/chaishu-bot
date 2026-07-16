# MD2Card API 调研报告

> 日期: 2026-07-16

## 结论

MD2Card **有正式 REST API**，不需要 Puppeteer 自动化。API 方案比浏览器自动化更稳定、更快、更省资源。

## API 端点

### POST `/api/generate` — 生成图片卡片

- **URL**: `https://md2card.cn/api/generate`
- **Method**: POST
- **Auth**: Header `x-api-key: <your_key>`
- **Content-Type**: application/json

### 请求参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| markdown | string | — | Markdown 文本 |
| theme | string | `"apple-notes"` | 主题 ID |
| width | number | 440 | 卡片宽度(px) |
| height | number | 586 | 卡片高度(px) |
| splitMode | string | `"noSplit"` | 分割模式: autoSplit/noSplit/hrSplit |

### 响应

```json
{
  "images": [
    {
      "url": "https://md2crad-1256585691.cos-website.ap-shanghai.myqcloud.com/screenshots/xxx.png",
      "fileName": "screenshots/xxx.png"
    }
  ]
}
```

### 可用主题（22+）

| 主题 | ID | 适合场景 |
|------|-----|---------|
| 苹果备忘录 | apple-notes | 通用 |
| 温暖柔和 | warm | 拆书推荐 ✅ |
| 紫色小红书 | xiaohongshu | 小红书发布 |
| 简约高级灰 | minimal | 专业 |
| 极简黑白 | minimalist | 干净 |
| 玻璃拟态 | glassmorphism | 现代 |
| +16 种 | ... | ... |

## 推荐方案

### 主方案: HTTP API 调用

```
Markdown → POST /api/generate → 获取图片 URL → 下载到本地
```

优势:
- 无需 Puppeteer (省 ~500MB Chromium)
- 速度快 (通常 5-15s)
- 稳定性高
- 支持 22+ 主题

### 降级方案: Puppeteer 浏览器自动化

当 API Key 未配置或 API 不可用时自动降级。

## API Key 获取

1. 访问 https://md2card.com/zh/my/api-keys
2. 注册/登录
3. 创建 API Key
4. 配置到 `.env`: `MD2CARD_API_KEY=xxx`

## 限制

- 请求超时: 60s
- 需要积分（免费额度待确认）
- 图片上传至腾讯云 COS，返回公网 URL

## 其他发现

- MCP Server: `npx md2card-mcp-server@latest`
- GitHub: https://github.com/maqi1520
- 微信草稿箱 API: `/api/wechat/convert-and-draft`
