import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import Database from 'better-sqlite3';
import { promises as fs, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { nanoid } from 'nanoid';
import type { Entry, Kind, ListFilter } from './types';

/**
 * StashStore — SQLite 单后端存储
 *
 * 目录结构(默认 ~/.stash):
 *   ~/.stash/
 *   ├── stash.db         SQLite 数据库(元信息 + 标签)
 *   └── files/<id>       原始文件字节(text 也存成文件,blob 始终留文件系统)
 *
 * 设计要点:
 * - better-sqlite3 是同步 API,所有 DB 操作天然串行,无需额外队列
 * - 开启 WAL + foreign_keys(ON DELETE CASCADE 清理 entry_tags)
 * - blob 写入成功后才 INSERT;删除先 DELETE(cascade tags)再删 blob
 * - TTL:列 expires_at(ms),查询惰性过滤(已过期视为不存在),purgeExpired() 物理清理
 */
@Injectable()
export class StashStore implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StashStore.name);
  private db!: InstanceType<typeof Database>;
  private timer?: NodeJS.Timeout;
  private readonly dataDir: string;
  private readonly filesDir: string;
  private readonly dbPath: string;

  private static readonly MAX_ID_RETRIES = 8;

  constructor() {
    this.dataDir = process.env.STASH_DATA_DIR ?? path.join(os.homedir(), '.stash');
    this.filesDir = path.join(this.dataDir, 'files');
    this.dbPath = path.join(this.dataDir, 'stash.db');
  }

  async onModuleInit() {
    await fs.mkdir(this.filesDir, { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL CHECK (kind IN ('text','file')),
        name       TEXT NOT NULL,
        size       INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        source     TEXT,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_entries_expires_at ON entries (expires_at);
      CREATE TABLE IF NOT EXISTS entry_tags (
        entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
        tag      TEXT NOT NULL,
        PRIMARY KEY (entry_id, tag)
      );
      CREATE INDEX IF NOT EXISTS idx_tags_tag ON entry_tags (tag);
    `);
    const { n } = this.db
      .prepare('SELECT COUNT(*) AS n FROM entries')
      .get() as { n: number };
    this.logger.log(`SQLite ready at ${this.dbPath} (${n} entries).`);
    const intervalSec = Math.max(1, Number(process.env.STASH_PURGE_INTERVAL_SEC ?? 60));
    this.timer = setInterval(() => this.purgeExpired(), intervalSec * 1000);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.db?.close();
  }

  /** blob 文件绝对路径 */
  filePath(id: string): string {
    return path.join(this.filesDir, id);
  }

  /** 把 ttl(秒)转成绝对过期时间(ms);非法/缺省 → null(永不过期) */
  private static ttlToExpiresAt(ttl?: number): number | null {
    if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) return null;
    return Date.now() + Math.floor(ttl * 1000);
  }

  /** 规范化标签数组:去重、去空白、排序 */
  private static normalizeTags(tags?: string[]): string[] {
    if (!tags || tags.length === 0) return [];
    const set = new Set<string>();
    for (const t of tags) {
      const s = String(t).trim();
      if (s) set.add(s);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  /** entry 是否存在(按 id) */
  private exists(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM entries WHERE id = ?').get(id);
  }

  /** 生成不冲突的 nanoid(8) */
  private genId(): string {
    const stmt = this.db.prepare('SELECT 1 FROM entries WHERE id = ?');
    for (let i = 0; i < StashStore.MAX_ID_RETRIES; i++) {
      const id = nanoid(8);
      if (!stmt.get(id)) return id;
    }
    throw new Error('failed to generate unique id after retries');
  }

  private writeTags(entryId: string, tags: string[]): void {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES (?, ?)',
    );
    for (const t of tags) stmt.run(entryId, t);
  }

  private loadTagsFor(entryId: string): string[] {
    const rows = this.db
      .prepare('SELECT tag FROM entry_tags WHERE entry_id = ? ORDER BY tag')
      .all(entryId) as { tag: string }[];
    return rows.map((r) => r.tag);
  }

  private rowToEntry(
    row: {
      id: string;
      kind: Kind;
      name: string;
      size: number;
      created_at: number;
      source: string | null;
      expires_at: number | null;
    },
    tags: string[],
  ): Entry {
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      size: row.size,
      createdAt: row.created_at,
      source: row.source,
      tags,
      expiresAt: row.expires_at,
    };
  }

  /** 写 blob + 事务插入 entry + tags,返回完整 Entry */
  private async create(
    kind: Kind,
    name: string,
    buf: Buffer,
    source: string | undefined,
    ttl: number | undefined,
    tags: string[] | undefined,
  ): Promise<Entry> {
    const id = this.genId();
    await fs.writeFile(this.filePath(id), buf);
    const createdAt = Date.now();
    const expiresAt = StashStore.ttlToExpiresAt(ttl);
    const normTags = StashStore.normalizeTags(tags);
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO entries (id, kind, name, size, created_at, source, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, kind, name, buf.length, createdAt, source ?? null, expiresAt);
      this.writeTags(id, normTags);
    });
    insert();
    return { id, kind, name, size: buf.length, createdAt, source: source ?? null, tags: normTags, expiresAt };
  }

  addText(text: string, source?: string, ttl?: number, tags?: string[]): Promise<Entry> {
    const buf = Buffer.from(text, 'utf8');
    return this.create('text', 'text.txt', buf, source, ttl, tags);
  }

  addFile(
    originalname: string,
    buf: Buffer,
    source?: string,
    ttl?: number,
    tags?: string[],
  ): Promise<Entry> {
    const name = originalname || `file-${Date.now()}`;
    return this.create('file', name, buf, source, ttl, tags);
  }

  /** 列表:按 created_at 降序;惰性过滤已过期项;支持 kind/source/tag 过滤 */
  list(filter: ListFilter = {}): Entry[] {
    const where: string[] = [];
    const params: unknown[] = [];
    where.push('(expires_at IS NULL OR expires_at > ?)');
    params.push(Date.now());
    if (filter.kind) {
      where.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.source) {
      where.push('source = ?');
      params.push(filter.source);
    }
    if (filter.tag) {
      where.push('id IN (SELECT entry_id FROM entry_tags WHERE tag = ?)');
      params.push(filter.tag);
    }
    const sql = `SELECT * FROM entries WHERE ${where.join(' AND ')} ORDER BY created_at DESC`;
    const rows = this.db.prepare(sql).all(...params) as {
      id: string;
      kind: Kind;
      name: string;
      size: number;
      created_at: number;
      source: string | null;
      expires_at: number | null;
    }[];
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const tagRows = this.db
      .prepare(
        `SELECT entry_id, tag FROM entry_tags WHERE entry_id IN (${placeholders}) ORDER BY tag`,
      )
      .all(...ids) as { entry_id: string; tag: string }[];
    const tagMap = new Map<string, string[]>();
    for (const tr of tagRows) {
      let arr = tagMap.get(tr.entry_id);
      if (!arr) {
        arr = [];
        tagMap.set(tr.entry_id, arr);
      }
      arr.push(tr.tag);
    }
    return rows.map((r) => this.rowToEntry(r, tagMap.get(r.id) ?? []));
  }

  /** 单条元信息;已过期视为不存在 */
  get(id: string): Entry | undefined {
    const row = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as
      | {
          id: string;
          kind: Kind;
          name: string;
          size: number;
          created_at: number;
          source: string | null;
          expires_at: number | null;
        }
      | undefined;
    if (!row) return undefined;
    if (row.expires_at !== null && row.expires_at <= Date.now()) return undefined;
    return this.rowToEntry(row, this.loadTagsFor(id));
  }

  /** 物理删除:DELETE(cascade tags)+ 删 blob */
  async remove(id: string): Promise<boolean> {
    const exists = this.db.prepare('SELECT 1 FROM entries WHERE id = ?').get(id);
    if (!exists) return false;
    this.db.prepare('DELETE FROM entries WHERE id = ?').run(id);
    try {
      await fs.unlink(this.filePath(id));
    } catch {
      /* blob 缺失,忽略 */
    }
    return true;
  }

  /** 给条目追加标签(已存在则忽略),返回最新标签列表 */
  addTags(id: string, tags: string[]): string[] {
    if (!this.exists(id)) return [];
    const norm = StashStore.normalizeTags(tags);
    if (norm.length > 0) {
      this.writeTags(id, norm);
    }
    return this.loadTagsFor(id);
  }

  /** 删除单个标签,返回最新标签列表 */
  removeTag(id: string, tag: string): string[] {
    this.db
      .prepare('DELETE FROM entry_tags WHERE entry_id = ? AND tag = ?')
      .run(id, tag);
    return this.loadTagsFor(id);
  }

  /** 物理清理所有已过期条目(blob + 记录),返回清理条数 */
  purgeExpired(): number {
    const now = Date.now();
    const rows = this.db
      .prepare('SELECT id FROM entries WHERE expires_at IS NOT NULL AND expires_at <= ?')
      .all(now) as { id: string }[];
    if (rows.length === 0) return 0;
    const ids = rows.map((r) => r.id);
    const del = this.db.transaction(() => {
      const stmt = this.db.prepare('DELETE FROM entries WHERE id = ?');
      for (const id of ids) stmt.run(id);
    });
    del();
    for (const id of ids) {
      const p = this.filePath(id);
      if (existsSync(p)) {
        try {
          unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
    }
    this.logger.log(`Purged ${ids.length} expired entries.`);
    return ids.length;
  }
}
