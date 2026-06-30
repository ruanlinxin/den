import { promises as fs } from 'node:fs';
import { cmdPush, cmdRm, cmdTag, cmdLs, cmdGet, cmdConfig, loadConfig } from './cli';

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

/** mock process.exit:抛错以中断后续执行,便于断言 */
function mockExit() {
  return jest.spyOn(process, 'exit').mockImplementation(((code = 0) => {
    throw new Error(`EXIT_${code}`);
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
    it('推送文本:正确构造 POST /stash/text(含 ttl/tags)', async () => {
      const f = mockFetch({ id: 'abc', kind: 'text', name: 'text.txt', size: 2, createdAt: 1, tags: [], expiresAt: null });
      await cmdPush(cfg(), ['-m', 'hi', '--tags', 'a,b', '--source', 'mac', '--ttl', '1h']);
      const [url, init] = f.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://srv:1/stash/text');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({
        text: 'hi',
        source: 'mac',
        ttl: 3600,
        tags: ['a', 'b'],
      });
    });

    it('缺 -m 与文件 → exit(1)', async () => {
      const exit = mockExit();
      await expect(cmdPush(cfg(), [])).rejects.toThrow('EXIT_1');
      expect(exit).toHaveBeenCalledWith(1);
    });
  });

  // ---------- cmdRm ----------

  describe('cmdRm', () => {
    it('DELETE /stash/:id', async () => {
      const f = mockFetch({ ok: true });
      await cmdRm(cfg(), ['abc']);
      const [url, init] = f.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://srv:1/stash/abc');
      expect(init.method).toBe('DELETE');
    });

    it('缺 id → exit(1)', async () => {
      mockExit();
      await expect(cmdRm(cfg(), [])).rejects.toThrow('EXIT_1');
    });
  });

  // ---------- cmdTag ----------

  describe('cmdTag', () => {
    it('add:POST /stash/:id/tags', async () => {
      const f = mockFetch({ id: 'abc', tags: ['x', 'y'] });
      await cmdTag(cfg(), ['abc', 'add', 'x,y']);
      const [url, init] = f.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://srv:1/stash/abc/tags');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ tags: ['x', 'y'] });
    });

    it('rm:DELETE /stash/:id/tags/:tag(URL 编码)', async () => {
      const f = mockFetch({ id: 'abc', tags: [] });
      await cmdTag(cfg(), ['abc', 'rm', '中 文']);
      const [url, init] = f.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://srv:1/stash/abc/tags/' + encodeURIComponent('中 文'));
      expect(init.method).toBe('DELETE');
    });

    it('用法不全 → exit(1)', async () => {
      mockExit();
      await expect(cmdTag(cfg(), ['abc'])).rejects.toThrow('EXIT_1');
    });
  });

  // ---------- cmdLs ----------

  describe('cmdLs', () => {
    it('GET /stash 带 query(kind/tag/source)', async () => {
      const f = mockFetch([
        { id: 'a', kind: 'text', name: 'text.txt', size: 1, createdAt: 1, tags: [], expiresAt: null },
      ]);
      await cmdLs(cfg(), ['--tag', 'note', '--kind', 'text', '--source', 'mac']);
      const url = (f.mock.calls[0] as [string, RequestInit])[0];
      expect(url).toContain('/stash?');
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
        // GET /stash/:id → entry meta
        .mockResolvedValueOnce(resOk({ id: 'a', kind: 'text', name: 'text.txt', size: 3, createdAt: 1, tags: [], expiresAt: null }))
        // GET /stash/:id/content → 正文
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
      await expect(loadConfig()).rejects.toThrow('EXIT_1');
    });
  });

  // ---------- cmdConfig ----------

  describe('cmdConfig', () => {
    it('show: 读取并打印 rc', async () => {
      jest.spyOn(fs, 'readFile').mockResolvedValue(
        JSON.stringify({ url: 'http://h', token: 't' }),
      );
      await cmdConfig(['show']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('http://h'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('token: t'));
    });

    it('show: 无 rc → 打印提示', async () => {
      jest.spyOn(fs, 'readFile').mockRejectedValue(new Error('no'));
      await cmdConfig(['show']);
      expect(logSpy).toHaveBeenCalledWith('(无 ~/.denrc)');
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
      await expect(cmdConfig(['set', '--url', 'http://h:1'])).rejects.toThrow('EXIT_1');
    });

    it('未知子命令 → exit(1)', async () => {
      mockExit();
      await expect(cmdConfig(['weird'])).rejects.toThrow('EXIT_1');
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
      const tmpf = '/tmp/stash-cli-pushtest.txt';
      await fs.writeFile(tmpf, 'X');
      await cmdPush(cfg(), [tmpf, '--tags', 'doc', '--source', 'mac']);
      const [url, init] = f.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://srv:1/stash/file');
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
      await cmdGet(cfg(), ['f', '-o', '/tmp/stash-cli-out.txt']);
      expect(wf).toHaveBeenCalled();
    });
  });
});
