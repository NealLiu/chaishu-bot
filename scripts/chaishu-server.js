#!/usr/bin/env node
/**
 * 拆书服务器 —— 替代 n8n 的独立方案
 *
 * 端点:
 *   POST /chaishu  — 手动指定一本书拆解 {"book":"书名","author":"作者"}
 *   POST /auto     — 自动推荐 + 拆解（基于偏好图谱）
 *   GET  /health   — 健康检查
 *
 * 启动: node chaishu-server.js
 */

const http = require('http');
const https = require('https');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// ── .env 加载 ──
function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    let value = trimmed.substring(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}
loadEnv(path.join(__dirname, '..', '.env'));

// ── 配置（全部从环境变量读取） ──
const PORT = parseInt(process.env.CHAISHU_PORT || '19876');
const VAULT = path.join(__dirname, '..');

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

const OBSIDIAN_URL = process.env.OBSIDIAN_API_URL || 'https://127.0.0.1:27124';
const OBSIDIAN_KEY = process.env.OBSIDIAN_API_KEY;

// 飞书配置（可选）
const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
const FEISHU_CHAT_ID = process.env.FEISHU_CHAT_ID;
const FEISHU_WEBHOOK = process.env.FEISHU_WEBHOOK;
const FEISHU_ENABLED = !!(FEISHU_APP_ID && FEISHU_APP_SECRET && FEISHU_CHAT_ID);

