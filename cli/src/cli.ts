/**
 * den CLI — 纯 TS 客户端,零运行时依赖(仅 Node 内置 fetch/fs/crypto)
 *
 * 配置:~/.config/den/config.json (JSON { url, token }),环境变量 DEN_URL / DEN_TOKEN 覆盖。
 * 向后兼容:若无配置文件则回退读 ~/.stashrc;STASH_URL / STASH_TOKEN 仍生效。
 *
 * 命令(对齐 docs/api.md):
 *   den push -m "<文本>" [--ttl 1h] [--tags a,b] [--source <host>]
 *   den push -m -                       从 stdin 推文本
 *   den push <file> [--ttl 1h] [--tags a,b] [--source <host>]
 *   den ls [--kind text|file] [--source <host>] [--tag <tag>]
 *   den get <id> [-o <path>]            文本→打印 / 文件→下载到 cwd
 *   den rm <id>
 *   den tag <id> add <a,b>              追加标签
 *   den tag <id> rm <tag>               删除单个标签
 *   den config set --url <u> --token <t>
 *   den config show
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const RCPATH = path.join(os.homedir(), '.config', 'den', 'config.json');
const LEGACY_RCPATH = path.join(os.homedir(), '.stashrc');

/** 默认请求超时 30s,环境变量 DEN_TIMEOUT_MS 可覆盖(单位 ms) */
const TIMEOUT_MS = (() => {
  const n = Number(process.env.DEN_TIMEOUT_MS ?? 30_000);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
})();

/** 退出 + 可选错误信息。
 *  区分测试/生产:测试时(JEST_WORKER_ID 被设)抛错,便于 assert;
 *  生产时真退出。避免在测试里依赖 process.exit mock(jest 30 在 worker 里拦不住)。 */
export function die(code: number, msg?: string): never {
  if (msg) console.error(`[den] ${msg}`);
  if (process.env.JEST_WORKER_ID !== undefined) {
    throw new Error(`__EXIT_${code}__`);
  }
  process.exit(code);
}

export interface Config {
  url: string;
  token: string;
}

export interface Entry {
  id: string;
  kind: 'text' | 'file';
  name: string;
  size: number;
  createdAt: number;
  source?: string | null;
  tags?: string[];
  expiresAt?: number | null;
}

// ---------- 参数解析 ----------

export interface ParsedArgs {
  opts: Record<string, string>;
  flags: Set<string>;
  positional: string[];
}

export function parseArgs(args: string[], valueOpts: string[]): ParsedArgs {
  const opts: Record<string, string> = {};
  const flags = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        opts[a.slice(0, eq)] = a.slice(eq + 1);
        continue;
      }
      if (valueOpts.includes(a)) {
        opts[a] = args[++i];
        continue;
      }
      flags.add(a);
    } else if (a.startsWith('-') && a.length === 2) {
      if (valueOpts.includes(a)) {
        opts[a] = args[++i];
        continue;
      }
      flags.add(a);
    } else {
      positional.push(a);
    }
  }
  return { opts, flags, positional };
}

export const pick = (o: Record<string, string>, names: string[]): string | undefined => {
  for (const n of names) if (o[n] !== undefined) return o[n];
  return undefined;
};

// ---------- 配置 ----------

async function readRc(): Promise<Partial<Config>> {
  try {
    return JSON.parse(await fs.readFile(RCPATH, 'utf8'));
  } catch {
    /* 无 ~/.denrc,回退 ~/.stashrc(平滑迁移) */
    try {
      return JSON.parse(await fs.readFile(LEGACY_RCPATH, 'utf8'));
    } catch {
      return {};
    }
  }
}

export async function loadConfig(): Promise<Config> {
  const rc = await readRc();
  const url = (process.env.DEN_URL ?? process.env.STASH_URL ?? rc.url ?? '').replace(/\/+$/, '');
  const token = process.env.DEN_TOKEN ?? process.env.STASH_TOKEN ?? rc.token ?? '';
  if (!url || !token) {
    die(1, '未配置。运行 `den config set --url <URL> --token <TOKEN>`,或设置 DEN_URL/DEN_TOKEN。');
  }
  return { url, token };
}

// ---------- TTL / 大小 / 时间格式化 ----------

