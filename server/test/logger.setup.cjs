/**
 * e2e 测试静默 NestJS Logger,避免 stream 防御性 handler 的 ERROR 行污染测试输出。
 * setupFiles 阶段执行,所有测试模块加载前完成,效果最干净。
 */
const { Logger } = require('@nestjs/common');
Logger.overrideLogger({
  log: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  verbose: () => {},
  fatal: () => {},
});
