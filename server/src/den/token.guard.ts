import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';

/**
 * TokenGuard — 简单 Bearer token 鉴权
 *
 * 放行 /health、/、/favicon.ico;其余请求需要 Authorization: Bearer <token>
 * 或 X-Stash-Token。<token> 取自 DEN_TOKEN 环境变量(main.ts 保证其必有值)。
 *
 * 缺失/不匹配时主动抛 UnauthorizedException → 返回 401(而非默认的 403)。
 */
@Injectable()
export class TokenGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const path: string = req.path ?? req.url ?? '';
    if (path === '/health' || path === '/' || path === '/favicon.ico') {
      return true;
    }
    const token =
      req.headers['x-den-token'] ||
      (req.headers.authorization as string | undefined)?.replace(/^Bearer\s+/i, '');
    if (!token || token !== process.env.DEN_TOKEN) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