export function parseTtlToSeconds(s?: string): number | undefined {
  if (!s) return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/.exec(s.trim());
  if (!m) return undefined;
  let n = Number(m[1]);
  switch (m[2]) {
    case 'ms':
      n /= 1000;
      break;
    case undefined:
    case 's':
      break;
    case 'm':
      n *= 60;
      break;
    case 'h':
      n *= 3600;
      break;
    case 'd':
      n *= 86400;
      break;
    case 'w':
      n *= 604800;
      break;
  }
  return Math.floor(n);
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

export function humanAge(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function humanExpires(expiresAt?: number | null): string {
  if (!expiresAt) return '';
  const s = (expiresAt - Date.now()) / 1000;
  if (s <= 0) return 'expired';
  const n = Math.ceil(s);
  if (n < 60) return `${n}s`;
  if (n < 3600) return `${Math.floor(n / 60)}m`;
  if (n < 86400) return `${Math.floor(n / 3600)}h`;
  return `${Math.floor(n / 86400)}d`;
}

export function parseTags(s?: string): string[] | undefined {
  if (!s) return undefined;
  return s
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

// ---------- HTTP ----------

export async function request(
  cfg: Config,
  method: string,
  p: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${cfg.token}`);
  // 优先用调用方传入的 signal,否则装一个 timeout signal
  const signal = init.signal ?? (TIMEOUT_MS > 0 ? AbortSignal.timeout(TIMEOUT_MS) : undefined);
  const res = await fetch(`${cfg.url}${p}`, { ...init, method, headers, signal });
  return res;
}

export async function sendJson(cfg: Config, method: string, p: string, body: unknown): Promise<any> {
  const res = await request(cfg, method, p, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return readJson(res);
}

export async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON */
  }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `${res.status} ${res.statusText}`;
    die(1, msg);
  }
  return data;
}

// ---------- stdin ----------

export async function readStdin(): Promise<string> {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/** 读一行(到 \n 或 EOF);用于交互式 y/N 确认 */
export function readLine(): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    const onData = (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        cleanup();
        resolve(buf.slice(0, nl).trim());
      }
    };
    const onEnd = () => {
      cleanup();
      resolve(buf.trim());
    };
    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      try {
        process.stdin.pause();
      } catch {
        /* ignore */
      }
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.resume();
  });
}

/** 把 token 在展示时打码:`abcdef` → `ab***`;长度<=2 时保留首字符 */
export function maskToken(t: string): string {
  if (!t) return '(未设置)';
  if (t.length <= 2) return t[0] + '***';
  return t.slice(0, 2) + '***';
}

// ---------- 命令 ----------

export async function cmdPush(cfg: Config, args: string[]): Promise<void> {
  const { opts, positional } = parseArgs(args, [
    '-m',
    '--message',
    '--ttl',
    '-t',
    '--tags',
    '--source',
  ]);
  const ttl = parseTtlToSeconds(pick(opts, ['--ttl', '-t']));
  const tags = parseTags(pick(opts, ['--tags']));
  const source = pick(opts, ['--source']) ?? os.hostname();
  const msg = pick(opts, ['-m', '--message']);

  let entry: Entry;
  if (msg !== undefined) {
    const text = msg === '-' ? await readStdin() : msg;
    if (!text) {
      die(1, '文本不能为空');
    }
    entry = await sendJson(cfg, 'POST', '/den/text', { text, source, ttl, tags });
  } else {
    const file = positional[0];
    if (!file) {
      die(1, '用法: den push <file> 或 den push -m "<文本>"');
    }
    const buf = await fs.readFile(file);
    const form = new FormData();
    form.append('file', new Blob([buf]), path.basename(file));
    form.append('source', source);
    if (ttl) form.append('ttl', String(ttl));
    if (tags) form.append('tags', tags.join(','));
    const res = await request(cfg, 'POST', '/den/file', { body: form });
    entry = await readJson(res);
  }
  console.log(`${entry.id}  (${entry.kind}, ${humanSize(entry.size)})`);
  if (entry.tags?.length) console.log(`  tags: ${entry.tags.join(', ')}`);
  if (entry.expiresAt) console.log(`  expires: ${humanExpires(entry.expiresAt)}`);
}

export async function cmdLs(cfg: Config, args: string[]): Promise<void> {
  const { opts } = parseArgs(args, ['--kind', '--source', '--tag']);
  const q = new URLSearchParams();
  if (opts['--kind']) q.set('kind', opts['--kind']);
  if (opts['--source']) q.set('source', opts['--source']);
  if (opts['--tag']) q.set('tag', opts['--tag']);
  const qs = q.toString();
  const list = (await sendJson(cfg, 'GET', `/den${qs ? `?${qs}` : ''}`, undefined)) as Entry[];
  if (!list.length) {
    console.log('(空)');
    return;
  }
  for (const e of list) {
    const tags = e.tags?.length ? `  [${e.tags.join(',')}]` : '';
    const exp = e.expiresAt ? `  ⏳${humanExpires(e.expiresAt)}` : '';
    const src = e.source ? `  @${e.source}` : '';
    console.log(`${e.id}  ${e.kind.padEnd(4)} ${humanSize(e.size).padStart(7)}  ${humanAge(e.createdAt).padStart(4)}前  ${e.name}${src}${tags}${exp}`);
  }
}

export async function cmdGet(cfg: Config, args: string[]): Promise<void> {
  const { opts, positional } = parseArgs(args, ['-o', '--output']);
  const id = positional[0];
  if (!id) {
    die(1, '用法: den get <id> [-o <path>]');
  }
  const entry = (await sendJson(cfg, 'GET', `/den/${id}`, undefined)) as Entry;
  const res = await request(cfg, 'GET', `/den/${id}/content`, {});
  if (!res.ok) {
    await readJson(res); // 报错退出
    return;
  }
  if (entry.kind === 'text') {
    const text = await res.text();
    process.stdout.write(text);
    if (!text.endsWith('\n')) process.stdout.write('\n');
  } else {
    const out = pick(opts, ['-o', '--output']) ?? path.resolve(entry.name);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(out, buf);
    console.log(`已下载 → ${out}  (${humanSize(buf.length)})`);
  }
}

export async function cmdRm(cfg: Config, args: string[]): Promise<void> {
  // --yes / -y 都是 boolean flag,不需要 value;不进 valueOpts
  const { flags, positional } = parseArgs(args, []);
  const id = positional[0];
  if (!id) {
    die(1, '用法: den rm <id> [--yes|-y]');
  }
  const yes = flags.has('--yes') || flags.has('-y');

  if (!yes) {
    if (!process.stdin.isTTY) {
      die(
        1,
        '非交互式环境:删除需要 --yes/-y 显式确认(防止脚本误删不可恢复数据)。',
      );
    }
    // TTY:取元信息后让用户看明白再决定
    let meta: Entry | undefined;
    try {
      meta = (await sendJson(cfg, 'GET', `/den/${id}`, undefined)) as Entry;
    } catch {
      die(1, '未找到该条目');
    }
    process.stdout.write(
      `确认删除 ${id} (${meta.kind}, ${humanSize(meta.size)}, ${meta.name})? [y/N] `,
    );
    const ans = (await readLine()).toLowerCase();
    if (ans !== 'y' && ans !== 'yes') {
      console.log('已取消');
      return;
    }
  }

  await sendJson(cfg, 'DELETE', `/den/${id}`, undefined);
  console.log(`已删除 ${id}`);
}

export async function cmdTag(cfg: Config, args: string[]): Promise<void> {
  const id = args[0];
  const op = args[1];
  const rest = args.slice(2).join(' ');
  if (!id || (op !== 'add' && op !== 'rm') || !rest) {
    die(1, '用法: den tag <id> add <a,b> | den tag <id> rm <tag>');
  }
  if (op === 'add') {
    const tags = parseTags(rest) ?? [];
    const entry = await sendJson(cfg, 'POST', `/den/${id}/tags`, { tags });
    console.log(`${entry.id}  tags: ${(entry.tags ?? []).join(', ') || '(无)'}`);
  } else {
    const entry = await sendJson(cfg, 'DELETE', `/den/${id}/tags/${encodeURIComponent(rest)}`, undefined);
    console.log(`${entry.id}  tags: ${(entry.tags ?? []).join(', ') || '(无)'}`);
  }
}

export async function cmdConfig(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === 'show') {
    const rc = await readRc();
    if (!rc.url && !rc.token) {
      console.log('(无 ~/.config/den/config.json)');
      return;
    }
    console.log(`url:   ${rc.url ?? '(未设置)'}`);
    console.log(`token: ${rc.token ? maskToken(rc.token) : '(未设置)'}`);
    return;
  }
  if (sub === 'set') {
    const { opts } = parseArgs(args.slice(1), ['--url', '--token']);
    const rc = await readRc();
    if (opts['--url']) rc.url = opts['--url'];
    if (opts['--token']) rc.token = opts['--token'];
    if (!rc.url || !rc.token) {
      die(1, 'config set 需要同时提供 --url 与 --token');
    }
    await fs.mkdir(path.dirname(RCPATH), { recursive: true });
    await fs.writeFile(RCPATH, JSON.stringify(rc, null, 2) + '\n', { mode: 0o600 });
    console.log(`已写入 ${RCPATH}`);
    return;
  }
  die(1, '用法: den config set --url <u> --token <t> | den config show');
}

// ---------- 入口 ----------

export function usage(): void {
  console.log(`den — 跨设备暂存

用法:
  den push -m "<文本>" [--ttl 1h] [--tags a,b] [--source <host>]
  den push -m -                        从 stdin 推文本
  den push <file> [--ttl 1h] [--tags a,b] [--source <host>]
  den ls [--kind text|file] [--source <host>] [--tag <tag>]
  den get <id> [-o <path>]
  den rm <id>
  den tag <id> add <a,b> | den tag <id> rm <tag>
  den config set --url <u> --token <t>
  den config show

ttl 单位: s/m/h/d/w,纯数字=秒`);
}

export async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      usage();
      return;
    case 'config':
      await cmdConfig(rest);
      return;
    case 'push':
      await cmdPush(await loadConfig(), rest);
      return;
    case 'ls':
    case 'list':
      await cmdLs(await loadConfig(), rest);
      return;
    case 'get':
      await cmdGet(await loadConfig(), rest);
      return;
    case 'rm':
    case 'del':
    case 'delete':
      await cmdRm(await loadConfig(), rest);
      return;
    case 'tag':
      await cmdTag(await loadConfig(), rest);
      return;
    default:
      die(1, `未知命令: ${cmd}`);
  }
}

if (process.env.JEST_WORKER_ID === undefined) {
  main().catch((e) => {
    console.error(`[den] ${e?.message ?? e}`);
    process.exit(1);
  });
}
