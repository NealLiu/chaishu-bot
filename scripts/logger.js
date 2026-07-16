/**
 * 结构化日志模块 —— 零外部依赖
 * 输出 JSON 格式，通过 LOG_LEVEL 环境变量控制级别
 * 用法: const logger = require('./logger');
 *       logger.info('message', { key: 'value' });
 */
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function format(level, message, data) {
  const entry = { timestamp: new Date().toISOString(), level, message };
  if (data !== undefined) entry.data = data;
  return JSON.stringify(entry);
}

module.exports = {
  debug: (msg, data) => {
    if (currentLevel <= LEVELS.debug) console.log(format('debug', msg, data));
  },
  info: (msg, data) => {
    if (currentLevel <= LEVELS.info) console.log(format('info', msg, data));
  },
  warn: (msg, data) => {
    if (currentLevel <= LEVELS.warn) console.log(format('warn', msg, data));
  },
  error: (msg, data) => {
    if (currentLevel <= LEVELS.error) console.error(format('error', msg, data));
  },
  LEVELS,
};
