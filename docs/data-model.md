# stash · 数据模型

> 当前实现:**SQLite(`better-sqlite3`)+ 文件系统 blob**。
> SQLite 存元信息与标签,blob(原始文件字节)始终留文件系统,避免大文件拖慢查询与备份。

## 1. 存储形态

```
~/.stash/                       ← 数据根(STASH_DATA_DIR 可覆盖)
├── stash.db                    ← SQLite 主库(entries + entry_tags)
├── stash.db-wal                ← WAL 日志(better-sqlite3 开启 WAL)
├── stash.db-shm                ← 共享内存索引
└── files/                      ← 原始文件字节(text 也存成文件)
    ├── aB3xK9pQ
    └── Mn2vR8wL
```

启动时开启 `journal_mode = WAL` 与 `foreign_keys = ON`;表不存在则自动建。

## 2. 表结构

### `entries`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | nanoid(8) |
| `kind` | TEXT | NOT NULL CHECK(kind IN ('text','file')) | 类型 |
| `name` | TEXT | NOT NULL | text 固定 `text.txt`;file 为上传原始名 |
| `size` | INTEGER | NOT NULL | 字节大小(text 为 UTF-8 字节数) |
| `created_at` | INTEGER | NOT NULL | Unix 毫秒 |
| `source` | TEXT | | 来源标记(主机名),可空 |
| `expires_at` | INTEGER | | 过期时间(Unix 毫秒);NULL = 永不过期 |

```sql
CREATE TABLE entries (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('text', 'file')),
  name       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  source     TEXT,
  expires_at INTEGER
);
CREATE INDEX idx_entries_created_at ON entries (created_at DESC);
CREATE INDEX idx_entries_expires_at ON entries (expires_at);
```

### `entry_tags`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `entry_id` | TEXT | NOT NULL, FK → entries(id) ON DELETE CASCADE | 所属条目 |
| `tag` | TEXT | NOT NULL | 标签(规范化:去空白、去重) |

```sql
CREATE TABLE entry_tags (
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,
  PRIMARY KEY (entry_id, tag)
);
CREATE INDEX idx_tags_tag ON entry_tags (tag);
```

`(entry_id, tag)` 为主键,天然去重;`ON DELETE CASCADE` 保证删 entry 时连带清标签。

## 3. API 字段 ↔ 列映射

对外 `Entry`(JSON):

```json
{
  "id": "aB3xK9pQ",
  "kind": "text",
  "name": "text.txt",
  "size": 12,
  "createdAt": 1782000000000,
  "source": "macmini",
  "tags": ["demo", "note"],
  "expiresAt": 1782003600000
}
```

| JSON 字段 | 列 | 备注 |
|---|---|---|
| `createdAt` | `created_at` | 驼峰 ↔ 下划线转换在 store 内做 |
| `expiresAt` | `expires_at` | 同上;`null`/缺省 = 永不过期 |
| `tags` | 聚合自 `entry_tags` | 列表/单条查询时按 `entry_id` 聚合 |

## 4. 并发与一致性

- **并发写**:`better-sqlite3` 是同步 API,所有 DB 操作在单线程内天然串行,无需额外队列。
- **原子性**:写 blob → 成功后单事务内 `INSERT entries` + `INSERT entry_tags`;删除先 `DELETE entries`(cascade 清标签)再删 blob。
- **崩溃恢复**:WAL 模式下进程崩溃不损坏库;SQLite 自带完整性,无需手工 fail-fast(区别于旧 `index.json` 方案)。若 `stash.db` 物理损坏,从冷备恢复。
- **blob 一致性**:若 entry 引用了不存在的 blob,`GET /:id/content` 返回 404,元信息不受损。

## 5. 关键语义

- **ID 碰撞**:nanoid(8) 碰撞概率极低;写入前 `SELECT` 校验,命中则重新生成(重试有限次)。
- **删除**:物理删除(entry + 级联标签 + blob),**无回收站**,CLI `rm` 前须向用户确认。
- **TTL 过期**:
  - 推送时收 `ttl`(秒)→ 存 `expires_at = now + ttl*1000`(ms)。
  - **惰性过滤**:`list` / `get` 查询时用 `(expires_at IS NULL OR expires_at > now)` 自动隐藏已过期项(过期即不可见,等同删除的可见效果)。
  - **物理清理**:后台定时任务(默认每 60s,`STASH_PURGE_INTERVAL_SEC` 可调)执行 `purgeExpired()`,删除 `expires_at <= now` 的条目与 blob,回收磁盘。
- **标签规范化**:`trim` + 去重 + 排序;空字符串忽略。

## 6. 量级与扩展

- SQLite 单库轻松承载 **10w+ 条**;blob 不入库,大文件不影响查询性能。
- 当前已满足需求。若未来需要全文/语义检索,可在此基础上新增 FTS5 表或外部索引,无需改现有结构。

## 7. 备份

- `rsync -a ~/.stash/ backup/` 即完整备份(含 `stash.db*` 与 `files/`)。
- SQLite 文件热备份也可用 `better-sqlite3` 的 `.backup()` 在线导出,避免 WAL 中途状态;个人量级直接 rsync 足够。
- 建议定时 rsync 到极空间 NAS 或其他冷备。
