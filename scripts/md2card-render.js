#!/usr/bin/env node
/**
 * MD2Card 渲染脚本 — Markdown → 小红书卡片 PNG
 *
 * 主方案: MD2Card REST API
 * 降级方案: Puppeteer 本地渲染（单页 HTML → section 截图）
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ── .env 加载 ──
function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('='); if (i === -1) continue;
    const k = t.substring(0, i).trim();
    let v = t.substring(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv(path.join(__dirname, '..', '.env'));

const API_KEY = process.env.MD2CARD_API_KEY;
const DEFAULT_THEME = process.env.MD2CARD_TEMPLATE || 'warm';
const CARD_W = 1080, CARD_H = 1440;

// ── CLI ──
function parseArgs(args) {
  const opts = { markdownPath: null, outputDir: path.resolve(__dirname, '..', 'cards'),
    theme: DEFAULT_THEME, width: CARD_W, height: CARD_H,
    timeout: 90000, verbose: false, help: false, forcePuppeteer: false, preview: false, render: false };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--theme': opts.theme = args[++i]; break;
      case '--timeout': opts.timeout = parseInt(args[++i]) * 1000; break;
      case '--verbose': case '-v': opts.verbose = true; break;
      case '--help': case '-h': opts.help = true; break;
      case '--puppeteer': opts.forcePuppeteer = true; break;
      case '--preview': opts.preview = true; break;
      case '--render': opts.render = true; break;
      default: if (!args[i].startsWith('--')) positional.push(args[i]);
    }
  }
  if (positional.length >= 1) opts.markdownPath = path.resolve(positional[0]);
  if (positional.length >= 2) opts.outputDir = path.resolve(positional[1]);
  return opts;
}
const log = (v, msg) => { if (v) console.log(`[md2card] ${msg}`); };

// ── HTTP helpers ──
function httpReq(urlStr, options, bodyStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({ hostname: u.hostname, path: u.pathname + u.search,
      method: options.method || 'POST', headers: options.headers || {}, timeout: options.timeout || 60000 },
    res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, data: Buffer.concat(chunks) })); });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (bodyStr) req.write(bodyStr); req.end();
  });
}

async function renderViaAPI(markdown, opts) {
  if (!API_KEY) throw new Error('MD2CARD_API_KEY 未配置');
  const resp = await httpReq('https://md2card.com/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY }, timeout: opts.timeout,
  }, JSON.stringify({ markdown, theme: 'xiaohongshu', width: opts.width, height: opts.height, splitMode: 'hrSplit' }));
  if (resp.status !== 200) throw new Error(`API 返回 ${resp.status}`);
  const result = JSON.parse(resp.data.toString('utf-8'));
  if (result.error) throw new Error(`API 错误: ${result.error}`);
  if (!result.images?.length) throw new Error('API 未返回图片');
  return result.images;
}

// ── Local HTML render (Puppeteer) ──
function es(s) { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function buildHTML(markdown) {
  const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---/);
  const fm = {};
  if (fmMatch) for (const line of fmMatch[1].split('\n')) {
    const ci = line.indexOf(':'); if (ci > 0) {
      let v = line.substring(ci + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1,-1);
      if (v.startsWith('[')) try { v = JSON.parse(v); } catch {}; fm[line.substring(0,ci).trim()] = v;
    }
  }
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n*/, '');
  const reason = (body.match(/推荐这本书?\*\*\s*(.+)/) || [])[1] || '';
  const framework = (body.match(/## 🎯 核心框架\s*\n+(.+)/) || [])[1] || '';
  const quote = (body.match(/## 💎 一句话记住这本书\s*\n+>\s*(.+)/) || [])[1] || '';
  const actionSec = body.match(/## 🛠️ 今日行动清单\s*\n([\s\S]*?)(?=\n---|\n##|$)/);
  const actions = []; if (actionSec) { const re = /- \[ \] (.+)/g; let m; while ((m = re.exec(actionSec[1])) !== null) actions.push(m[1]); }
  const kps = []; const kpr = /### (\d)️⃣ (.+?)\n\n([\s\S]*?)(?=\n> 🔑|\n🫁|$)/g; let km;
  while ((km = kpr.exec(body)) !== null) {
    const im = body.slice(km.index).match(/> 🔑 \*\*关键洞见：\*\*\s*(.+)/);
    const pm = body.slice(km.index).match(/🫁 \*\*试试看：\*\*\s*(.+)/);
    kps.push({ num: km[1], title: km[2], content: km[3].trim().slice(0,300), insight: im ? im[1] : '', practice: pm ? pm[1] : '' });
  }
  const ns = body.match(/## 📎 关联推荐\s*\n([\s\S]*?)$/);
  const sugs = []; if (ns) { for (const r of ns[1].matchAll(/\| (.+?) \| 《(.+?)》 \| (.+?) \|/g)) sugs.push({ direction: r[1], book: r[2], reason: r[3] }); }
  const bookName = (((fm.title || '').replace(/^📖 /,'').match(/《(.+?)》/) || [])[1]) || '';
  const tags = Array.isArray(fm.tags) ? fm.tags.slice(0,5) : [];

  const themes = [
    { bg:'#FFFBF5', accent:'#7A9A7E', rgb:'122,154,126', dark:'#3D3428', font:'serif', cover:'linear-gradient(165deg,#F5EFE6,#EDE4D6 30%,#E0D5C1)' },
    { bg:'#FAFAF8', accent:'#002FA7', rgb:'0,47,167', dark:'#1A1A1A', font:'sans', cover:'#FAFAF8' },
    { bg:'#F8F6F0', accent:'#8B4513', rgb:'139,69,19', dark:'#2C1810', font:'serif', cover:'linear-gradient(165deg,#F5F0E8,#EDE5D8 40%,#E0D5C0)' },
    { bg:'#F6F9F5', accent:'#4A7C59', rgb:'74,124,89', dark:'#1C2E1C', font:'sans', cover:'linear-gradient(165deg,#F0F5EE,#E5EDE2 40%,#D8E5D4)' },
    { bg:'#F4F6FA', accent:'#1B3A5C', rgb:'27,58,92', dark:'#0F1C2E', font:'sans', cover:'linear-gradient(165deg,#EEF1F6,#E2E7EF 40%,#D5DDE9)' },
  ];
  const T = themes[Math.floor(Math.random() * themes.length)];
  const ff = T.font === 'serif' ? '"Noto Serif SC","Source Han Serif SC",Georgia,serif' : '-apple-system,"PingFang SC","Noto Sans SC","Inter",sans-serif';

  const CSS = `:root{--accent:${T.accent};--argb:${T.rgb};--dark:${T.dark};--ink:#3D3226;--inkl:#6B5D4F}
*{box-sizing:border-box;margin:0;padding:0}
body{width:1080px;font-family:${ff};-webkit-font-smoothing:antialiased;padding-bottom:40px}
/* cover */
.scov{width:1080px;height:1440px;display:flex;flex-direction:column;background:${T.cover};padding:80px 72px 72px;justify-content:space-between;overflow:hidden;position:relative}
.eb{font-size:22px;letter-spacing:.2em;color:var(--accent);margin-bottom:40px}
.tl{font-size:68px;font-weight:700;color:var(--ink);line-height:1.2;margin-bottom:20px}
.sub{font-size:32px;color:var(--inkl);line-height:1.5}
.meta{font-size:22px;color:var(--inkl);opacity:.6;margin-top:auto}
.deco{position:absolute;right:40px;top:60px;width:160px;height:160px;border-radius:50%;background:radial-gradient(circle at 40% 40%,rgba(var(--argb),.15),transparent 70%);pointer-events:none}
/* key points — natural flow, no fixed height */
.kp{width:1080px;padding:64px 72px 48px;background:${T.bg}}
.num{font-family:${T.font === 'serif' ? 'Georgia,"Noto Serif SC"' : '-apple-system'},serif;font-size:120px;font-weight:200;color:rgba(var(--argb),.2);line-height:1;margin-bottom:8px}
h3{font-size:44px;font-weight:700;color:var(--ink);line-height:1.3;margin-bottom:16px}
.body{font-size:30px;color:var(--inkl);line-height:1.7}
.ins{margin-top:22px;padding:20px 24px;background:rgba(var(--argb),.06);border-radius:12px;border-left:4px solid var(--accent);font-size:26px;color:#5A6B5C;line-height:1.55}
.prc{margin-top:16px;font-size:24px;color:var(--inkl);opacity:.7}
/* summary — natural flow */
.ssm{width:1080px;padding:80px 72px 72px;background:var(--dark);display:flex;flex-direction:column;gap:28px;color:#E8DDD0}
.qtm{font-family:Georgia,serif;font-size:100px;line-height:.4;color:rgba(var(--argb),.2)}
.qt{font-size:36px;line-height:1.6;letter-spacing:.03em;font-weight:300}
.sdv{width:56px;height:2px;background:rgba(var(--argb),.3);margin:4px 0}
.al{list-style:none;font-size:28px;color:#C4B8A4;line-height:2.2}
.al li::before{content:"○ ";color:var(--accent)}
.tgr{font-size:20px;color:#8B7D6B;margin-top:8px;line-height:1.8}
.pdv{width:100%;height:1px;background:rgba(var(--argb),.12);margin:8px 0}
.ph4{font-size:24px;color:var(--accent);font-weight:500;opacity:.8}
.pi{display:flex;align-items:center;gap:14px;padding:14px 18px;background:rgba(255,255,255,.05);border-radius:10px;margin-top:10px}
.par{font-size:24px;color:var(--accent);flex-shrink:0;opacity:.7}
.pti{font-size:22px;font-weight:600;color:#E8DDD0;margin-bottom:2px}
.ps{font-size:18px;color:#8B7D6B}
.ft{font-size:18px;color:#6B5D4F;text-align:center;margin-top:12px}`;

  // ── Content-aware pagination: pack blocks, but render as one long page + clip ──
  function pointH(p) {
    let h = 300 + (p.content || '').length * 1.4;
    if (p.insight) h += (p.insight || '').length + 80;
    if (p.practice) h += 60;
    return Math.round(h);
  }
  const summaryH = sugs.length > 0 ? 700 : 550;

  // Pack into page groups — determines WHERE breaks go
  const pageBreaks = [0]; // y-positions for breaks (0 = cover start)
  let curH = 1440; // cover takes first 1440px
  for (let i = 0; i < kps.length; i++) {
    const h = pointH(kps[i]) + 100; // +padding
    if (curH + h > 2880 && curH > 1440) { // crossed a page boundary
      pageBreaks.push(curH);
      curH = Math.max(curH, pageBreaks[pageBreaks.length - 1] + 1440);
    }
    curH += h;
  }
  // Summary always starts at a page boundary
  curH = Math.ceil(curH / 1440) * 1440;
  pageBreaks.push(curH);

  // Build ONE long flowing HTML (cover fixed 1440px, then content flows)
  let html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>${CSS}
body{padding-bottom:40px}
.cv{width:1080px;height:1440px;display:flex;flex-direction:column;background:${T.cover};padding:80px 72px 72px;justify-content:space-between;overflow:hidden;position:relative}
.kp{width:1080px;padding:68px 72px 40px;background:${T.bg}}
.ssm{width:1080px;padding:72px 72px 64px;background:${T.bg}}
</style></head><body>`;

  // Cover
  html += `<div class="cv"><div class="deco"></div><div><div class="eb">📖 每天拆一本书 · 深度阅读</div><div class="tl">《${es(bookName)}》</div>${reason ? `<div class="sub">${es(reason)}</div>` : ''}${framework ? `<div class="sub" style="font-size:28px;margin-top:16px">🎯 ${es(framework)}</div>` : ''}</div><div class="meta">${es(fm.author || '')} · ${es(fm.category || '')}</div></div>`;

  // Key points — flow naturally
  for (const p of kps) {
    html += `<div class="kp"><div class="num">0${p.num}</div><h3>${es(p.title)}</h3><div class="body">${es(p.content)}</div>${p.insight ? `<div class="ins">💡 ${es(p.insight)}</div>` : ''}${p.practice ? `<div class="prc">🧘 ${es(p.practice)}</div>` : ''}</div>`;
  }

  // Summary (inline, not dark card — merged into last section)
  html += `<div class="ssm"><div style="font-family:Georgia,serif;font-size:80px;line-height:.4;color:rgba(var(--argb),.15)">"</div><div style="font-size:28px;line-height:1.5;color:var(--inkl);margin:8px 0">${es(quote.slice(0,100))}</div><div style="width:48px;height:2px;background:rgba(var(--argb),.2);margin:8px 0"></div><div style="font-size:22px;color:var(--inkl);opacity:.7;line-height:2">${actions.slice(0,4).map(a => `○ ${es(a)}`).join('<br>')}</div><div style="font-size:16px;color:var(--inkl);opacity:.4;margin-top:4px">${tags.map(t => `#${es(t)}`).join('  ')}</div>${sugs.length > 0 ? `<div style="width:100%;height:1px;background:rgba(var(--argb),.08);margin:8px 0"></div><div style="font-size:18px;color:var(--accent);font-weight:500;opacity:.7">📚 延伸阅读</div>${sugs.slice(0,3).map(s => `<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:rgba(var(--argb),.04);border-radius:8px;margin-top:4px"><span style="font-size:18px;color:var(--accent);opacity:.7">${s.direction.includes('横向') ? '↔' : s.direction.includes('深度') ? '↗' : '↘'}</span><div><div style="font-size:17px;font-weight:600;color:var(--ink)">《${es((s.book || '').replace(/^《/,'').replace(/》$/,''))}》</div><div style="font-size:14px;color:var(--inkl);opacity:.5">${es(s.direction)} · ${es(s.reason.slice(0,30))}</div></div></div>`).join('')}` : ''}</div>`;

  html += '</body></html>';
  return html;
}

async function renderViaPuppeteer(markdown, opts) {
  log(opts.verbose, '长页渲染 + 内容感知切片...');
  let puppeteer; try { puppeteer = require('puppeteer'); } catch { throw new Error('npm install puppeteer'); }

  const html = buildHTML(markdown);
  const htmlPath = path.join(opts.outputDir, '_full.html');
  fs.writeFileSync(htmlPath, html, 'utf-8');

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'], protocolTimeout: 300000 });
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(300000);
    await page.setViewport({ width: 1080, height: 1440 });
    await page.goto(`file://${htmlPath}`, { waitUntil: 'load', timeout: 60000 });
    await new Promise(r => setTimeout(r, 1500));

    const totalH = (await page.evaluate(() => document.body.scrollHeight)) || 1440;
    log(opts.verbose, `全页: 1080×${totalH}px`);

    // Slice directly with clip (no fullPage needed)
    const SLICE = 1440;
    const pages = Math.ceil(totalH / SLICE);
    const results = [];

    for (let i = 0; i < pages; i++) {
      const y = i * SLICE;
      const h = Math.min(SLICE, totalH - y);
      if (h < 500 && results.length > 0) break;
      const name = `card_${Date.now()}_${i + 1}.png`;
      const pth = path.join(opts.outputDir, name);
      const imageBuffer = await page.screenshot({ type: 'png', clip: { x: 0, y, width: 1080, height: h } });
      fs.writeFileSync(pth, imageBuffer);
      log(opts.verbose, `  [${i + 1}/${pages}] ${(fs.statSync(pth).size / 1024).toFixed(0)} KB`);
      results.push({ url: pth, fileName: name, local: true });
    }

    try { fs.unlinkSync(htmlPath); } catch {}
    return results;
  } finally { await browser.close(); }
}

// ── Main ──
async function renderToCards(markdownPath, outputDir, opts) {
  if (!fs.existsSync(markdownPath)) throw new Error(`文件不存在: ${markdownPath}`);
  const markdown = fs.readFileSync(markdownPath, 'utf-8');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  log(opts.verbose, `📖 ${path.basename(markdownPath)} (${markdown.length} 字符)`);

  if (opts.preview) {
    const html = buildHTML(markdown);
    const pth = path.join(outputDir, 'preview.html');
    fs.writeFileSync(pth, html, 'utf-8');
    console.log(`\n📝 预览: ${pth}`);
    return { images: [pth], method: 'preview' };
  }

  let images, method = 'api';
  if (!opts.forcePuppeteer && API_KEY) {
    try { images = await renderViaAPI(markdown, opts); } catch (e) { log(opts.verbose, `API 失败: ${e.message}`); }
  }
  if (!images) {
    method = 'puppeteer';
    images = await renderViaPuppeteer(markdown, opts);
  }

  // Download remote images (API mode)
  const results = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (img.local) { results.push(img.url); continue; }
    const ext = path.extname(img.fileName) || '.png';
    const name = images.length === 1 ? `${path.basename(markdownPath,'.md')} 卡片${ext}` : `${path.basename(markdownPath,'.md')} 卡片_${i + 1}${ext}`;
    const dest = path.join(outputDir, name);
    const resp = await httpReq(img.url, { method: 'GET', timeout: 30000 });
    if (resp.status === 200) { fs.writeFileSync(dest, resp.data); results.push(dest); }
  }

  return { images: results, method };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.markdownPath) {
    console.log('📸 md2card — Markdown → 小红书卡片 PNG\n');
    console.log('  node md2card-render.js <file.md> [out/] [--preview|--render] [--theme xiaohongshu]');
    console.log('  --preview  生成 HTML 预览');
    console.log('  --render   生成 PNG 卡片（默认）');
    console.log('  --puppeteer 强制本地渲染');
    process.exit(opts.help ? 0 : 1);
  }

  try {
    const result = await renderToCards(opts.markdownPath, opts.outputDir, opts);
    console.log(`\n🎉 完成! 方案: ${result.method}, 输出: ${result.images.length} 张`);
    result.images.forEach(i => console.log(`   ${i}`));
  } catch (e) { console.error(`\n❌ ${e.message}`); process.exit(1); }
}

main();
