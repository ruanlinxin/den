import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BadRequestException, Logger, NotFoundException, StreamableFile } from '@nestjs/common';
import { DenController } from './den.controller';
import { DenStore } from './store';
import type { Entry } from './types';
import type { Response } from 'express';

type MockedStore = jest.Mocked<DenStore>;

function mockStore(): MockedStore {
  return {
    addText: jest.fn(),
    addFile: jest.fn(),
    list: jest.fn(),
    get: jest.fn(),
    remove: jest.fn(),
    addTags: jest.fn(),
    removeTag: jest.fn(),
    filePath: jest.fn((id: string) => `/tmp/files/${id}`),
  } as unknown as MockedStore;
}

const fakeEntry = (over: Partial<Entry> = {}): Entry => ({
  id: 'abc12345',
  kind: 'text',
  name: 'text.txt',
  size: 5,
  createdAt: 1_700_000_000_000,
  source: null,
  tags: [],
  expiresAt: null,
  ...over,
});

const mkRes = () => ({ set: jest.fn() }) as unknown as Response;

describe('DenController', () => {
  let controller: DenController;
  let store: MockedStore;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    store = mockStore();
    controller = new DenController(store);
    // controller.content() 创建 ReadStream 后立即返回 StreamableFile,测试不消费
    // 导致 GC 时 stream 关闭抛 ENOENT(防御性 error handler 会打日志,这里静默掉)
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  // ---------- pushText ----------

  describe('pushText', () => {
    it('text 缺失抛 BadRequest', async () => {
      await expect(controller.pushText({} as never)).rejects.toBeInstanceOf(BadRequestException);
      await expect(controller.pushText({ text: '' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('正常调用 addText 并透传 ttl/tags', async () => {
      const entry = fakeEntry();
      (store.addText as jest.Mock).mockResolvedValue(entry);
      const r = await controller.pushText({ text: 'hi', source: 'mac', ttl: 3600, tags: ['a'] });
      expect(store.addText).toHaveBeenCalledWith('hi', 'mac', 3600, ['a']);
      expect(r).toBe(entry);
    });
  });

  // ---------- pushFile ----------

  describe('pushFile', () => {
    it('缺 file 抛 BadRequest', async () => {
      await expect(controller.pushFile(undefined as never)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('正常调用 addFile,tags(逗号字符串)/ttl 解析正确', async () => {
      const entry = fakeEntry({ kind: 'file', name: 'a.pdf' });
      (store.addFile as jest.Mock).mockResolvedValue(entry);
      const file = { originalname: 'a.pdf', buffer: Buffer.from('x') } as never;
      await controller.pushFile(file, 'win', '120', 'doc, note');
      expect(store.addFile).toHaveBeenCalledWith(
        'a.pdf',
        Buffer.from('x'),
        'win',
        120,
        ['doc', 'note'],
      );
    });
  });

  // ---------- list ----------

  describe('list', () => {
    it('无过滤传空 filter', () => {
      (store.list as jest.Mock).mockReturnValue([]);
      controller.list();
      expect(store.list).toHaveBeenCalledWith({});
    });

    it('合法 kind + source + tag 透传', () => {
      controller.list('file', 'mac', 'note');
      expect(store.list).toHaveBeenCalledWith({ kind: 'file', source: 'mac', tag: 'note' });
    });

    it('非法 kind 被忽略', () => {
      controller.list('weird', undefined, undefined);
      expect(store.list).toHaveBeenCalledWith({});
    });
  });

  // ---------- one ----------

  describe('one', () => {
    it('不存在抛 NotFound', () => {
      (store.get as jest.Mock).mockReturnValue(undefined);
      expect(() => controller.one('nope')).toThrow(NotFoundException);
    });

    it('存在返回 entry', () => {
      const entry = fakeEntry();
      (store.get as jest.Mock).mockReturnValue(entry);
      expect(controller.one('abc')).toBe(entry);
    });
  });

  // ---------- content(用真实临时文件,避免 spy frozen 的 node:fs) ----------

  describe('content', () => {
    let blobDir: string;
    const blob = () => join(blobDir, 'abc12345');

    beforeEach(() => {
      blobDir = mkdtempSync(join(tmpdir(), 'ctrl-'));
      (store.filePath as jest.Mock).mockReturnValue(blob());
    });
    afterEach(() => rmSync(blobDir, { recursive: true, force: true }));

    it('entry 不存在抛 NotFound', async () => {
      (store.get as jest.Mock).mockReturnValue(undefined);
      await expect(controller.content('nope', undefined, mkRes())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('blob 缺失抛 NotFound', async () => {
      (store.get as jest.Mock).mockReturnValue(fakeEntry());
      // 不创建 blob 文件
      await expect(controller.content('abc', undefined, mkRes())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('text 默认 inline,file 默认 attachment,并设置响应头', async () => {
      writeFileSync(blob(), 'content');
      // text
      (store.get as jest.Mock).mockReturnValue(fakeEntry({ kind: 'text' }));
      const r1 = mkRes();
      const out1 = await controller.content('abc', undefined, r1);
      expect(out1).toBeInstanceOf(StreamableFile);
      expect(r1.set).toHaveBeenCalledWith(
        expect.objectContaining({ 'Content-Type': 'text/plain; charset=utf-8' }),
      );
      expect(r1.set).toHaveBeenCalledWith(
        expect.objectContaining({
          'Content-Disposition': expect.stringMatching(/^inline; filename="text\.txt"; filename\*=/),
        }),
      );
      // file
      (store.get as jest.Mock).mockReturnValue(fakeEntry({ kind: 'file', name: 'a.pdf' }));
      const r2 = mkRes();
      await controller.content('abc', undefined, r2);
      expect(r2.set).toHaveBeenCalledWith(
        expect.objectContaining({ 'Content-Type': 'application/octet-stream' }),
      );
      expect(r2.set).toHaveBeenCalledWith(
        expect.objectContaining({
          'Content-Disposition': expect.stringMatching(/^attachment; filename="a\.pdf"; filename\*=/),
        }),
      );
    });

    it('download=1 强制 attachment;download=0/false 保持 inline', async () => {
      writeFileSync(blob(), 'content');
      (store.get as jest.Mock).mockReturnValue(fakeEntry({ kind: 'text' }));
      const r1 = mkRes();
      await controller.content('abc', '1', r1);
      expect(r1.set).toHaveBeenCalledWith(
        expect.objectContaining({
          'Content-Disposition': expect.stringMatching(/^attachment; filename="text\.txt"; filename\*=/),
        }),
      );
      const r0 = mkRes();
      await controller.content('abc', '0', r0);
      expect(r0.set).toHaveBeenCalledWith(
        expect.objectContaining({
          'Content-Disposition': expect.stringMatching(/^inline; filename="text\.txt"; filename\*=/),
        }),
      );
    });
  });

  // ---------- remove ----------

  describe('remove', () => {
    it('不存在抛 NotFound', async () => {
      (store.remove as jest.Mock).mockResolvedValue(false);
      await expect(controller.remove('nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('存在返回 { ok: true }', async () => {
      (store.remove as jest.Mock).mockResolvedValue(true);
      await expect(controller.remove('abc')).resolves.toEqual({ ok: true });
    });
  });

  // ---------- addTags ----------

  describe('addTags', () => {
    it('entry 不存在抛 NotFound', () => {
      (store.get as jest.Mock).mockReturnValue(undefined);
      expect(() => controller.addTags('nope', ['a'])).toThrow(NotFoundException);
    });

    it('数组 tags 透传并返回最新 entry', () => {
      const entry = fakeEntry({ tags: ['a'] });
      (store.get as jest.Mock).mockReturnValue(entry);
      const r = controller.addTags('abc', ['a', 'b']);
      expect(store.addTags).toHaveBeenCalledWith('abc', ['a', 'b']);
      expect(r).toBe(entry);
    });

    it('逗号字符串也能解析', () => {
      (store.get as jest.Mock).mockReturnValue(fakeEntry());
      controller.addTags('abc', 'x, y ,z');
      expect(store.addTags).toHaveBeenCalledWith('abc', ['x', 'y', 'z']);
    });
  });

  // ---------- removeTag ----------

  describe('removeTag', () => {
    it('entry 不存在抛 NotFound', () => {
      (store.get as jest.Mock).mockReturnValue(undefined);
      expect(() => controller.removeTag('nope', 'x')).toThrow(NotFoundException);
    });

    it('decode tag 后调用 removeTag', () => {
      (store.get as jest.Mock).mockReturnValue(fakeEntry());
      controller.removeTag('abc', '%E4%B8%AD%E6%96%87'); // "中文"
      expect(store.removeTag).toHaveBeenCalledWith('abc', '中文');
    });
  });
});
