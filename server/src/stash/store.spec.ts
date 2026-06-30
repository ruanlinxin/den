import { Test } from '@nestjs/testing';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { StashStore } from './store';
import type { Entry } from './types';

/**
 * StashStore 单元测试:用真实 SQLite + 临时目录(每个用例独立 dataDir)。
 * 不 mock 数据库,保证 SQL/事务/级联/WAL 行为被真实覆盖。
 */
describe('StashStore', () => {
  let store: StashStore;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'stash-test-'));
    process.env.STASH_DATA_DIR = dataDir;
    process.env.STASH_PURGE_INTERVAL_SEC = '3600'; // 测试期间不跑定时清理
    const modRef = await Test.createTestingModule({ providers: [StashStore] }).compile();
    store = modRef.get(StashStore);
    await store.onModuleInit();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    store.onModuleDestroy();
    delete process.env.STASH_DATA_DIR;
    delete process.env.STASH_PURGE_INTERVAL_SEC;
    await rm(dataDir, { recursive: true, force: true });
  });

  const fileExists = (p: string) =>
    access(p).then(
      () => true,
      () => false,
    );

  // ---------- addText ----------

  describe('addText', () => {
    it('返回完整 entry 并落盘 blob', async () => {
      const e = await store.addText('hello', 'mac', 3600, ['note']);
      expect(e.id).toHaveLength(8);
      expect(e.kind).toBe('text');
      expect(e.name).toBe('text.txt');
      expect(e.size).toBe(5);
      expect(e.source).toBe('mac');
      expect(e.tags).toEqual(['note']);
      expect(e.expiresAt).toBeGreaterThan(Date.now());
      expect(await fileExists(store.filePath(e.id))).toBe(true);
      expect(await readFile(store.filePath(e.id), 'utf8')).toBe('hello');
    });

    it('无 source/tags/ttl 时给安全默认值', async () => {
      const e = await store.addText('x');
      expect(e.source).toBeNull();
      expect(e.tags).toEqual([]);
      expect(e.expiresAt).toBeNull();
    });

    it('ttl<=0 视为永不过期', async () => {
      expect((await store.addText('a', undefined, 0)).expiresAt).toBeNull();
      expect((await store.addText('a', undefined, -5)).expiresAt).toBeNull();
      expect((await store.addText('a', undefined, NaN)).expiresAt).toBeNull();
    });

    it('expiresAt ≈ now + ttl 秒', async () => {
      const before = Date.now();
      const e = await store.addText('a', undefined, 120);
      const after = Date.now();
      expect(e.expiresAt).toBeGreaterThanOrEqual(before + 120_000);
      expect(e.expiresAt).toBeLessThanOrEqual(after + 120_000);
    });
  });

  // ---------- addFile ----------

  describe('addFile', () => {
    it('kind=file 并保留原始文件名', async () => {
      const buf = Buffer.from('filebody');
      const e = await store.addFile('report.pdf', buf, 'win');
      expect(e.kind).toBe('file');
      expect(e.name).toBe('report.pdf');
      expect(e.size).toBe(8);
      expect(await readFile(store.filePath(e.id))).toEqual(buf);
    });

    it('空文件名时兜底命名', async () => {
      const e = await store.addFile('', Buffer.from('x'));
      expect(e.name).toMatch(/^file-\d+$/);
    });
  });

  // ---------- list ----------

  describe('list', () => {
    it('按 createdAt 降序并聚合 tags', async () => {
      const a = await store.addText('a', undefined, undefined, ['x']);
      await new Promise((r) => setTimeout(r, 5));
      const b = await store.addText('b', undefined, undefined, ['y', 'z']);
      const list = store.list();
      expect(list.map((e) => e.id)).toEqual([b.id, a.id]);
      expect(list[1].tags).toEqual(['x']);
      expect(list[0].tags).toEqual(['y', 'z']); // 排序后
    });

    it('按 kind 过滤', async () => {
      await store.addText('t');
      await store.addFile('f.pdf', Buffer.from('f'));
      expect(store.list({ kind: 'text' }).every((e) => e.kind === 'text')).toBe(true);
      expect(store.list({ kind: 'file' }).map((e) => e.kind)).toEqual(['file']);
    });

    it('按 source 过滤', async () => {
      await store.addText('1', 'mac');
      await store.addText('2', 'win');
      expect(store.list({ source: 'mac' }).map((e) => e.source)).toEqual(['mac']);
    });

    it('按 tag 过滤', async () => {
      await store.addText('1', undefined, undefined, ['note', 'work']);
      await store.addText('2', undefined, undefined, ['work']);
      expect(store.list({ tag: 'note' })).toHaveLength(1);
      expect(store.list({ tag: 'work' })).toHaveLength(2);
      expect(store.list({ tag: 'missing' })).toHaveLength(0);
    });

    it('隐藏已过期条目', async () => {
      const base = 1_700_000_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(base);
      const dead = await store.addText('dead', undefined, 3600);
      nowSpy.mockReturnValue(base + 1_800_000);
      const alive = await store.addText('alive', undefined, 10_000_000);
      nowSpy.mockReturnValue(base + 7_200_000);
      const list = store.list();
      expect(list.map((e) => e.id)).toContain(alive.id);
      expect(list.map((e) => e.id)).not.toContain(dead.id);
    });
  });

  // ---------- get ----------

  describe('get', () => {
    it('返回单条含 tags', async () => {
      const created = await store.addText('hi', undefined, undefined, ['a']);
      const e = store.get(created.id);
      expect(e?.tags).toEqual(['a']);
    });

    it('不存在返回 undefined', () => {
      expect(store.get('nope-id')).toBeUndefined();
    });

    it('已过期视为不存在', async () => {
      const base = 1_700_000_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(base);
      const created = await store.addText('x', undefined, 3600);
      nowSpy.mockReturnValue(base + 7_200_000);
      expect(store.get(created.id)).toBeUndefined();
    });
  });

  // ---------- remove ----------

  describe('remove', () => {
    it('存在:删记录 + 删 blob,返回 true', async () => {
      const e = await store.addText('x', undefined, undefined, ['t']);
      const blobPath = store.filePath(e.id);
      expect(await fileExists(blobPath)).toBe(true);
      expect(await store.remove(e.id)).toBe(true);
      expect(store.get(e.id)).toBeUndefined();
      expect(await fileExists(blobPath)).toBe(false);
    });

    it('不存在返回 false', async () => {
      expect(await store.remove('nope')).toBe(false);
    });

    it('删除后级联清除标签(同 id 不会残留)', async () => {
      const e = await store.addText('x', undefined, undefined, ['t1', 't2']);
      await store.remove(e.id);
      // 重新用同 id 插入(模拟)——通过 list?tag 确认旧标签已消失
      expect(store.list({ tag: 't1' })).toHaveLength(0);
      expect(store.list({ tag: 't2' })).toHaveLength(0);
    });
  });

  // ---------- 标签管理 ----------

  describe('addTags / removeTag', () => {
    it('addTags 幂等 + 规范化(去空白/去重)', async () => {
      const e = await store.addText('x');
      const after1 = store.addTags(e.id, [' note ', 'note', '', 'work']);
      expect(after1).toEqual(['note', 'work']);
      const after2 = store.addTags(e.id, ['note']); // 已存在,忽略
      expect(after2).toEqual(['note', 'work']);
    });

    it('addTags 不存在的 entry 返回空数组(不报错)', () => {
      expect(store.addTags('nope', ['x'])).toEqual([]);
    });

    it('removeTag 删单个并返回最新列表', async () => {
      const e = await store.addText('x', undefined, undefined, ['a', 'b', 'c']);
      expect(store.removeTag(e.id, 'b')).toEqual(['a', 'c']);
      // 再删一个不存在的 tag 不报错
      expect(store.removeTag(e.id, 'zzz')).toEqual(['a', 'c']);
    });
  });

  // ---------- TTL 物理清理 ----------

  describe('purgeExpired', () => {
    it('清理已过期条目(记录 + blob),保留未过期', async () => {
      const base = 1_700_000_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(base);
      const alive = await store.addText('alive', undefined, 10_000_000);
      const dead = await store.addText('dead', undefined, 3600);
      const deadBlob = store.filePath(dead.id);
      nowSpy.mockReturnValue(base + 7_200_000);
      const n = store.purgeExpired();
      expect(n).toBe(1);
      expect(store.get(alive.id)).toBeDefined();
      expect(store.get(dead.id)).toBeUndefined();
      expect(await fileExists(deadBlob)).toBe(false);
    });

    it('没有过期项时返回 0', async () => {
      await store.addText('alive', undefined, 3600);
      expect(store.purgeExpired()).toBe(0);
    });

    it('blob 已缺失时不报错', async () => {
      const base = 1_700_000_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(base);
      const dead = await store.addText('dead', undefined, 3600);
      nowSpy.mockReturnValue(base + 7_200_000);
      await rm(store.filePath(dead.id));
      expect(() => store.purgeExpired()).not.toThrow();
    });
  });

  // ---------- ID 唯一性 ----------

  describe('ID 唯一性', () => {
    it('批量插入无重复 id', async () => {
      const ids = new Set<string>();
      for (let i = 0; i < 50; i++) {
        ids.add((await store.addText(`t${i}`)).id);
      }
      expect(ids.size).toBe(50);
    });
  });
});
