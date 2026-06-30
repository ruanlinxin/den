import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { TokenGuard } from './token.guard';

/** 构造 mock ExecutionContext:可指定 path 与 headers */
function mkCtx(path: string, headers: Record<string, string> = {}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ path, url: path, headers }),
    }),
  } as unknown as ExecutionContext;
}

describe('TokenGuard', () => {
  let guard: TokenGuard;
  const REAL_TOKEN = 'real-secret';

  beforeEach(() => {
    guard = new TokenGuard();
    process.env.DEN_TOKEN = REAL_TOKEN;
  });

  afterEach(() => {
    delete process.env.DEN_TOKEN;
  });

  it('免鉴权路径直接放行(无需 token)', () => {
    expect(guard.canActivate(mkCtx('/'))).toBe(true);
    expect(guard.canActivate(mkCtx('/health'))).toBe(true);
    expect(guard.canActivate(mkCtx('/favicon.ico'))).toBe(true);
  });

  it('保护路径缺 token 抛 UnauthorizedException', () => {
    expect(() => guard.canActivate(mkCtx('/stash', {}))).toThrow(UnauthorizedException);
  });

  it('保护路径 token 不匹配抛 UnauthorizedException', () => {
    expect(() => guard.canActivate(mkCtx('/stash', { 'x-den-token': 'wrong' }))).toThrow(
      UnauthorizedException,
    );
    expect(() =>
      guard.canActivate(mkCtx('/stash', { authorization: 'Bearer wrong' })),
    ).toThrow(UnauthorizedException);
  });

  it('X-Stash-Token 正确放行', () => {
    expect(guard.canActivate(mkCtx('/stash', { 'x-den-token': REAL_TOKEN }))).toBe(true);
  });

  it('Authorization: Bearer 正确放行(Bearer 大小写不敏感)', () => {
    expect(guard.canActivate(mkCtx('/stash', { authorization: `Bearer ${REAL_TOKEN}` }))).toBe(
      true,
    );
    expect(guard.canActivate(mkCtx('/stash', { authorization: `bearer ${REAL_TOKEN}` }))).toBe(
      true,
    );
  });

  it('只有未授权的 Authorization 前缀不算 token', () => {
    // 'Bearer ' 被剥离后剩空字符串 → 视为缺 token
    expect(() => guard.canActivate(mkCtx('/stash', { authorization: 'Bearer ' }))).toThrow(
      UnauthorizedException,
    );
  });
});
