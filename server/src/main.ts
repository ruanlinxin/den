import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { randomBytes } from 'node:crypto';
import os from 'node:os';

/**
 * 保证 STASH_TOKEN 有值:环境变量为权威来源;未设置则启动时生成一次并打印,
 * 供首次拷贝到各设备 ~/.stashrc。不落盘,重启后变化。
 */
function ensureToken(): { token: string; fromEnv: boolean } {
  if (process.env.STASH_TOKEN) return { token: process.env.STASH_TOKEN, fromEnv: true };
  const token = randomBytes(18).toString('base64url');
  process.env.STASH_TOKEN = token; // 供 TokenGuard 读取
  return { token, fromEnv: false };
}

/**
 * 解析监听地址:
 *   STASH_HOST 显式指定 → 用它
 *   否则探测 Tailscale(100.64.0.0/10)接口 → 绑该 IP(公网零可达)
 *   都没有 → 0.0.0.0(开发回退)
 */
function resolveHost(): string {
  if (process.env.STASH_HOST) return process.env.STASH_HOST;
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
  const app = await NestFactory.create(AppModule);
  await app.listen(port, host);
  console.log(`[stash] listening on http://${host}:${port}`);
  if (!fromEnv) {
    console.log(
      `[stash] generated token (won't persist across restart; set STASH_TOKEN): ${token}`,
    );
  }
}
bootstrap();
