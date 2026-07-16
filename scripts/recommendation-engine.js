#!/usr/bin/env node
/**
 * 推荐引擎 — 自生长知识库的大脑
 *
 * 读取/更新 books/书籍索引.md 中的偏好图谱 YAML 块，
 * 每次拆书后自动更新主题权重、知识缺口、阅读路径。
 *
 * 用法:
 *   node recommendation-engine.js read              → 输出当前偏好图谱 JSON
 *   node recommendation-engine.js update '<json>'   → 更新图谱并输出结果
 */

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

const INDEX_PATH = path.join(__dirname, '..', 'books', '书籍索引.md');

// ── 解析 ──

function parsePreferences() {
  const content = fs.readFileSync(INDEX_PATH, 'utf-8');
  const match = content.match(/```yaml\n([\s\S]*?)```/);
  if (!match) {
    throw new Error('未在 书籍索引.md 中找到 YAML 偏好图谱块');
  }
  return yaml.parse(match[1]);
}

function stringifyPreferences(prefs) {
  const yamlStr = yaml.stringify(prefs, { lineWidth: 120 });
  return '```yaml\n' + yamlStr + '```';
}

function countBooks() {
  const content = fs.readFileSync(INDEX_PATH, 'utf-8');
  const matches = content.match(/\| \d{4}-\d{2}-\d{2} \|/g);
  return matches ? matches.length : 0;
}

// ── 更新 ──

/**
 * @param {Object} bookResult - DeepSeek 拆书输出的 JSON
 * @param {string[]} bookResult.tags
 * @param {Object[]} bookResult.next_suggestions
 * @param {string} bookResult.category
 * @param {string} bookResult.book_title
 */
function updatePreferences(bookResult) {
  const prefs = parsePreferences();
  const { tags = [], next_suggestions = [], category = '', book_title = '' } = bookResult;

  // 1. 合并标签权重
  for (const tag of tags) {
    const existing = prefs.preferences.topics.find((t) => t.name === tag);
    if (existing) {
      existing.weight = Math.min(existing.weight + 0.3, 3.0);
    } else {
      prefs.preferences.topics.push({ name: tag, weight: 1.0, depth: '入门' });
    }
  }

  // 2. 更新最近关注
  const topTopics = [...prefs.preferences.topics]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3);
  prefs.preferences.recent_focus = topTopics.map((t) => t.name).join('、');

  // 3. 填补知识缺口
  const gapsToRemove = [];
  for (const gap of prefs.preferences.knowledge_gaps) {
    if (tags.some((tag) => tag.includes(gap) || gap.includes(tag))
        || (category && category.includes(gap))) {
      gapsToRemove.push(gap);
    }
  }
  prefs.preferences.knowledge_gaps = prefs.preferences.knowledge_gaps
    .filter((g) => !gapsToRemove.includes(g));

  // 4. 从关联推荐中提取新缺口
  for (const sug of next_suggestions) {
    const reason = sug.reason || '';
    const parts = reason.split('·');
    for (const part of parts) {
      const kw = part.trim();
      if (kw && !prefs.preferences.knowledge_gaps.includes(kw)
          && !prefs.preferences.topics.some((t) => t.name === kw)) {
        prefs.preferences.knowledge_gaps.push(kw);
      }
    }
  }

  // 5. 更新阅读路径
  prefs.preferences.reading_path.current_book = book_title;
  prefs.preferences.reading_path.branches = (next_suggestions || []).map((s) => ({
    direction: s.direction,
    book: s.book,
    reason: s.reason,
  }));

  // 6. 更新书籍数量和深度层级
  const bookCount = countBooks();
  prefs.preferences.book_count = bookCount;
  prefs.preferences.depth_level = bookCount <= 3 ? '入门' : bookCount <= 10 ? '进阶' : '深入';

  // 7. 提升已有主题深度
  for (const tag of tags) {
    const t = prefs.preferences.topics.find((x) => x.name === tag);
    if (t) {
      if (t.weight >= 2.0 && t.depth === '入门') t.depth = '进阶';
      else if (t.weight >= 2.5 && t.depth === '进阶') t.depth = '深入';
    }
  }

  // 8. 写回
  const content = fs.readFileSync(INDEX_PATH, 'utf-8');
  const newYamlBlock = stringifyPreferences(prefs);
  const newContent = content.replace(/```yaml\n[\s\S]*?```/, newYamlBlock);
  fs.writeFileSync(INDEX_PATH, newContent, 'utf-8');

  return prefs;
}

// ── CLI ──

function main() {
  const command = process.argv[2];
  const input = process.argv[3];

  if (command === 'read') {
    const prefs = parsePreferences();
    console.log(JSON.stringify(prefs, null, 2));
  } else if (command === 'update') {
    if (!input) {
      console.error('用法: node recommendation-engine.js update \'{"tags":["心理学"],...}\'');
      process.exit(1);
    }
    let bookResult;
    try {
      bookResult = JSON.parse(input);
    } catch (e) {
      console.error('JSON 解析失败:', e.message);
      process.exit(1);
    }
    const updated = updatePreferences(bookResult);
    console.log(JSON.stringify(updated, null, 2));
  } else {
    console.log('📚 拆书推荐引擎');
    console.log('');
    console.log('用法:');
    console.log('  node recommendation-engine.js read');
    console.log('  node recommendation-engine.js update \'<json>\'');
    console.log('');
    console.log('read   → 输出当前偏好图谱');
    console.log('update → 用拆书结果更新图谱');
  }
}

main();
