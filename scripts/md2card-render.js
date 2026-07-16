#!/usr/bin/env node
/**
 * MD2Card 渲染脚本 — 将 Markdown 转为小红书风格卡片 PNG
 *
 * 主方案: MD2Card REST API (https://md2card.cn/api/generate)
 * 降级方案: Puppeteer 浏览器自动化
 *
 * 用法:
 *   node md2card-render.js <markdown文件> [输出目录] [选项]
 *   node md2card-render.js book.md cards/ --theme warm
 *   node md2card-render.js --help
 *
 * 环境变量:
 *   MD2CARD_API_KEY — API Key (https://md2card.com/zh/my/api-keys)
 *   MD2CARD_THEME    — 默认主题 (默认: warm)
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── 加载 .env ──
function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.substring(0, i).trim();
    let v = t.substring(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv(path.join(__dirname, '..', '.env'));

// ── 配置 ──
const API_KEY = process.env.MD2CARD_API_KEY;
const API_URL = 'https://md2card.cn/api/generate';
const DEFAULT_THEME = process.env.MD2CARD_THEME || 'warm';
const CARD_WIDTH = 1242;
const CARD_HEIGHT = 1660;

// ── CLI 参数解析 ──
function parseArgs(args) {
  const opts = {
    markdownPath: null, outputDir: path.resolve(__dirname, '..', 'cards'),
    theme: DEFAULT_THEME, width: CARD_WIDTH, height: CARD_HEIGHT,
    timeout: 90000, verbose: false, help: false, forcePuppeteer: false
  };

  let positional = [];
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--theme': opts.theme = args[++i]; break;
      case '--width': opts.width = parseInt(args[++i]); break;
      case '--height': opts.height = parseInt(args[++i]); break;
      case '--timeout': opts.timeout = parseInt(args[++i]) * 1000; break;
      case '--verbose': case '-v': opts.verbose = true; break;
      case '--help': case '-h': opts.help = true; break;
      case '--puppeteer': opts.forcePuppeteer = true; break;
      default:
        if (!args[i].startsWith('--')) positional.push(args[i]);
    }
  }
  if (positional.length >= 1) opts.markdownPath = path.resolve(positional[0]);
  if (positional.length >= 2) opts.outputDir = path.resolve(positional[1]);
  return opts;
}

function showHelp() {
  console.log(`
📸 MD2Card 渲染脚本 — Markdown → PNG 知识卡片

用法:
  node md2card-render.js <markdown文件> [输出目录] [选项]

选项:
  --theme <id>     卡片主题 (默认: warm)
                    可用: warm, apple-notes, xiaohongshu, minimal, glassmorphism 等
                    完整列表: https://md2card.com/zh/blogs/api-docs
  --width <px>     卡片宽度 (默认: 1242)
  --height <px>    卡片高度 (默认: 1660)
  --timeout <秒>    超时时间 (默认: 90)
  --puppeteer      强制使用 Puppeteer 方案（不使用 API）
  --verbose, -v    详细日志
  --help, -h       显示帮助

环境变量:
  MD2CARD_API_KEY  API Key (推荐, 获取: https://md2card.com/zh/my/api-keys)
  MD2CARD_THEME    默认主题

示例:
  node md2card-render.js book.md
  node md2card-render.js book.md cards/ --theme xiaohongshu
  node md2card-render.js book.md cards/ --puppeteer  # 降级方案

方案优先级: API (有 Key) > Puppeteer (无 Key 或 API 失败)
`);
}

function log(verbose, msg) { if (verbose) console.log(`[md2card] ${msg}`); }

// ═══════════════════════════════════════
// 方案 A: REST API
// ═══════════════════════════════════════

function httpRequest(urlStr, options, bodyStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: options.method || 'POST',
      headers: options.headers || {},
      timeout: options.timeout || 60000
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, data });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function downloadFile(url, destPath) {
  const resp = await httpRequest(url, { method: 'GET', timeout: 30000 });
  if (resp.status !== 200) throw new Error(`下载失败 HTTP ${resp.status}`);
  fs.writeFileSync(destPath, resp.data);
  return destPath;
}

async function renderViaAPI(markdown, opts) {
  if (!API_KEY) throw new Error('MD2CARD_API_KEY 未配置');

  log(opts.verbose, `调用 API: ${API_URL}`);
  log(opts.verbose, `  主题: ${opts.theme}, 尺寸: ${opts.width}x${opts.height}`);

  const body = JSON.stringify({
    markdown,
    theme: opts.theme,
    width: opts.width,
    height: opts.height,
    splitMode: 'noSplit'
  });

  const startTime = Date.now();
  const resp = await httpRequest(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY
    },
    timeout: opts.timeout || 60000
  }, body);

  const elapsed = Date.now() - startTime;
  log(opts.verbose, `  API 响应: ${resp.status} (${elapsed}ms)`);

  if (resp.status !== 200) {
    const errText = resp.data.toString('utf-8').slice(0, 500);
    throw new Error(`API 返回 ${resp.status}: ${errText}`);
  }

  const result = JSON.parse(resp.data.toString('utf-8'));

  if (result.error) {
    throw new Error(`API 错误: ${result.error} - ${result.message || ''}`);
  }

  if (!result.images || result.images.length === 0) {
    throw new Error('API 未返回图片');
  }

  return result.images;
}

// ═══════════════════════════════════════
// 方案 B: Puppeteer 降级
// ═══════════════════════════════════════

async function renderViaPuppeteer(markdown, opts) {
  log(opts.verbose, '使用 Puppeteer 降级方案...');

  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch (e) {
    throw new Error('Puppeteer 未安装。请运行: npm install puppeteer');
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: opts.width, height: opts.height });

    // CDP 下载设置
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: opts.outputDir
    });

    // 导航到编辑器（带重试）
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.goto('https://md2card.com/zh/editor', {
          waitUntil: 'networkidle2', timeout: 30000
        });
        break;
      } catch (e) {
        if (attempt === 2) throw new Error(`页面加载失败(重试3次): ${e.message}`);
        log(opts.verbose, `  页面加载重试 ${attempt + 1}/3...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // 填入 Markdown
    log(opts.verbose, '填入内容...');
    await page.waitForSelector('.CodeMirror', { timeout: 10000 });
    await new Promise(r => setTimeout(r, 1000));

    const filled = await page.evaluate((md) => {
      // 尝试 CodeMirror 6
      const cmEl = document.querySelector('.cm-editor');
      if (cmEl?.cmView?.view) {
        const view = cmEl.cmView.view;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: md }
        });
        return 'cm6';
      }
      // 尝试 CodeMirror 5
      const cm = document.querySelector('.CodeMirror')?.CodeMirror;
      if (cm) { cm.setValue(md); return 'cm5'; }
      // 备用 textarea
      const ta = document.querySelector('textarea');
      if (ta) { ta.value = md; ta.dispatchEvent(new Event('input', { bubbles: true })); return 'textarea'; }
      return null;
    }, markdown);

    log(opts.verbose, `  填入方式: ${filled || '失败'}`);

    // 等待预览渲染
    try {
      await page.waitForFunction(() => {
        const previews = document.querySelectorAll('[class*="preview"], [class*="card"], [class*="render"]');
        return previews.length > 0;
      }, { timeout: 15000 });
    } catch { /* 继续 */ }
    await new Promise(r => setTimeout(r, 3000));

    // 查找导出按钮
    const exportBtn = await page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        const text = btn.textContent.toLowerCase();
        if (/导出|下载|export|download|png/.test(text)) return true;
      }
      return false;
    });

    if (exportBtn) {
      log(opts.verbose, '找到导出按钮，尝试导出...');
      await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        for (const btn of btns) {
          if (/导出|export|下载|download/.test(btn.textContent.toLowerCase())) {
            btn.click(); return;
          }
        }
      });
      await new Promise(r => setTimeout(r, 5000));
    }

    // 截图兜底
    const outputPath = path.join(opts.outputDir, `card_${Date.now()}.png`);
    const preview = await page.$('[class*="preview"], [class*="card"], [class*="render"]');
    if (preview) {
      await preview.screenshot({ path: outputPath, type: 'png' });
    } else {
      await page.screenshot({ path: outputPath, type: 'png', fullPage: false });
    }
    log(opts.verbose, `截图保存: ${outputPath}`);

    return [{ url: outputPath, fileName: path.basename(outputPath), local: true }];

  } finally {
    await browser.close();
  }
}

