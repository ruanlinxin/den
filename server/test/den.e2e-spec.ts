/**
 * den e2e 测试 — 走完整 HTTP 链路(Guard → Controller → Store → SQLite),
 * 鉴权、CRUD、过滤、TTL、标签、上限都覆盖。supertest 驱动 NestJS app。
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { json, urlencoded } from 'express';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('den e2e (HTTP 全链路)', () => {
  let app: INestApplication;
  let token: string;
  let dataDir: string;
  const bearer = () => `Bearer ${token}`;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'den-e2e-'));
    token = 'test-token-abc123';
    process.env.DEN_DATA_DIR = dataDir;
    process.env.DEN_TOKEN = token;
    // 长间隔,免得测试期间后台跑 purge
    process.env.DEN_PURGE_INTERVAL_SEC = '3600';
    // e2e body 限制调小,避免 413 测试要发 2mb 数据;1mb 是生产默认
    process.env.DEN_BODY_LIMIT = '1mb';

    const modRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = modRef.createNestApplication({ bodyParser: false });
    // 与 main.ts 一致:关默认 bodyParser,自己装
    app.use(json({ limit: process.env.DEN_BODY_LIMIT }));
    app.use(urlencoded({ limit: process.env.DEN_BODY_LIMIT, extended: true }));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DEN_DATA_DIR;
    delete process.env.DEN_TOKEN;
    delete process.env.DEN_PURGE_INTERVAL_SEC;
    delete process.env.DEN_BODY_LIMIT;
  });

  // ---------- 鉴权 + 健康检查 ----------

  describe('鉴权 / 健康检查', () => {
    it('GET /health 无 token → 200', async () => {
      const r = await request(app.getHttpServer()).get('/health');
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true });
    });

    it('GET / 无 token → 200', async () => {
      const r = await request(app.getHttpServer()).get('/');
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, service: 'den' });
    });

    it('保护路径无 token → 401', async () => {
      const r = await request(app.getHttpServer()).get('/den');
      expect(r.status).toBe(401);
    });

    it('保护路径错 token → 401', async () => {
      const r = await request(app.getHttpServer())
        .get('/den')
        .set('Authorization', 'Bearer wrong');
      expect(r.status).toBe(401);
    });

    it('Bearer token 正确 → 200', async () => {
      const r = await request(app.getHttpServer()).get('/den').set('Authorization', bearer());
      expect(r.status).toBe(200);
    });

    it('X-Den-Token 正确 → 200', async () => {
      const r = await request(app.getHttpServer()).get('/den').set('X-Den-Token', token);
      expect(r.status).toBe(200);
    });
  });

  // ---------- POST /den/text ----------

  describe('POST /den/text', () => {
    it('正常推送:返回 entry,含 id/tags/expiresAt', async () => {
      const r = await request(app.getHttpServer())
        .post('/den/text')
        .set('Authorization', bearer())
        .send({ text: 'hello', source: 'mac', tags: ['note'], ttl: 3600 });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({
        kind: 'text',
        name: 'text.txt',
        size: 5,
        source: 'mac',
        tags: ['note'],
      });
      expect(r.body.id).toHaveLength(8);
      expect(r.body.expiresAt).toBeGreaterThan(Date.now());
    });

    it('缺 text → 400', async () => {
      const r = await request(app.getHttpServer())
        .post('/den/text')
        .set('Authorization', bearer())
        .send({});
      expect(r.status).toBe(400);
      // BadRequestException 默认响应体可能为 string / object,提取文本检查
      const msg = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      expect(msg).toContain('text');
    });

    it('text 空串 → 400', async () => {
      const r = await request(app.getHttpServer())
        .post('/den/text')
        .set('Authorization', bearer())
        .send({ text: '' });
      expect(r.status).toBe(400);
    });
  });

  // ---------- POST /den/file ----------

  describe('POST /den/file', () => {
    it('正常推送文件', async () => {
      const r = await request(app.getHttpServer())
        .post('/den/file')
        .set('Authorization', bearer())
        .attach('file', Buffer.from('PDF-CONTENT'), 'doc.pdf')
        .field('source', 'win')
        .field('tags', 'work,doc');
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({
        kind: 'file',
        name: 'doc.pdf',
        size: 11,
        source: 'win',
        tags: ['doc', 'work'],
      });
    });

    it('缺 file → 400', async () => {
      const r = await request(app.getHttpServer())
        .post('/den/file')
        .set('Authorization', bearer())
        .send({});
      expect(r.status).toBe(400);
    });
  });

  // ---------- GET /den (列表 + 过滤) ----------

  describe('GET /den (列表)', () => {
    it('按 kind=file 过滤', async () => {
      // 先 push 一个 text 和一个 file
      await request(app.getHttpServer())
        .post('/den/text')
        .set('Authorization', bearer())
        .send({ text: 'list-text' });
      await request(app.getHttpServer())
        .post('/den/file')
        .set('Authorization', bearer())
        .attach('file', Buffer.from('x'), 'f.bin');
      const r = await request(app.getHttpServer())
        .get('/den?kind=file')
        .set('Authorization', bearer());
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
      expect(r.body.every((e: { kind: string }) => e.kind === 'file')).toBe(true);
    });

    it('按 tag 过滤', async () => {
      const id = (
        await request(app.getHttpServer())
          .post('/den/text')
          .set('Authorization', bearer())
          .send({ text: 'tagged', tags: ['unique-tag-xyz'] })
      ).body.id;
      const r = await request(app.getHttpServer())
        .get('/den?tag=unique-tag-xyz')
        .set('Authorization', bearer());
      expect(r.status).toBe(200);
      expect(r.body.map((e: { id: string }) => e.id)).toContain(id);
    });
  });

  // ---------- GET /den/:id ----------

  describe('GET /den/:id', () => {
    it('存在 → 200 + entry', async () => {
      const push = await request(app.getHttpServer())
        .post('/den/text')
        .set('Authorization', bearer())
        .send({ text: 'meta-test' });
      const id = push.body.id;
      const r = await request(app.getHttpServer())
        .get(`/den/${id}`)
        .set('Authorization', bearer());
      expect(r.status).toBe(200);
      expect(r.body.id).toBe(id);
    });

    it('不存在 → 404', async () => {
      const r = await request(app.getHttpServer())
        .get('/den/zzzz9999')
        .set('Authorization', bearer());
      expect(r.status).toBe(404);
    });
  });

  // ---------- GET /den/:id/content ----------

  describe('GET /den/:id/content', () => {
    it('text 默认 inline + 正确 content-type', async () => {
      const push = await request(app.getHttpServer())
        .post('/den/text')
        .set('Authorization', bearer())
        .send({ text: 'inline-test' });
      const r = await request(app.getHttpServer())
        .get(`/den/${push.body.id}/content`)
        .set('Authorization', bearer());
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toMatch(/text\/plain/);
      expect(r.headers['content-disposition']).toMatch(/inline/);
      expect(r.text).toBe('inline-test');
    });

    it('text + download=1 → attachment', async () => {
      const push = await request(app.getHttpServer())
        .post('/den/text')
        .set('Authorization', bearer())
        .send({ text: 'download-test' });
      const r = await request(app.getHttpServer())
        .get(`/den/${push.body.id}/content?download=1`)
        .set('Authorization', bearer());
      expect(r.status).toBe(200);
      expect(r.headers['content-disposition']).toMatch(/attachment/);
    });

    it('file → application/octet-stream + attachment', async () => {
      const push = await request(app.getHttpServer())
        .post('/den/file')
        .set('Authorization', bearer())
        .attach('file', Buffer.from('FILE-BODY'), 'doc.pdf');
      const r = await request(app.getHttpServer())
        .get(`/den/${push.body.id}/content`)
        .set('Authorization', bearer());
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toMatch(/octet-stream/);
      expect(r.headers['content-disposition']).toMatch(/attachment.*doc\.pdf/);
      expect(r.body.toString()).toBe('FILE-BODY');
    });

    it('不存在 → 404', async () => {
      const r = await request(app.getHttpServer())
        .get('/den/zzzz9999/content')
        .set('Authorization', bearer());
      expect(r.status).toBe(404);
    });
  });

  // ---------- DELETE /den/:id ----------

  describe('DELETE /den/:id', () => {
    it('存在 → 200 + 真删', async () => {
      const push = await request(app.getHttpServer())
        .post('/den/text')
        .set('Authorization', bearer())
        .send({ text: 'to-delete' });
      const id = push.body.id;
      const del = await request(app.getHttpServer())
        .delete(`/den/${id}`)
        .set('Authorization', bearer());
      expect(del.status).toBe(200);
      expect(del.body).toEqual({ ok: true });
      const after = await request(app.getHttpServer())
        .get(`/den/${id}`)
        .set('Authorization', bearer());
      expect(after.status).toBe(404);
    });

    it('不存在 → 404', async () => {
      const r = await request(app.getHttpServer())
        .delete('/den/zzzz9999')
        .set('Authorization', bearer());
      expect(r.status).toBe(404);
    });
  });

  // ---------- 标签管理 ----------

  describe('POST/DELETE 标签', () => {
    it('追加标签(幂等)', async () => {
      const push = await request(app.getHttpServer())
        .post('/den/text')
        .set('Authorization', bearer())
        .send({ text: 'tags-test' });
      const id = push.body.id;
      const r1 = await request(app.getHttpServer())
        .post(`/den/${id}/tags`)
        .set('Authorization', bearer())
        .send({ tags: ['foo', 'bar'] });
      // NestJS @Post 默认 HttpCode 201,这里沿用 201
      expect(r1.status).toBe(201);
      expect(r1.body.tags).toEqual(['bar', 'foo']);
      // 重复添加
      const r2 = await request(app.getHttpServer())
        .post(`/den/${id}/tags`)
        .set('Authorization', bearer())
        .send({ tags: ['foo'] });
      expect(r2.body.tags).toEqual(['bar', 'foo']);
    });

    it('删除单个标签(URL 编码支持中文)', async () => {
      const push = await request(app.getHttpServer())
        .post('/den/text')
        .set('Authorization', bearer())
        .send({ text: 'rm-tag', tags: ['中文'] });
      const id = push.body.id;
      const r = await request(app.getHttpServer())
        .delete(`/den/${id}/tags/${encodeURIComponent('中文')}`)
        .set('Authorization', bearer());
      expect(r.status).toBe(200);
      expect(r.body.tags).toEqual([]);
    });

    it('id 不存在 → 404', async () => {
      const r = await request(app.getHttpServer())
        .post('/den/zzzz9999/tags')
        .set('Authorization', bearer())
        .send({ tags: ['x'] });
      expect(r.status).toBe(404);
    });
  });

  // ---------- 上限 (body 1mb / file 100mb) ----------

  describe('上限', () => {
    it('text 超过 1mb → 413', async () => {
      const big = 'x'.repeat(2 * 1024 * 1024); // 2mb
      const r = await request(app.getHttpServer())
        .post('/den/text')
        .set('Authorization', bearer())
        .send({ text: big });
      expect(r.status).toBe(413);
    });
  });

  // ---------- TTL 行为 ----------

  describe('TTL', () => {
    it('ttl=0 视作永不过期', async () => {
      const r = await request(app.getHttpServer())
        .post('/den/text')
        .set('Authorization', bearer())
        .send({ text: 'forever', ttl: 0 });
      expect(r.status).toBe(201);
      expect(r.body.expiresAt).toBeNull();
    });

    it('ttl=负数视作永不过期', async () => {
      const r = await request(app.getHttpServer())
        .post('/den/text')
        .set('Authorization', bearer())
        .send({ text: 'forever2', ttl: -1 });
      expect(r.status).toBe(201);
      expect(r.body.expiresAt).toBeNull();
    });
  });
});
