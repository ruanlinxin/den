# Changelog

den 的版本变更记录。版本号遵循 [SemVer](https://semver.org/lang/zh-CN/):
- **第一位(MAJOR)**:大版本,有不兼容的 API / 配置 / 行为变更
- **第二位(MINOR)**:小功能版本,新增向后兼容的功能
- **第三位(PATCH)**:bug 修复,只修问题不加功能

server 与 cli 共享同一版本号(同一发布)。

## [1.0.0] - 2026-06-30

首个稳定版本。覆盖:文本/文件 CRUD、列表过滤、标签、TTL 过期清理、跨设备 Tailscale 部署、CLI 单文件分发、AI skill 集成。

### 基础能力
- 文本推送(`POST /den/text`)与文件推送(`POST /den/file`,multipart)
- 列表 + 三种过滤(`kind` / `source` / `tag`)
- 单条元信息查询与原始内容下载(text inline / file attachment)
- 物理删除(无回收站)
- 标签:推送时打、追加、删除单个
- TTL:惰性过滤 + 后台定时 `purgeExpired` 物理清理
- 短 ID:nanoid(8)
- SQLite + 文件系统 blob 存储(`~/.local/share/den/`)
- 单 Bearer token 鉴权,环境变量权威(`DEN_TOKEN`),未设时启动自动生成

### Server
- NestJS 11 + TypeScript + better-sqlite3
- 自动探测 Tailscale 接口(100.64.0.0/10)绑定,公网零可达
- 请求体 1MB、单文件 100MB 上限,超出返回 413(express 错误中间件翻译)
- WAL + foreign_keys,写路径单事务
- TokenGuard:免鉴权路径 `/`、`/health`、`/favicon.ico`
- 跨设备文件名编码三层防护:`defParamCharset=utf8` 接收 + NFC 规范化存储 + RFC 5987 `Content-Disposition` 响应

### CLI
- 纯 TypeScript,esbuild 打包单文件 `dist/den.cjs`,**零运行时依赖**
- 命令:`push` / `ls` / `get` / `rm` / `tag` / `config`
- 配置:`~/.config/den/config.json`,环境变量 `DEN_URL` / `DEN_TOKEN` 覆盖
- 向后兼容旧 `~/.stashrc` 与 `STASH_*` 环境变量
- `den rm` 二次确认:TTY 提示元信息 + `[y/N]`,非 TTY 拒绝,`--yes` / `-y` 跳过
- `den config show` 时 token 打码(前 2 字符 + `***`)
- fetch 默认 30s timeout(`DEN_TIMEOUT_MS` 可覆盖)
- TTL 单位 `s/m/h/d/w`,纯数字=秒
- Windows 推送 GBK mojibake 反向修复(`process.platform === 'win32'` 时按需)

### Skill
- pi skill 描述 `推送、查看、下载、删除跨设备暂存的文本或文件`
- 命令速查表 + TTY/非 TTY 删除差异提示
- 典型流程三步(推送 → 列表 → 取回)

### 测试
- server 单元测试 50(用真实 SQLite,覆盖 CRUD/TTL/CASCADE/ID 冲突)
- server 端到端测试 31(supertest 跑完整 HTTP 链路,含鉴权、上限、TTL、跨设备编码)
- cli 单元测试 55(纯函数 + 命令 mock fetch + GBK mojibake 反向解码)
- 合计 **136 测试全过**,`tsc --noEmit` 双端 0 错误
