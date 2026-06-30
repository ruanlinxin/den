import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { json, urlencoded } from 'express';

/**
 * 保证 DEN_TOKEN 有值:环境变量为权威来源;未设置则启动时生成一次并打印,
 * 供首次拷贝到各设备 ~/.config/den/config.json。不落盘,重启后变化。
 */
function ensureToken(): { token: string; fromEnv: boolean } {
  if (process.env.DEN_TOKEN) return { token: process.env.DEN_TOKEN, fromEnv: true };
  const token = randomBytes(18).toString('base64url');
  process.env.DEN_TOKEN = token; // 供 TokenGuard 读取
  return { token, fromEnv: false };
}

/**
 * 解析监听地址:
 *   DEN_HOST 显式指定 → 用它
 *   否则探测 Tailscale(100.64.0.0/10)接口 → 绑该 IP(公网零可达)
 *   都没有 → 0.0.0.0(开发回退)
 */
function resolveHost(): string {
  if (process.env.DEN_HOST) return process.env.DEN_HOST;
  const ifs = os.networkInterfaces();
  for (const list of Object.values(ifs)) {
    if (!list) continue;
    for (const i of list) {
      if (i.family !== 'IPv4' || i.internal) continue;
      const b = Number(i.address.split('.')[0]);
      if (b === 100) return i.address; // Tailscale CGNAT 100.64.0.0/10
    }
  }
  return '0.0.0.0';
}

async function bootstrap() {
  const { token, fromEnv } = ensureToken();
  const host = resolveHost();
  const port = Number(process.env.PORT ?? 8080);
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  // 关掉默认 bodyParser 后自己装,带上 size 限制(与 api.md 对齐):
  //   - json: text 路由用,1mb 够用
  //   - urlencoded: file 路由的表单字段(非文件部分)用,1mb 足矣
  //   - 单文件大小由 FileInterceptor 的 limits.fileSize 控制(100mb)
  // 超出 body 限制时 bodyParser 抛 PayloadTooLargeError(type='entity.too.large'),
  // 超出 fileSize 时 multer 抛 MulterError(code='LIMIT_FILE_SIZE'),
  // 都被下方的 express 错误中间件翻译成 413。
  const BODY_LIMIT = process.env.DEN_BODY_LIMIT ?? '1mb';
  app.use(json({ limit: BODY_LIMIT }));
  app.use(urlencoded({ limit: BODY_LIMIT, extended: true }));

  // express 错误中间件(4 参形式):只捕 multer / bodyParser 错误并翻译成 413,
  // 其余错误交给 NestJS 默认 exception filter(返回标准 4xx/5xx 体)。
  app.use((err: any, _req: any, res: any, next: any) => {
    if (err?.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({
        statusCode: 413,
        message: err.message || 'file too large',
        error: 'Payload Too Large',
      });
      return;
    }
    if (err?.type === 'entity.too.large') {
      res.status(413).json({
        statusCode: 413,
        message: err.message || 'request body too large',
        error: 'Payload Too Large',
      });
      return;
    }
    next(err);
  });

  await app.listen(port, host);
  console.log(`[den] listening on http://${host}:${port}`);
  if (!fromEnv) {
    console.log(
      `[den] generated token (won't persist across restart; set DEN_TOKEN): ${token}`,
    );
  }
}
bootstrap();
