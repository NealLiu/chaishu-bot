'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateBookParams,
  repairJSON,
  fillTemplate,
  validateContent,
  formatForFeishu,
  formatXHS,
  formatPlainText,
} = require('../lib/chaishu-core.js');

// ═══════════════════════════════════════════════
// validateBookParams
// ═══════════════════════════════════════════════
describe('validateBookParams', () => {
  it('should reject empty input', () => {
    const r = validateBookParams({});
    assert.equal(r.valid, false);
    assert.ok(r.errors.length > 0);
  });

  it('should reject empty book string', () => {
    const r = validateBookParams({ book: '' });
    assert.equal(r.valid, false);
  });

  it('should reject book > 200 chars', () => {
    const r = validateBookParams({ book: 'x'.repeat(201) });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes('200')));
  });

  it('should reject author > 100 chars', () => {
    const r = validateBookParams({ book: '有效书名', author: 'x'.repeat(101) });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes('100')));
  });

  it('should accept valid book', () => {
    const r = validateBookParams({ book: '关键对话' });
    assert.equal(r.valid, true);
    assert.equal(r.book, '关键对话');
    assert.equal(r.author, '');
  });

  it('should accept book with author', () => {
    const r = validateBookParams({ book: '关键对话', author: 'Kerry Patterson' });
    assert.equal(r.valid, true);
    assert.equal(r.author, 'Kerry Patterson');
  });

  it('should cast author to string', () => {
    const r = validateBookParams({ book: 'A', author: 12345 });
    assert.equal(r.author, '12345');
  });

  it('should trim book name', () => {
    const r = validateBookParams({ book: '  小王子  ' });
    assert.equal(r.book, '小王子');
  });
});

// ═══════════════════════════════════════════════
// repairJSON
// ═══════════════════════════════════════════════
describe('repairJSON', () => {
  it('should strip markdown code block', () => {
    const r = repairJSON('```json\n{"a":1}\n```');
    assert.equal(r, '{"a":1}');
  });

  it('should strip code block without language', () => {
    const r = repairJSON('```\n{"a":1}\n```');
    assert.equal(r, '{"a":1}');
  });

  it('should remove trailing commas', () => {
    const r = repairJSON('{"a":1,}');
    assert.equal(r, '{"a":1}');
  });

  it('should remove trailing comma before }', () => {
    const r = repairJSON('{"a":[1,2,],}');
    assert.equal(r, '{"a":[1,2]}');
  });

  it('should pass valid JSON unchanged', () => {
    const r = repairJSON('  {"a": 1}  ');
    assert.equal(r, '{"a": 1}');
  });
});

// ═══════════════════════════════════════════════
// fillTemplate
// ═══════════════════════════════════════════════
describe('fillTemplate', () => {
  const sampleParsed = {
    book_title: '关键对话',
    author: 'Kerry Patterson',
    category: '沟通·人际关系',
    one_line_summary: '掌握高风险对话',
    recommendation_reason: '很实用的沟通方法',
    tags: ['沟通', '冲突管理'],
    core_framework: '从心开始→学会观察→保证安全',
    key_points: [
      { title: '知识点1', content: '内容1', insight: '洞见1', practice: '练习1' },
      { title: '知识点2', content: '内容2', insight: '洞见2', practice: '练习2' },
      { title: '知识点3', content: '内容3', insight: '洞见3', practice: '练习3' },
      { title: '知识点4', content: '内容4', insight: '洞见4', practice: '练习4' },
      { title: '知识点5', content: '内容5', insight: '洞见5', practice: '练习5' },
    ],
    golden_quote: '关键对话改变人生',
    action_items: ['练习对话技巧', '反思沟通方式'],
    next_suggestions: [
      { direction: '横向拓展', book: '《非暴力沟通》', reason: '补充场景' },
    ],
  };

  it('should produce markdown with frontmatter', () => {
    const r = fillTemplate(sampleParsed);
    assert.ok(r.markdown.startsWith('---\n'));
    assert.ok(r.markdown.includes('title: "📖 《关键对话》'));
  });

  it('should include all 5 key points', () => {
    const r = fillTemplate(sampleParsed);
    assert.ok(r.markdown.includes('1️⃣ 知识点1'));
    assert.ok(r.markdown.includes('5️⃣ 知识点5'));
  });

  it('should include golden quote', () => {
    const r = fillTemplate(sampleParsed);
    assert.ok(r.markdown.includes('关键对话改变人生'));
  });

  it('should include action items', () => {
    const r = fillTemplate(sampleParsed);
    assert.ok(r.markdown.includes('练习对话技巧'));
    assert.ok(r.markdown.includes('反思沟通方式'));
  });

  it('should generate safe file name', () => {
    const r = fillTemplate(sampleParsed);
    assert.ok(r.file_name.includes('-关键对话-chaishu'));
    assert.ok(!r.file_name.includes('/'));
    assert.ok(!r.file_name.includes(':'));
  });

  it('should replace special chars in safe name', () => {
    const p = { ...sampleParsed, book_title: 'A/B:C' };
    const r = fillTemplate(p);
    assert.ok(!r.file_name.includes('/'));
    assert.ok(!r.file_name.includes(':'));
  });

  it('should handle empty key_points gracefully', () => {
    const p = { ...sampleParsed, key_points: [] };
    const r = fillTemplate(p);
    assert.ok(r.markdown.length > 500);
  });
});

