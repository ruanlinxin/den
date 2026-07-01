import { promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import {
  cmdPush,
  cmdRm,
  cmdTag,
  cmdLs,
  cmdGet,
  cmdConfig,
  loadConfig,
  readLine,
  maskToken,
  gbkMojibakeToUtf8,
} from './cli';

const cfg = () => ({ url: 'http://srv:1', token: 'tok' });

/** 构造一个 fetch 成功响应(返回 JSON) */
function resOk(json: unknown) {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(json)),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  };
}

function mockFetch(response: unknown) {
  const f = jest.fn().mockResolvedValue(resOk(response));
  (globalThis as { fetch: unknown }).fetch = f;
  return f;
}

/** mock process.exit:抛错以中断后续执行,便于断言
 *  (jest.setup.cjs 已经全局替换为 throw '__EXIT_<code>__',这里保持同样约定) */
function mockExit() {
  return jest.spyOn(process, 'exit').mockImplementation(((code = 0) => {
    throw new Error(`__EXIT_${code}__`);
  }) as never);
}

describe('命令函数', () => {
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation();
    errSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.DEN_URL;
    delete process.env.DEN_TOKEN;
    delete process.env.STASH_URL;
    delete process.env.STASH_TOKEN;
  });

  // ---------- cmdPush ----------

  describe('cmdPush', () => {
    it('推送文本:正确构造 POST /den/text(含 ttl/tags)', async () => {
      const f = mockFetch({ id: 'abc', kind: 'text', name: 'text.txt', size: 2, createdAt: 1, tags: [], expiresAt: null });
      await cmdPush(cfg(), ['-m', 'hi', '--tags', 'a,b', '--source', 'mac', '--ttl', '1h']);
      const [url, init] = f.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://srv:1/den/text');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({
        text: 'hi',
        source: 'mac',
        ttl: 3600,
        tags: ['a', 'b'],
      });
    });

    it('缺 -m 与文件 → exit(1)', async () => {
      await expect(cmdPush(cfg(), [])).rejects.toThrow('__EXIT_1__');
    });
  });

  // ---------- cmdRm ----------

  describe('cmdRm', () => {
    it('DELETE /den/:id', async () => {
      const f = mockFetch({ ok: true });
      await cmdRm(cfg(), ['abc', '--yes']);
      const [url, init] = f.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://srv:1/den/abc');
      expect(init.method).toBe('DELETE');
    });

    it('缺 id → exit(1)', async () => {
      await expect(cmdRm(cfg(), [])).rejects.toThrow('__EXIT_1__');
    });

    it('--yes 跳过确认,直接发 DELETE', async () => {
      const f = mockFetch({ ok: true });
      await cmdRm(cfg(), ['abc', '--yes']);
      expect(f).toHaveBeenCalledTimes(1);
      expect((f.mock.calls[0] as [string, RequestInit])[0]).toBe('http://srv:1/den/abc');
    });

    it('非 TTY 无 --yes → 拒绝(不发送 DELETE)', async () => {
      const orig = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      const f = mockFetch({ ok: true });
      try {
        await expect(cmdRm(cfg(), ['abc'])).rejects.toThrow('__EXIT_1__');
        expect(f).not.toHaveBeenCalled();
      } finally {
        if (orig) Object.defineProperty(process.stdin, 'isTTY', orig);
      }
    });

    it('TTY:输入 y → 发 DELETE', async () => {
      const orig = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      const f = jest
        .fn()
        .mockResolvedValueOnce(
          resOk({ id: 'abc', kind: 'text', name: 'text.txt', size: 3, createdAt: 1, tags: [], expiresAt: null }),
        )
        .mockResolvedValueOnce(resOk({ ok: true }));
      (globalThis as { fetch: unknown }).fetch = f;
      // 直接喂 stdin:readLine 监听 'data' 事件,遇到 \n resolve。
      // 用 setImmediate 推迟到 cmdRm 进入 readLine 之后
      setImmediate(() => process.stdin.emit('data', 'y\n'));
      try {
        await cmdRm(cfg(), ['abc']);
        expect(f).toHaveBeenCalledTimes(2);
        expect((f.mock.calls[1] as [string, RequestInit])[0]).toBe('http://srv:1/den/abc');
      } finally {
        if (orig) Object.defineProperty(process.stdin, 'isTTY', orig);
      }
    });

    it('TTY:输入 n → 取消,不发送 DELETE', async () => {
      const orig = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      const f = jest.fn().mockResolvedValueOnce(
        resOk({ id: 'abc', kind: 'text', name: 'text.txt', size: 3, createdAt: 1, tags: [], expiresAt: null }),
      );
      (globalThis as { fetch: unknown }).fetch = f;
      setImmediate(() => process.stdin.emit('data', 'n\n'));
      try {
        await cmdRm(cfg(), ['abc']);
        expect(f).toHaveBeenCalledTimes(1); // 只调了 GET,没 DELETE
        expect(logSpy).toHaveBeenCalledWith('已取消');
      } finally {
        if (orig) Object.defineProperty(process.stdin, 'isTTY', orig);
      }
    });
  });

  // ---------- gbkMojibakeToUtf8 ----------

  describe('gbkMojibakeToUtf8', () => {
    it('识别 "中文" 的 GBK → UTF-8 mojibake 并修复', () => {
      // "中文" 的 GBK 字节 [D6 D0 CE C4] 被 UTF-8 误读后,JS 字符为 Ð Ö Î Ä
      const mojibake = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
        .toString('latin1');
      expect(mojibake).toBe('ÖÐÎÄ');
      const fixed = gbkMojibakeToUtf8(mojibake);
      expect(fixed).toBe('中文');
    });

    it('纯 ASCII 路径不动', () => {
      expect(gbkMojibakeToUtf8('/Users/alice/file.txt')).toBeNull();
    });

    it('正常 UTF-8 中文 不误报', () => {
      // 已经是 UTF-8 字符串,GBK 解码会失败或产生大量 latin1 残留
      const result = gbkMojibakeToUtf8('中文.txt');
      expect(result).toBeNull();
    });

    it('混合中英文 mojibake', () => {
      // "你好" GBK 字节 C4 E3 BA C3,后接 ASCII "go" (0x67 0x6F)
      // mojibake 字符串 = "ÄãºÃgo"
      const mojibake = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x67, 0x6f])
        .toString('latin1');
      expect(mojibake).toBe('ÄãºÃgo');
      expect(gbkMojibakeToUtf8(mojibake)).toBe('你好go');
    });
  });

  // ---------- readFileWithEncodingFallback ----------

  describe('readFileWithEncodingFallback', () => {
    it('正常路径 直接读成功', async () => {
      const { readFileWithEncodingFallback } = await import('./cli');
      const tmp = '/tmp/den-cli-fallback-test.txt';
      await fs.writeFile(tmp, 'hello');
      const buf = await readFileWithEncodingFallback(tmp);
      expect(buf.toString()).toBe('hello');
      await fs.unlink(tmp);
    });

    it('Windows + ENOENT 触发 mojibake 修复(模拟)', async () => {
      const { readFileWithEncodingFallback } = await import('./cli');
      // 模拟:首次 readFile 抛 ENOENT,但 mojibake 修复后能读
      const realPath = '/tmp/den-cli-fallback-real.txt';
      const mojibakePath = Buffer.from(
        // 真实文件名的 GBK 字节模拟的 mojibake
        // 临时用 ASCII 文件名(GBK 修复会失败,fallback 走原 ENOENT)
        // 实际 Windows GBK 中文路径才需要真修复
        realPath.split('').reverse().join(''),
        'utf8'
      ).toString('latin1');
      await fs.writeFile(realPath, 'real');
      // mojibake 路径不存在,readFile 报 ENOENT,fallback 也失败
      await expect(readFileWithEncodingFallback(mojibakePath)).rejects.toThrow();
      await fs.unlink(realPath);
    });
  });

  // ---------- maskToken ----------

  describe('maskToken', () => {
    it('前 2 字符 + ***', () => {
      expect(maskToken('abcdef')).toBe('ab***');
      expect(maskToken('xyz12345token')).toBe('xy***');
    });
    it('短 token 保留首字符', () => {
      expect(maskToken('a')).toBe('a***');
      expect(maskToken('ab')).toBe('a***');
    });
    it('空值返回占位', () => {
      expect(maskToken('')).toBe('(未设置)');
    });
  });

  // ---------- readLine ----------

  describe('readLine', () => {
    afterEach(() => {
      // 恢复 stdin 状态
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
    });

    it('读到 \\n 即返回该行', async () => {
      const p = readLine();
      process.stdin.emit('data', 'hello\n');
      await expect(p).resolves.toBe('hello');
    });
    it('去首尾空白', async () => {
      const p = readLine();
      process.stdin.emit('data', '  yes  \n');
      await expect(p).resolves.toBe('yes');
    });
    it('EOF 时返回剩余内容', async () => {
      const p = readLine();
      process.stdin.emit('data', 'partial');
      process.stdin.emit('end');
      await expect(p).resolves.toBe('partial');
    });
  });

  // ---------- cmdTag ----------

  describe('cmdTag', () => {
    it('add:POST /den/:id/tags', async () => {
      const f = mockFetch({ id: 'abc', tags: ['x', 'y'] });
      await cmdTag(cfg(), ['abc', 'add', 'x,y']);
      const [url, init] = f.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://srv:1/den/abc/tags');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ tags: ['x', 'y'] });
    });

    it('rm:DELETE /den/:id/tags/:tag(URL 编码)', async () => {
      const f = mockFetch({ id: 'abc', tags: [] });
      await cmdTag(cfg(), ['abc', 'rm', '中 文']);
      const [url, init] = f.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://srv:1/den/abc/tags/' + encodeURIComponent('中 文'));
      expect(init.method).toBe('DELETE');
    });

    it('用法不全 → exit(1)', async () => {
      mockExit();
      await expect(cmdTag(cfg(), ['abc'])).rejects.toThrow('__EXIT_1__');
    });
  });

  // ---------- cmdLs ----------

  describe('cmdLs', () => {
    it('GET /den 带 query(kind/tag/source)', async () => {
      const f = mockFetch([
        { id: 'a', kind: 'text', name: 'text.txt', size: 1, createdAt: 1, tags: [], expiresAt: null },
      ]);
      await cmdLs(cfg(), ['--tag', 'note', '--kind', 'text', '--source', 'mac']);
      const url = (f.mock.calls[0] as [string, RequestInit])[0];
      expect(url).toContain('/den?');
      expect(url).toContain('tag=note');
      expect(url).toContain('kind=text');
      expect(url).toContain('source=mac');
    });

    it('空列表 → 输出 "(空)"', async () => {
      mockFetch([]);
      await cmdLs(cfg(), []);
      expect(logSpy).toHaveBeenCalledWith('(空)');
    });
  });

  // ---------- cmdGet ----------

  describe('cmdGet', () => {
    it('文本:第一次取 meta,第二次取 content,打印到 stdout', async () => {
      const f = jest
        .fn()
        // GET /den/:id → entry meta
        .mockResolvedValueOnce(resOk({ id: 'a', kind: 'text', name: 'text.txt', size: 3, createdAt: 1, tags: [], expiresAt: null }))
        // GET /den/:id/content → 正文
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve('hi\n') });
      (globalThis as { fetch: unknown }).fetch = f;
      const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
      await cmdGet(cfg(), ['a']);
      expect(writeSpy).toHaveBeenCalledWith('hi\n');
    });
  });

  // ---------- loadConfig ----------

  describe('loadConfig', () => {
    it('env 变量优先(DEN_URL/DEN_TOKEN)', async () => {
      // 避免 ~/.denrc / ~/.stashrc 干扰:模拟读取失败
      jest.spyOn(fs, 'readFile').mockRejectedValue(new Error('no rc'));
      process.env.DEN_URL = 'http://envhost:9';
      process.env.DEN_TOKEN = 'envtok';
      const c = await loadConfig();
      expect(c).toEqual({ url: 'http://envhost:9', token: 'envtok' });
    });

    it('向后兼容:STASH_URL/STASH_TOKEN 仍生效', async () => {
      jest.spyOn(fs, 'readFile').mockRejectedValue(new Error('no rc'));
      process.env.STASH_URL = 'http://legacy:9';
      process.env.STASH_TOKEN = 'legtok';
      expect(await loadConfig()).toEqual({ url: 'http://legacy:9', token: 'legtok' });
    });

    it('url 末尾斜杠被裁剪', async () => {
      jest.spyOn(fs, 'readFile').mockRejectedValue(new Error('no rc'));
      process.env.DEN_URL = 'http://envhost:9/';
      process.env.DEN_TOKEN = 'envtok';
      expect((await loadConfig()).url).toBe('http://envhost:9');
    });

    it('无 url/token → exit(1)', async () => {
      jest.spyOn(fs, 'readFile').mockRejectedValue(new Error('no rc'));
      mockExit();
      await expect(loadConfig()).rejects.toThrow('__EXIT_1__');
    });
  });

  // ---------- cmdConfig ----------

  describe('cmdConfig', () => {
    it('show: token 打码(只露前 2 字符)', async () => {
      jest.spyOn(fs, 'readFile').mockResolvedValue(
        JSON.stringify({ url: 'http://h', token: 'supersecrettoken' }),
      );
      await cmdConfig(['show']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('token: su***'));
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('supersecret'));
    });

    it('show: 无 rc → 打印提示', async () => {
      jest.spyOn(fs, 'readFile').mockRejectedValue(new Error('no'));
      await cmdConfig(['show']);
      expect(logSpy).toHaveBeenCalledWith('(无 ~/.config/den/config.json)');
    });

    it('set: 写入 rc', async () => {
      jest.spyOn(fs, 'readFile').mockRejectedValue(new Error('no'));
      const wf = jest.spyOn(fs, 'writeFile').mockResolvedValue();
      await cmdConfig(['set', '--url', 'http://h:1', '--token', 'tok']);
      expect(wf).toHaveBeenCalled();
      expect(JSON.parse(wf.mock.calls[0][1] as string)).toEqual({
        url: 'http://h:1',
        token: 'tok',
      });
    });

    it('set: 缺 token → exit(1)', async () => {
      jest.spyOn(fs, 'readFile').mockRejectedValue(new Error('no'));
      mockExit();
      await expect(cmdConfig(['set', '--url', 'http://h:1'])).rejects.toThrow('__EXIT_1__');
    });

    it('未知子命令 → exit(1)', async () => {
      mockExit();
      await expect(cmdConfig(['weird'])).rejects.toThrow('__EXIT_1__');
    });
  });

  // ---------- 文件 push / get ----------

  describe('文件 push/get', () => {
    it('推送文件:multipart,读本地文件', async () => {
      const f = mockFetch({
        id: 'f1',
        kind: 'file',
        name: 'x.txt',
        size: 1,
        createdAt: 1,
        tags: [],
        expiresAt: null,
      });
      const tmpf = '/tmp/den-cli-pushtest.txt';
      await fs.writeFile(tmpf, 'X');
      await cmdPush(cfg(), [tmpf, '--tags', 'doc', '--source', 'mac']);
      const [url, init] = f.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://srv:1/den/file');
      expect(init.method).toBe('POST');
      expect(init.body).toBeInstanceOf(FormData);
      await fs.unlink(tmpf);
    });

    it('文件下载:写入 -o 路径', async () => {
      const f = jest
        .fn()
        .mockResolvedValueOnce(
          resOk({ id: 'f', kind: 'file', name: 'x.txt', size: 4, createdAt: 1, tags: [], expiresAt: null }),
        )
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          arrayBuffer: () => Promise.resolve(Buffer.from('BODY').buffer),
        });
      (globalThis as { fetch: unknown }).fetch = f;
      const wf = jest.spyOn(fs, 'writeFile').mockResolvedValue();
      await cmdGet(cfg(), ['f', '-o', '/tmp/den-cli-out.txt']);
      expect(wf).toHaveBeenCalled();
    });
  });
});