// ═══════════════════════════════════════
// 主流程
// ═══════════════════════════════════════

async function renderToCards(markdownPath, outputDir, opts) {
  if (!fs.existsSync(markdownPath)) {
    throw new Error(`文件不存在: ${markdownPath}`);
  }
  const markdown = fs.readFileSync(markdownPath, 'utf-8');
  const baseName = path.basename(markdownPath, '.md');

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  log(opts.verbose, `📖 输入: ${markdownPath} (${markdown.length} 字符)`);
  log(opts.verbose, `📁 输出: ${outputDir}`);

  let images;
  let method = 'api';

  // 尝试 API 优先
  if (!opts.forcePuppeteer && API_KEY) {
    try {
      images = await renderViaAPI(markdown, opts);
      log(opts.verbose, `✅ API 生成 ${images.length} 张图片`);
    } catch (e) {
      log(opts.verbose, `⚠️  API 失败: ${e.message}`);
      if (!opts.forcePuppeteer) {
        log(opts.verbose, '降级到 Puppeteer...');
        method = 'puppeteer';
      }
    }
  }

  // 降级到 Puppeteer
  if (!images) {
    if (!API_KEY && !opts.forcePuppeteer) {
      log(opts.verbose, '未配置 MD2CARD_API_KEY，使用 Puppeteer');
    }
    method = 'puppeteer';
    images = await renderViaPuppeteer(markdown, opts);
  }

  // 下载远程图片（API 方案）
  const results = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];

    if (img.local) {
      // Puppeteer 已保存本地
      results.push(img.url);
      continue;
    }

    // 下载远程图片
    const ext = path.extname(img.fileName) || '.png';
    const outputName = images.length === 1
      ? `${baseName} 卡片${ext}`
      : `${baseName} 卡片_${i + 1}${ext}`;
    const destPath = path.join(outputDir, outputName);

    await downloadFile(img.url, destPath);
    log(opts.verbose, `  下载: ${destPath}`);

    // 验证文件
    const stat = fs.statSync(destPath);
    if (stat.size < 10240) {
      log(opts.verbose, `⚠️  文件偏小 (${stat.size} bytes)`);
    } else {
      log(opts.verbose, `  ✅ ${(stat.size / 1024).toFixed(1)} KB`);
    }
    results.push(destPath);
  }

  return { images: results, method };
}

// ── CLI 入口 ──
async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help || !opts.markdownPath) {
    showHelp();
    process.exit(opts.help ? 0 : 1);
  }

  try {
    const result = await renderToCards(opts.markdownPath, opts.outputDir, opts);
    console.log(`\n🎉 完成! 方案: ${result.method}, 输出: ${result.images.length} 张`);
    result.images.forEach(i => console.log(`   ${i}`));
  } catch (error) {
    console.error(`\n❌ 错误: ${error.message}`);
    if (opts.verbose) console.error(error.stack);
    process.exit(1);
  }
}

main();
