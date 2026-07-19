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
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const Lark = require('@larksuiteoapi/node-sdk');
const logger = require('./logger');
const { validateBookParams, repairJSON, fillTemplate, validateContent, formatForFeishu, formatXHS } = require('./lib/chaishu-core.js');

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

// Debug 模式：生成文档和卡片，但不推送飞书
const DEBUG_MODE = process.env.CHAISHU_DEBUG === 'true';

// 飞书事件订阅（接收消息）
const FEISHU_VERIFY_TOKEN = process.env.FEISHU_VERIFY_TOKEN || '';
const FEISHU_EVENT_ENCRYPT_KEY = process.env.FEISHU_EVENT_ENCRYPT_KEY || '';

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

// ── HTTP helpers ──
function httpRequest(urlStr, method, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search,
      method, headers, timeout: 120000 },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function httpPost(urlStr, headers, bodyStr) {
  return httpRequest(urlStr, 'POST', headers, bodyStr);
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

// ── Obsidian ──
function obsidianWrite(filePath, content) {
  return new Promise((resolve, reject) => {
    // Encode each path segment separately to preserve / separators
    const encodedPath = filePath.split('/').map(s => encodeURIComponent(s)).join('/');
    const body = Buffer.from(content, 'utf-8');
    const u = new URL(OBSIDIAN_URL);
    const req = https.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `/vault/${encodedPath}`, method: 'PUT', timeout: 30000,
      headers: {
        'Authorization': `Bearer ${OBSIDIAN_KEY}`,
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Length': String(body.length)
      },
      rejectUnauthorized: false
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`Obsidian 返回 ${res.statusCode}: ${d.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('写入 Obsidian 超时')); });
    req.write(body);
    req.end();
  });
}

// ── Preferences ──
function updatePreferences(result, source) {
  const payload = JSON.stringify({
    book_title: result.book_title, author: result.author,
    tags: result.tags, category: result.category,
    next_suggestions: result.next_suggestions,
    date: result.date, source: source || 'manual'
  });
  // Write to temp file to avoid shell escaping UTF-8 corruption
  const tmpFile = path.join(VAULT, '.prefs-tmp.json');
  fs.writeFileSync(tmpFile, payload, 'utf-8');
  execSync(`cd "${VAULT}" && node scripts/recommendation-engine.js update --file "${tmpFile}"`,
    { encoding: 'utf-8', maxBuffer: 10485760 });
  try { fs.unlinkSync(tmpFile); } catch {}
}

// ── Cards ──
async function renderCards(fileName, safeName) {
  const cardsDir = path.join(VAULT, 'cards', safeName || fileName);
  if (!fs.existsSync(cardsDir)) fs.mkdirSync(cardsDir, { recursive: true });
  return new Promise((resolve) => {
    exec(`cd "${VAULT}" && node scripts/md2card-render.js "books/${fileName}.md" "cards/${safeName || fileName}/" --theme xiaohongshu --render --verbose`,
      { encoding: 'utf-8', maxBuffer: 10485760, timeout: 300000 },
      (error, stdout) => {
        if (error) {
          logger.warn('Card render failed', { error: error.message, file: fileName });
          resolve([]);
          return;
        }
        logger.info('Card render output', { output: stdout.trim().slice(0, 500) });
        try {
          const files = fs.readdirSync(cardsDir).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f)).sort();
          const paths = files.map(f => path.join(cardsDir, f));
          logger.info('Card images found', { count: paths.length, dir: cardsDir });
          resolve(paths);
        } catch { resolve([]); }
      });
  });
}

// ── Feishu Image Upload (native multipart via https) ──
function feishuUploadImage(imagePath, token) {
  return new Promise((resolve) => {
    try {
      if (!fs.existsSync(imagePath)) {
        logger.warn('Image not found', { path: imagePath });
        return resolve(null);
      }
      const stat = fs.statSync(imagePath);
      if (stat.size === 0 || stat.size > 10 * 1024 * 1024) {
        logger.warn('Image invalid size', { size: stat.size });
        return resolve(null);
      }

      const imageBuffer = fs.readFileSync(imagePath);
      const fileName = path.basename(imagePath);
      const boundary = '----FeishuBoundary' + Math.random().toString(36).slice(2);

      // Build multipart body
      const header = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="image_type"\r\n\r\nmessage\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${fileName}"\r\nContent-Type: image/png\r\n\r\n`
      );
      const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([header, imageBuffer, footer]);

      const u = new URL('https://open.feishu.cn/open-apis/im/v1/images');
      const req = https.request({
        hostname: u.hostname, path: u.pathname,
        method: 'POST', timeout: 30000,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.length)
        }
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const j = JSON.parse(d);
            if (j.code === 0 && j.data?.image_key) {
              logger.info('Feishu image uploaded', { image_key: j.data.image_key });
              resolve(j.data.image_key);
            } else {
              logger.warn('Feishu upload failed', { code: j.code, msg: j.msg });
              resolve(null);
            }
          } catch (e) {
            logger.warn('Feishu upload parse error', { response: d.slice(0, 200) });
            resolve(null);
          }
        });
      });

      req.on('error', (e) => { logger.warn('Feishu upload error', { error: e.message }); resolve(null); });
      req.on('timeout', () => { req.destroy(); logger.warn('Feishu upload timeout'); resolve(null); });
      req.write(body);
      req.end();
    } catch (e) {
      logger.warn('Feishu upload exception', { error: e.message });
      resolve(null);
    }
  });
}