// ═══════════════════════════════════════════════
// validateContent
// ═══════════════════════════════════════════════
describe('validateContent', () => {
  const validMd = `
## 🎯 核心框架
框架内容
## 📌 五个核心知识点
## 💎 一句话记住这本书
> 金句
## 🛠️ 今日行动清单
- [ ] 行动1
`.repeat(1) + 'x'.repeat(1000);

  it('should pass valid content', () => {
    const r = validateContent(validMd, '测试书');
    assert.equal(r.ok, true);
    assert.equal(r.issues.length, 0);
  });

  it('should detect missing 核心框架', () => {
    const r = validateContent('缺少框架的内容', '测试');
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.includes('核心框架')));
  });

  it('should detect missing 知识点', () => {
    const r = validateContent('## 🎯 核心框架\n', '测试');
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.includes('知识点')));
  });

  it('should detect short content', () => {
    const r = validateContent('太短', '测试');
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.includes('过短')));
  });

  it('should detect garbled chars', () => {
    const r = validateContent(`测试�内容${ 'x'.repeat(1000)}`, '测试');
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.includes('乱码')));
  });
});

// ═══════════════════════════════════════════════
// formatForFeishu
// ═══════════════════════════════════════════════
describe('formatForFeishu', () => {
  it('should strip frontmatter', () => {
    const r = formatForFeishu('---\ntitle: test\n---\n\n# Hello');
    assert.ok(!r.includes('---'));
    assert.ok(r.includes('Hello'));
  });

  it('should convert headers to bold', () => {
    const r = formatForFeishu('# Title\n## Section');
    assert.ok(r.includes('**Title**'));
    assert.ok(r.includes('**Section**'));
  });

  it('should convert checkboxes', () => {
    const r = formatForFeishu('- [ ] 任务一');
    assert.ok(r.includes('✅ 任务一'));
  });

  it('should strip generated footer', () => {
    const r = formatForFeishu('hello\n*generated by 拆书工flow · 2026-01-01*');
    assert.ok(!r.includes('generated by'));
  });
});

// ═══════════════════════════════════════════════
// formatXHS
// ═══════════════════════════════════════════════
describe('formatXHS', () => {
  const sample = {
    book_title: '关键对话',
    one_line_summary: '掌握高风险对话',
    recommendation_reason: '实用的沟通方法',
    core_framework: '从心开始→观察',
    key_points: [{ title: '点1', content: '内容1', insight: '洞见1' }],
    golden_quote: '关键对话改变人生',
    action_items: ['行动1', '行动2'],
    tags: ['沟通', '成长'],
  };

  it('should include book title', () => {
    const r = formatXHS(sample);
    assert.ok(r.includes('关键对话'));
  });

  it('should include tags as hashtags', () => {
    const r = formatXHS(sample);
    assert.ok(r.includes('#沟通'));
    assert.ok(r.includes('#成长'));
  });

  it('should include key insight', () => {
    const r = formatXHS(sample);
    assert.ok(r.includes('洞见1'));
  });

  it('should include golden quote', () => {
    const r = formatXHS(sample);
    assert.ok(r.includes('关键对话改变人生'));
  });
});

// ═══════════════════════════════════════════════
// formatPlainText
// ═══════════════════════════════════════════════
describe('formatPlainText', () => {
  it('should strip frontmatter', () => {
    const r = formatPlainText('---\ntitle: test\n---\n\nHello World');
    assert.ok(!r.includes('---'));
    assert.ok(r.includes('Hello World'));
  });

  it('should strip bold markers', () => {
    const r = formatPlainText('This is **bold** text');
    assert.ok(!r.includes('**'));
    assert.ok(r.includes('【bold】'));
  });

  it('should strip italic markers', () => {
    const r = formatPlainText('This is *italic* text');
    assert.ok(!r.includes('*italic*'));
  });

  it('should convert headers to decorated text', () => {
    const r = formatPlainText('## Section Title\ncontent');
    assert.ok(!r.includes('##'));
    assert.ok(r.includes('Section Title'));
  });

  it('should format blockquotes', () => {
    const r = formatPlainText('> Some quote');
    assert.ok(!r.includes('>'));
    assert.ok(r.includes('Some quote'));
  });

  it('should convert checkboxes', () => {
    const r = formatPlainText('- [ ] 任务一');
    assert.ok(r.includes('○ 任务一'));
  });

  it('should handle tables', () => {
    const r = formatPlainText('| 横向拓展 | 《书A》 | 理由 |');
    assert.ok(r.includes('• 《书A》'));
    assert.ok(!r.includes('|'));
  });
});
