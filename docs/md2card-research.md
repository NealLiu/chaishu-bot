# MD2Card 调研记录

> 日期: 2026-07-15

## 基本信息
- 网站: https://md2card.com/zh/editor
- 性质: 免费在线工具，无需注册
- 功能: Markdown → 小红书风格知识卡片
- 模板: 20+ 种风格（紫色小红书、温暖柔和、简约高级灰、梦幻渐变、清新自然等）
- 输出格式: PNG, SVG, JPEG, PDF

## API 情况
- 未发现公开 REST API
- 需通过 Puppeteer 无头浏览器自动化 Web 端

## 自动化方案
- Puppeteer 打开编辑器 → CodeMirror.setValue() 填入内容 → 等待预览 → 触发导出按钮 → 下载 PNG
- 备用方案 1: 截取预览区 DOM 元素为 PNG
- 备用方案 2: 全页截图作为兜底

## 限制与注意事项
- 导出按钮的 DOM 选择器可能随网站更新而变化，需定期检查
- 免费版图片上传仅保存 7 天
- 建议每季度验证脚本可用性，检查 MD2Card 网站 DOM 结构是否变化

## 替代方案（如 MD2Card 不可用时）
1. **html2canvas + 自定义模板**: 本地 HTML 模板渲染 → html2canvas 截图 → PNG，完全可控
2. **Puppeteer 截图自定义 HTML**: 用 CSS 模拟小红书卡片样式，Puppeteer 截图
3. **Canvas API 手绘**: Node.js Canvas 库编程绘制卡片布局