// 启动校验
function checkRequired() {
  const missing = [];
  if (!DEEPSEEK_KEY) missing.push('DEEPSEEK_API_KEY');
  if (!OBSIDIAN_KEY) missing.push('OBSIDIAN_API_KEY');
  if (missing.length > 0) {
    logger.error('缺少必需的环境变量', { missing });
    console.error(`❌ 请在 .env 文件中配置: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (!FEISHU_ENABLED) {
    logger.info('飞书推送未配置，跳过该功能');
  }
}

// ── Validation ──
function validateBookParams(input) {
  const errors = [];
  if (!input.book || typeof input.book !== 'string' || input.book.trim().length === 0) {
    errors.push('book 字段是必填的，且不能为空');
  } else if (input.book.trim().length > 200) {
    errors.push('book 字段长度不能超过 200 个字符');
  }
  const author = input.author ? String(input.author).trim() : '';
  if (author.length > 100) {
    errors.push('author 字段长度不能超过 100 个字符');
  }
  return { valid: errors.length === 0, errors, book: (input.book || '').trim(), author };
}

// ── JSON Repair ──
function repairJSON(raw) {
  let text = raw.trim();
  // Strip markdown code block wrappers
  text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
  // Remove trailing commas before } or ]
  text = text.replace(/,(\s*[}\]])/g, '$1');
  return text;
}

// ── HTTP helper ──
function httpPost(urlStr, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search,
      method: 'POST', headers, timeout: 120000 },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(bodyStr); req.end();
  });
}

// ── DeepSeek ──
async function callDeepSeek(systemPrompt, userPrompt) {
  if (!userPrompt.toLowerCase().includes('json')) userPrompt += '\n请以JSON格式输出。';
  const body = JSON.stringify({
    model: 'deepseek-v4-pro', temperature: 0.7, max_tokens: 8192,
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    response_format: { type: 'json_object' }
  });
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_KEY}` };
  const maxRetries = 2;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await httpPost(DEEPSEEK_URL, headers, body);
      const parsed = JSON.parse(resp);
      let content = parsed.choices[0].message.content;
      // Verify content is valid JSON; attempt repair if not
      try {
        JSON.parse(content);
      } catch {
        logger.warn('DeepSeek returned non-JSON content, attempting repair', { attempt, preview: content.slice(0, 100) });
        content = repairJSON(content);
        JSON.parse(content);
        logger.info('JSON repaired successfully');
      }
      return content;
    } catch (e) {
      lastError = e;
      if (attempt < maxRetries) {
        const delay = (attempt + 1) * 1000;
        logger.warn(`DeepSeek call failed, retrying`, { attempt: attempt + 1, delay_ms: delay, error: e.message });
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw new Error(`DeepSeek call failed after ${maxRetries + 1} attempts: ${lastError.message}`);
}

// ── Template ──
function fillTemplate(parsed) {
  const d = new Date().toISOString().split('T')[0];
  const kp = parsed.key_points || [], ai = parsed.action_items || [], ns = parsed.next_suggestions || [];

  const lines = [
    `---`, `title: "📖 《${parsed.book_title || ''}》——${parsed.one_line_summary || ''}"`,
    `author: ${parsed.author || ''}`, `category: ${parsed.category || ''}`,
    `tags: ${JSON.stringify(parsed.tags || [])}`, `date: ${d}`, `source: manual`,
    `next_suggestion: ${JSON.stringify(ns)}`, `---`, ``,
    `# 📖 《${parsed.book_title || ''}》——${parsed.one_line_summary || ''}`,
    ``, `> **为什么推荐这本书？** ${parsed.recommendation_reason || ''}`, ``,
    `---`, ``, `## 🎯 核心框架`, ``, `${parsed.core_framework || ''}`, ``,
    `---`, ``, `## 📌 五个核心知识点`, ``
  ];

  for (let i = 0; i < 5; i++) {
    const p = kp[i] || {};
    lines.push(`### ${i + 1}️⃣ ${p.title || ''}`, ``, p.content || '', ``,
      `> 🔑 **关键洞见：** ${p.insight || ''}`, ``,
      `🫁 **试试看：** ${p.practice || ''}`, ``);
  }

  lines.push(`---`, ``, `## 💎 一句话记住这本书`, ``, `> ${parsed.golden_quote || ''}`, ``,
    `---`, ``, `## 🛠️ 今日行动清单`, ``,
    ...ai.map(i => `- [ ] ${i}`), ``,
    `---`, ``, `## 📎 关联推荐`, ``,
    `| 方向 | 推荐书籍 | 为什么关联 |`, `|------|---------|-----------|`,
    ...ns.map(s => {
      const icon = s.direction === '横向拓展' ? '🔄 横向拓展' : s.direction === '深度延伸' ? '↗️ 深度延伸' : '➡️ 实用落地';
      return `| ${icon} | 《${s.book}》 | ${s.reason} |`;
    }), ``,
    `---`, ``, `*generated by 拆书工作流 · ${d}*`
  );

  const md = lines.join('\n');
  const safeName = (parsed.book_title || '未命名').replace(/[\\/:*?"<>|]/g, '-');
  return {
    markdown: md, file_name: `${d} 《${safeName}》拆书`, date: d,
    book_title: parsed.book_title, author: parsed.author,
    tags: parsed.tags, category: parsed.category, next_suggestions: ns
  };
}

// ── Obsidian ──
function obsidianWrite(filePath, content) {
  const esc = content.replace(/'/g, "'\\''");
  execSync(`curl -sk -X PUT "${OBSIDIAN_URL}/vault/${filePath}" -H "Authorization: Bearer ${OBSIDIAN_KEY}" -H "Content-Type: text/markdown" -d '${esc}'`,
    { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
}

// ── Preferences ──
function updatePreferences(result) {
  const payload = JSON.stringify({ book_title: result.book_title, tags: result.tags, category: result.category, next_suggestions: result.next_suggestions });
  execSync(`cd "${VAULT}" && node scripts/recommendation-engine.js update '${payload}'`,
    { encoding: 'utf-8', maxBuffer: 10485760 });
}

// ── Cards ──
function renderCards(fileName) {
  try { execSync(`cd "${VAULT}" && node scripts/md2card-render.js "books/${fileName}.md" "cards/"`,
    { encoding: 'utf-8', maxBuffer: 10485760, timeout: 60000 }); }
  catch (e) { logger.warn('Card render failed', { error: e.message, file: fileName }); }
}

// ── Feishu ──
let feishuToken = null, feishuExpiry = 0;
async function getFeishuToken() {
  if (!FEISHU_ENABLED) return null;
  if (feishuToken && Date.now() < feishuExpiry - 60000) return feishuToken;
  try {
    const d = await httpPost('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      { 'Content-Type': 'application/json' },
      JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }));
    const j = JSON.parse(d);
    if (j.code === 0) { feishuToken = j.tenant_access_token; feishuExpiry = Date.now() + (j.expire || 7200) * 1000; return feishuToken; }
  } catch (e) { logger.warn('飞书 token 获取失败', { error: e.message }); }
  return null;
}
async function feishuPush(title, markdown) {
  if (!FEISHU_ENABLED) return;
  const token = await getFeishuToken();
  const content = JSON.stringify({
    header: { title: { tag: 'plain_text', content: title }, template: 'blue' },
    elements: [{ tag: 'markdown', content: markdown.slice(0, 8000) }]
  });
  if (token) {
    try {
      await httpPost('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
        { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        JSON.stringify({ receive_id: FEISHU_CHAT_ID, msg_type: 'interactive', content }));
      logger.info('飞书推送成功');
      return;
    } catch (e) { logger.warn('飞书 App Bot 推送失败，降级', { error: e.message }); }
  }
  // 降级到 Webhook
  if (FEISHU_WEBHOOK) {
    try {
      await httpPost(FEISHU_WEBHOOK, { 'Content-Type': 'application/json' },
        JSON.stringify({ msg_type: 'interactive', card: { header: { title: { tag: 'plain_text', content: title }, template: 'blue' }, elements: [{ tag: 'markdown', content: markdown.slice(0, 8000) }] } }));
      logger.info('飞书 Webhook 推送成功');
    } catch (e) { logger.warn('飞书 Webhook 推送失败', { error: e.message }); }
  }
}

// ── Core: process one book ──
async function processBook(book, author, customPrompts) {
  const t0 = Date.now();
  let systemPrompt = customPrompts?.system_prompt;
  let userPrompt = customPrompts?.user_prompt;

  // 加载 prompt（如果未自定义或太短）
  if (!systemPrompt || systemPrompt.length < 10) {
    systemPrompt = fs.readFileSync(path.join(VAULT, 'prompts/book-decompose-system.md'), 'utf-8');
  }
  if (!userPrompt || userPrompt.length < 5) {
    userPrompt = `请拆解《${book}》，作者${author}。请严格按照 System Prompt 中定义的 JSON 格式输出中文结果。`;
  }

  logger.info('Processing book', { book, author });

  const dsStart = Date.now();
  const content = await callDeepSeek(systemPrompt, userPrompt);
  const dsDuration = Date.now() - dsStart;
  logger.info('DeepSeek call completed', { duration_ms: dsDuration });

  const parsed = JSON.parse(content);
  logger.info('Book parsed', { book_title: parsed.book_title, tags_count: parsed.tags?.length || 0 });

  const result = fillTemplate(parsed);
  logger.info('Template filled', { file_name: result.file_name });

  try {
    obsidianWrite(`books/${result.file_name}.md`, result.markdown);
    logger.info('Obsidian written');
  } catch (e) {
    logger.error('Obsidian write failed', { error: e.message, file: result.file_name });
    throw new Error(`写入 Obsidian 失败: ${e.message}。请确认 Obsidian 已启动并安装了 Local REST API 插件。`);
  }

  updatePreferences(result);
  logger.info('Preferences updated');

  renderCards(result.file_name);
  feishuPush(`📖 《${parsed.book_title}》· ${parsed.one_line_summary || ''}`, result.markdown);

  const totalDuration = Date.now() - t0;
  logger.info('Book processing completed', { book, total_duration_ms: totalDuration });
  return result;
}

// ── Auto recommend + process ──
async function autoProcess() {
  const prefsYaml = execSync(`cd "${VAULT}" && node scripts/recommendation-engine.js read`,
    { encoding: 'utf-8', maxBuffer: 10485760 });
  const prefs = JSON.parse(prefsYaml).preferences;

  // Use recommendation prompt to get next book
  const recPrompt = fs.readFileSync(path.join(VAULT, 'prompts/recommendation-system.md'), 'utf-8');
  const userPrompt = `请根据以下偏好图谱推荐下一本书：\n\`\`\`yaml\n${prefsYaml.slice(0, 5000)}\n\`\`\`\n\n请推荐一本适合用户当前阶段的书，输出 JSON 格式。`;
  const content = await callDeepSeek(recPrompt, userPrompt);
  const rec = JSON.parse(content);

  logger.info('Auto recommended', { book: rec.recommended_book, author: rec.author, strategy: rec.strategy });
  return processBook(rec.recommended_book, rec.author || '未知');
}

// ── HTTP Server ──
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const url = new URL(req.url, `http://localhost:${PORT}`);

  logger.info('Request received', { method: req.method, path: url.pathname });

  if (req.method === 'GET' && url.pathname === '/health') {
    return res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString(), feishu_enabled: FEISHU_ENABLED }));
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const input = JSON.parse(body);

        if (url.pathname === '/chaishu') {
          const v = validateBookParams(input);
          if (!v.valid) {
            logger.warn('Validation failed', { errors: v.errors });
            res.statusCode = 400;
            return res.end(JSON.stringify({ success: false, error: v.errors.join('; ') }));
          }
          const r = await processBook(v.book, v.author || '未知');
          return res.end(JSON.stringify({ success: true, ...r }));
        }

        if (url.pathname === '/auto') {
          const r = await autoProcess();
          return res.end(JSON.stringify({ success: true, ...r }));
        }

        if (url.pathname === '/process') {
          // n8n 兼容端点：支持自定义 system_prompt / user_prompt
          const v = validateBookParams(input);
          if (!v.valid) {
            logger.warn('Validation failed', { errors: v.errors });
            res.statusCode = 400;
            return res.end(JSON.stringify({ success: false, error: v.errors.join('; ') }));
          }
          const r = await processBook(v.book, v.author || '未知', {
            system_prompt: input.system_prompt,
            user_prompt: input.user_prompt
          });
          return res.end(JSON.stringify({ success: true, ...r }));
        }
      } catch (e) {
        logger.error('Request failed', { error: e.message, path: url.pathname });
        res.statusCode = 500;
        return res.end(JSON.stringify({ success: false, error: e.message }));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found' }));
    });
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ── Global Error Handlers ──
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { error: reason?.message || String(reason) });
});

checkRequired();
checkRequired();

server.listen(PORT, '127.0.0.1', () => {
  logger.info(`拆书服务器启动`, { port: PORT, url: `http://127.0.0.1:${PORT}`, feishu_enabled: FEISHU_ENABLED });
  console.log(`   手动拆书: curl -X POST http://127.0.0.1:${PORT}/chaishu -d '{"book":"书名","author":"作者"}'`);
  console.log(`   自动推荐: curl -X POST http://127.0.0.1:${PORT}/auto`);
  console.log(`   n8n 兼容: curl -X POST http://127.0.0.1:${PORT}/process -d '{"book":"书名","author":"作者","system_prompt":"...","user_prompt":"..."}'`);
  console.log(`   健康检查: curl http://127.0.0.1:${PORT}/health`);
});