// ── Feishu Drive Upload（上传 Markdown 到飞书云盘）──
function feishuDriveUpload(fileName, content, token) {
  return new Promise((resolve, reject) => {
    const buffer = Buffer.from(content, 'utf-8');
    const boundary = '----FeishuBoundary' + Math.random().toString(36).slice(2);

    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file_name"\r\n\r\n${fileName}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="parent_type"\r\n\r\nexplorer\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="parent_node"\r\n\r\n\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\n${buffer.length}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${encodeURIComponent(fileName)}"\r\nContent-Type: text/plain\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, buffer, footer]);

    const u = new URL('https://open.feishu.cn/open-apis/drive/v1/files/upload_all');
    const req = https.request({
      hostname: u.hostname, path: u.pathname,
      method: 'POST', timeout: 30000,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length)
      }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.code === 0 && j.data?.file_token) {
            logger.info('Feishu drive upload ok', { file_token: j.data.file_token, url: j.data.url });
            resolve({ file_token: j.data.file_token, url: j.data.url });
          } else {
            reject(new Error(`Drive upload failed: ${j.msg || j.code} — ${d.slice(0, 200)}`));
          }
        } catch (e) { reject(new Error(`Drive upload parse error: ${d.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Drive upload timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Create Feishu Share Link from Markdown ──
async function createFeishuDoc(markdown, fileName) {
  const token = await getFeishuToken();
  if (!token) throw new Error('No Feishu token');

  // Strip frontmatter and format for clean reading
  let cleanMd = formatForFeishu(markdown);

  // Upload as text file (Feishu Drive renders .txt cleanly, .md shows raw symbols)
  const { url: docUrl } = await feishuDriveUpload(fileName + '.txt', cleanMd, token);

  logger.info('Feishu share link created', { doc_url: docUrl });
  return docUrl;
}

// ── Feishu Cover Card Push ──
async function feishuPushCoverCard({ title, book_title, one_line_summary, author, category, date, doc_url, markdown }) {
  if (DEBUG_MODE) { logger.info('Debug mode: skip cover card', { title, doc_url }); return; }
  if (!FEISHU_ENABLED) return;

  const token = await getFeishuToken();
  if (!token) { logger.warn('Cover card skipped — no token'); return; }

  if (doc_url) {
    const card = JSON.stringify({
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: title },
        template: 'carmine'
      },
      elements: [
        {
          tag: 'markdown',
          content: `**${one_line_summary || ''}**\n${[author, category, date].filter(Boolean).join(' · ')}`
        },
        { tag: 'hr' },
        {
          tag: 'action',
          layout: 'flow',
          actions: [{
            tag: 'button',
            text: { tag: 'lark_md', content: '📖 **阅读完整拆解**' },
            url: doc_url,
            type: 'primary'
          }]
        }
      ],
      card_link: {
        url: doc_url,
        pc_url: doc_url,
        ios_url: doc_url,
        android_url: doc_url
      }
    });

    try {
      await httpPost('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
        { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        JSON.stringify({ receive_id: FEISHU_CHAT_ID, msg_type: 'interactive', content: card }));
      logger.info('Cover card sent', { title, doc_url });
    } catch (e) {
      logger.warn('Cover card push failed, falling back to markdown', { error: e.message });
      const feishuText = formatForFeishu(markdown || '');
      if (feishuText) await feishuPushChunked(title, feishuText, token);
    }
    return;
  }

  // Fallback: no doc URL → use old markdown chunked approach
  logger.info('Cover card fallback to markdown (no doc URL)');
  const feishuText = formatForFeishu(markdown || '');
  if (feishuText) await feishuPushChunked(title, feishuText, token);
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
async function feishuPushChunked(title, markdown, token) {
  if (!token) token = await getFeishuToken();
  if (!token) { logger.warn('飞书推送跳过 — 无 token'); return; }

  // Send markdown as interactive card (max ~7500 chars per card)
  const MAX = 7200;
  const chunks = [];
  let r = markdown;
  while (r.length > MAX) {
    let s = r.lastIndexOf('\n---\n', MAX); if (s === -1) s = r.lastIndexOf('\n## ', MAX); if (s === -1) s = MAX;
    chunks.push(r.slice(0, s)); r = r.slice(s);
  }
  if (r.trim()) chunks.push(r);

  for (let i = 0; i < chunks.length; i++) {
    try {
      const card = JSON.stringify({
        header: { title: { tag: 'plain_text', content: i === 0 ? title : `${title} (${i+1}/${chunks.length})` }, template: 'carmine' },
        elements: [{ tag: 'markdown', content: chunks[i] }]
      });
      await httpPost('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
        { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        JSON.stringify({ receive_id: FEISHU_CHAT_ID, msg_type: 'interactive', content: card }));
      logger.info(`飞书推送成功 ${i+1}/${chunks.length}`);
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 300));
    } catch (e) { logger.warn('飞书推送失败', { chunk: i, error: e.message }); }
  }
}

// ── Core: process one book ──
async function processBook(book, author, customPrompts, source) {
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

  // Self-review
  const review = validateContent(result.markdown, parsed.book_title);
  if (!review.ok) {
    logger.error('Content review failed, regenerating...', { book, issues: review.issues });
    // Retry once with explicit JSON instruction
    const retryContent = await callDeepSeek(systemPrompt, userPrompt + '\n请确保输出完整的JSON，所有字段必须填写，不要截断。');
    const retryParsed = JSON.parse(retryContent);
    const retryResult = fillTemplate(retryParsed);
    const retryReview = validateContent(retryResult.markdown, retryParsed.book_title);
    if (!retryReview.ok) {
      logger.error('Content review failed after retry, using best effort', { issues: retryReview.issues });
    }
    // Use retry result
    Object.assign(result, retryResult);
    Object.assign(parsed, retryParsed);
  }

  try {
    await obsidianWrite(`拆书/books/${result.file_name}.md`, result.markdown);
    logger.info('Obsidian written');
  } catch (e) {
    logger.error('Obsidian write failed', { error: e.message, file: result.file_name });
    throw new Error(`写入 Obsidian 失败: ${e.message}。请确认 Obsidian 已启动并安装了 Local REST API 插件。`);
  }

  updatePreferences(result, source || 'manual');
  logger.info('Preferences updated');

  // Create Feishu doc and push cover card
  const pushTitle = `📖 《${parsed.book_title}》· ${parsed.one_line_summary || ''}`;

  let docUrl = null;

  // Create Feishu doc from markdown (upload + share)
  if (FEISHU_ENABLED && !DEBUG_MODE) {
    try {
      docUrl = await createFeishuDoc(result.markdown, result.file_name);
      logger.info('Feishu doc created', { doc_url: docUrl });
    } catch (e) { logger.warn('Feishu doc creation failed', { error: e.message }); }
  }

  // Push cover card (or fallback to chunked markdown)
  await feishuPushCoverCard({
    title: pushTitle,
    book_title: parsed.book_title,
    one_line_summary: parsed.one_line_summary,
    author: parsed.author,
    category: parsed.category,
    date: result.date,
    doc_url: docUrl,
    markdown: result.markdown
  });

  // Update current book for Feishu conversation context
  currentBook = {
    title: result.book_title,
    author: result.author,
    markdown: result.markdown,
    key_points: (result.markdown.match(/### \d️⃣ (.+)/g) || []).map(k => k.replace(/### \d️⃣ /, ''))
  };

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
  return processBook(rec.recommended_book, rec.author || '未知', null, 'auto');
}

// ── Re-push existing book with cover card ──
async function pushExistingBook(md, existing) {
  const pushTitle = `📖 《${existing.title}》· ${existing.date || '回顾'}`;

  // Parse frontmatter for metadata
  let bookTitle = existing.title;
  let summary = '';
  let author = existing.author;
  let category = '';
  let date = existing.date || '';
  try {
    const fmMatch = md.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const am = fmMatch[1].match(/^author:\s*(.+)$/m);
      if (am) author = am[1].trim();
      const cm = fmMatch[1].match(/^category:\s*(.+)$/m);
      if (cm) category = cm[1].trim();
      const tm = fmMatch[1].match(/^title:\s*"(.+)"$/m);
      if (tm) {
        const titleMatch = tm[1].match(/《(.+?)》(?:——|·)\s*(.+)/);
        if (titleMatch) { bookTitle = titleMatch[1]; summary = titleMatch[2] || ''; }
      }
    }
  } catch {}

  let docUrl = null;

  // Create Feishu doc from markdown
  if (FEISHU_ENABLED && !DEBUG_MODE) {
    try {
      docUrl = await createFeishuDoc(md, existing.title);
      logger.info('Re-push Feishu doc created', { doc_url: docUrl });
    } catch (e) { logger.warn('Re-push Feishu doc creation failed', { error: e.message }); }
  }

  // Push cover card
  await feishuPushCoverCard({
    title: pushTitle,
    book_title: bookTitle,
    one_line_summary: summary,
    author,
    category,
    date,
    doc_url: docUrl,
    markdown: md
  });
}

// ── Feishu Message Handler ──
let currentBook = null;
const seenMessages = new Set();
const chatHistory = new Map();

// ── Book index helpers ──
function getBookList() {
  try {
    const indexPath = path.join(VAULT, 'books', '书籍索引.md');
    const content = fs.readFileSync(indexPath, 'utf-8');
    const rows = content.match(/^\| (\d{4}-\d{2}-\d{2}) \| 《(.+?)》 \| (.+?) \| (.+?) \| (.+?) \|$/gm);
    if (!rows) return [];
    return rows.map(r => {
      const m = r.match(/^\| (\d{4}-\d{2}-\d{2}) \| 《(.+?)》 \| (.+?) \| (.+?) \| (.+?) \|$/);
      return { date: m[1], title: m[2], author: m[3].trim(), category: m[4].trim(), source: m[5].trim() };
    });
  } catch { return []; }
}

function findBook(bookName) {
  const list = getBookList();
  // Fuzzy match: exact match first, then partial match
  let found = list.find(b => b.title === bookName);
  if (!found) found = list.find(b => b.title.includes(bookName) || bookName.includes(b.title));
  if (!found) {
    // Also check filesystem for book files
    try {
      const booksDir = path.join(VAULT, 'books');
      const files = fs.readdirSync(booksDir).filter(f => f.endsWith('-chaishu.md'));
      for (const f of files) {
        const name = f.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/-chaishu\.md$/, '');
        if (name.includes(bookName) || bookName.includes(name)) {
          const md = fs.readFileSync(path.join(booksDir, f), 'utf-8');
          const fmMatch = md.match(/^---\n([\s\S]*?)\n---/);
          let author = '';
          if (fmMatch) {
            const am = fmMatch[1].match(/^author:\s*(.+)$/m);
            if (am) author = am[1].trim();
          }
          found = { title: name, author, date: f.slice(0, 10), path: path.join(booksDir, f) };
          break;
        }
      }
    } catch {}
  }
  if (found && !found.path) {
    found.path = path.join(VAULT, 'books', `${found.date}-${found.title}-chaishu.md`);
  }
  return found || null;
}

async function sendFeishuReply(chatId, text) {
  if (DEBUG_MODE) { logger.info('Debug mode: skip Feishu reply', { text: text.slice(0, 50) }); return; }
  const token = await getFeishuToken();
  if (!token) return;
  const content = JSON.stringify({ text });
  try {
    await httpPost('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      JSON.stringify({
        receive_id: chatId,
        msg_type: 'text',
        content
      }));
    logger.info('Feishu reply sent', { chatId, text: text.slice(0, 50) });
  } catch (e) {
    logger.warn('Feishu reply failed', { error: e.message });
  }
}

async function handleFeishuMessage(event) {
  try {
    const msg = event?.message;
    if (!msg || msg.message_type !== 'text') return;

    // Dedup by message_id to prevent double processing
    if (msg.message_id) {
      if (seenMessages.has(msg.message_id)) return;
      seenMessages.add(msg.message_id);
      if (seenMessages.size > 1000) seenMessages.clear();
    }

    const chatId = msg.chat_id;
    let text = (JSON.parse(msg.content || '{}')).text || '';
    // Strip @bot mentions
    text = text.replace(/@_\w+_\d+\s*/g, '').trim();
    logger.info('Feishu message received', { text: text.slice(0, 100), chatId });

    // ── Command 0: 帮助 / 指令查询 ──
    if (/^(帮助|指令|功能|help|菜单|使用|怎么用|能做什么)/.test(text)) {
      await sendFeishuReply(chatId, `📖 **拆书 Bot 指令**\n\n🔹 **拆 《书名》** — 拆解新书（已拆过的直接返回）\n🔹 **拆了哪些书** — 查看历史书单\n🔹 **再读 《书名》** — 重新推送某本书\n🔹 **任意文字** — 与当前书深度讨论\n🔹 **帮助** — 显示本菜单`);
      return;
    }

    // ── Command 1: 查询历史书单 ──
    if (/^(拆了哪些书|历史(记录|书单)?|书籍列表|已拆书(籍|单)?|书单)$/.test(text)) {
      const bookList = getBookList();
      if (bookList.length === 0) {
        await sendFeishuReply(chatId, '📚 还没有拆过任何书，发送「拆 书名」开始吧！');
      } else {
        const listText = bookList.map((b, i) => `${i + 1}. 《${b.title}》 — ${b.author} (${b.date})`).join('\n');
        await sendFeishuReply(chatId, `📚 已拆书籍 (${bookList.length} 本)：\n\n${listText}\n\n发送「再读 《书名》」回顾任意一本`);
      }
      return;
    }

    // ── Command 2: 回顾已拆书籍 ──
    const revisitMatch = text.match(/^(?:再(?:读|发|看|拆)|回顾|复习)\s*[《]?(.+?)[》]?\s*$/);
    if (revisitMatch) {
      const bookName = revisitMatch[1].trim();
      const existing = findBook(bookName);
      if (!existing) {
        await sendFeishuReply(chatId, `❌ 还没拆过《${bookName}》，发送「拆 ${bookName}」来拆解它吧`);
        return;
      }
      await sendFeishuReply(chatId, `📖 回顾《${existing.title}》...`);
      // Re-push with cover card
      const md = fs.readFileSync(existing.path, 'utf-8');
      pushExistingBook(md, existing);
      // Set as current book for discussion
      currentBook = {
        title: existing.title,
        author: existing.author,
        markdown: md,
        key_points: (md.match(/### \d️⃣ (.+)/g) || []).map(k => k.replace(/### \d️⃣ /, ''))
      };
      chatHistory.set(chatId, []);
      await sendFeishuReply(chatId, `✅ 已重新推送《${existing.title}》，现在可以继续讨论这本书了～`);
      return;
    }

    // ── Command 3: 拆书（带去重）──
    const chaishuMatch = text.match(/^拆(?:书|解)?\s*[《]?(.+?)[》]?\s*$/);
    if (chaishuMatch) {
      const bookName = chaishuMatch[1].trim();
      const existing = findBook(bookName);
      if (existing) {
        // Already deconstructed — return existing content
        await sendFeishuReply(chatId, `⚠️ 《${existing.title}》已拆过（${existing.date}），直接推送已有内容...`);
        const md = fs.readFileSync(existing.path, 'utf-8');
        pushExistingBook(md, existing);
        currentBook = {
          title: existing.title,
          author: existing.author,
          markdown: md,
          key_points: (md.match(/### \d️⃣ (.+)/g) || []).map(k => k.replace(/### \d️⃣ /, ''))
        };
        chatHistory.set(chatId, []);
        await sendFeishuReply(chatId, `✅ 已推送《${existing.title}》，可以继续讨论～`);
        return;
      }
      // New book — process
      await sendFeishuReply(chatId, `🔍 正在拆解《${bookName}》，请稍候...`);
      logger.info('Feishu command: chaishu', { book: bookName });
      const result = await processBook(bookName, '', null, '飞书命令');
      currentBook = {
        title: result.book_title,
        author: result.author,
        markdown: result.markdown,
        key_points: (result.markdown.match(/### \d️⃣ (.+)/g) || []).map(k => k.replace(/### \d️⃣ /, ''))
      };
      await sendFeishuReply(chatId, `✅ 《${result.book_title}》拆解完成！\n📌 ${result.key_points?.length || 5} 个核心知识点\n\n可以直接问我关于这本书的任何问题～`);
      chatHistory.set(chatId, []);
      return;
    }

    // Discussion — DeepSeek with book context + conversation history
    const ctxBook = currentBook;
    let history = chatHistory.get(chatId) || [];

    let sysPrompt, userPrompt;
    if (ctxBook) {
      sysPrompt = `你是一个深度阅读讨论助手。当前用户正在阅读《${ctxBook.title}》（作者：${ctxBook.author || '未知'}）。

这本书的核心知识点：${(ctxBook.key_points || []).join('；')}

请基于这本书的内容与用户讨论。回复简洁有深度，300字以内，中文。必须输出JSON格式：{"reply": "你的回复内容"}`;
      userPrompt = `用户问：${text}\n请结合《${ctxBook.title}》的内容回答。输出JSON：{"reply": "..."}`;
    } else {
      sysPrompt = '你是阅读助手。用户还没拆解任何书，建议他们用"拆 书名"命令。必须输出JSON：{"reply": "你的回复"}';
      userPrompt = `${text}\n输出JSON：{"reply": "..."}`;
    }

    // Build conversation context (last 4 messages)
    const context = history.slice(-4).map(h => `${h.role}: ${h.content}`).join('\n');
    if (context) userPrompt = `对话历史：\n${context}\n\n${userPrompt}`;

    const reply = await callDeepSeek(sysPrompt, userPrompt);
    let replyText;
    try {
      const parsed = JSON.parse(reply);
      replyText = parsed.reply || '';
    } catch {
      replyText = reply.slice(0, 500);
    }
    if (!replyText) replyText = '能说得更具体一些吗？我想更好地理解你的问题。';

    // Save to history
    history.push({ role: 'user', content: text });
    history.push({ role: 'assistant', content: replyText });
    chatHistory.set(chatId, history);

    await sendFeishuReply(chatId, replyText);
  } catch (e) {
    logger.error('Feishu message handling error', { error: e.message });
  }
}

// ── Feishu WebSocket Long Connection (官方 SDK) ──
let wsClient = null;

function startFeishuWS() {
  if (!FEISHU_ENABLED) { logger.info('Feishu WS skipped — not enabled'); return; }

  wsClient = new Lark.WSClient({
    appId: FEISHU_APP_ID,
    appSecret: FEISHU_APP_SECRET,
    loggerLevel: Lark.LoggerLevel.debug
  });

  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      try {
        if (data?.message?.message_type === 'text') {
          await handleFeishuMessage(data);
        }
      } catch (e) {
        logger.error('WS message error', { error: e.message });
      }
    }
  });

  wsClient.start({ eventDispatcher: dispatcher });
  logger.info('Feishu WS started (SDK long connection)');
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

        // 飞书事件订阅（仅 URL 验证，消息通过长连接接收）
        if (url.pathname === '/feishu-event') {
          if (input.challenge) {
            return res.end(JSON.stringify({ challenge: input.challenge }));
          }
          return res.end(JSON.stringify({ code: 0 }));
        }

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

// ── Daily Scheduler ──
let lastAutoDate = null;
function startScheduler() {
  const cron = (process.env.SCHEDULE_CRON || '0 8 * * *').trim();
  const parts = cron.split(/\s+/);
  const cronMin = parseInt(parts[0]) || 0;
  const cronHour = parseInt(parts[1]) || 8;

  logger.info('Daily scheduler started', { cron, hour: cronHour, minute: cronMin });

  // Check every 60 seconds
  setInterval(() => {
    const now = new Date();
    const today = now.toISOString().split('T')[0];

    if (now.getHours() === cronHour && now.getMinutes() === cronMin && lastAutoDate !== today) {
      lastAutoDate = today;
      logger.info('Scheduler triggered daily auto recommendation', { date: today });
      autoProcess().then(r => {
        logger.info('Daily auto recommendation completed', { book: r?.book_title });
      }).catch(e => {
        logger.error('Daily auto recommendation failed', { error: e.message });
      });
    }
  }, 60000);
}

server.listen(PORT, '127.0.0.1', () => {
  logger.info(`拆书服务器启动`, { port: PORT, url: `http://127.0.0.1:${PORT}`, feishu_enabled: FEISHU_ENABLED });
  console.log(`   手动拆书: curl -X POST http://127.0.0.1:${PORT}/chaishu -d '{"book":"书名","author":"作者"}'`);
  console.log(`   自动推荐: curl -X POST http://127.0.0.1:${PORT}/auto`);
  console.log(`   n8n 兼容: curl -X POST http://127.0.0.1:${PORT}/process -d '{"book":"书名","author":"作者","system_prompt":"...","user_prompt":"..."}'`);
  console.log(`   健康检查: curl http://127.0.0.1:${PORT}/health`);
  console.log(`   飞书长连接: ws:// (接收消息 + URL验证: /feishu-event)`);
  console.log(`   每日自动: ${process.env.SCHEDULE_CRON || '0 8 * * *'}`);

  startScheduler();
  startFeishuWS();
});
