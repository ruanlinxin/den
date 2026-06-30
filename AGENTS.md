# den · 项目协作指南

> 本文件是 AI agent / 协作者在本仓库工作时的上下文。读完它你就能动手。

## 一句话定位

**den** 是一个自托管的跨设备文件/文本暂存服务,由三层组成:

1. **server** — NestJS HTTP 服务端,负责存储与读写
2. **cli** — 纯 TypeScript 客户端,零运行时依赖,分发到各设备
3. **skill** — pi skill(`SKILL.md`),AI 读取它后知道如何调用 cli

跑在 Tailscale 内网,让所有设备(含 AI)互相推送、查看、下载内容。

核心闭环:**AI 读取 skill → 调用 cli → 操作 server → 读写统一存储**。

## 技术栈

| 组件 | 技术 | 说明 |
|---|---|---|
| server | NestJS 11 + TypeScript | HTTP API + SQLite 存储 |
| 存储 | SQLite(better-sqlite3)+ 文件系统 blob | 元信息/标签入 `den.db`;blob 留 `files/<id>` |
| cli | 纯 TypeScript(单文件打包) | **绝不能引入 NestJS 运行时**,要能塞进任意设备 |
| skill | pi skill(`SKILL.md`) | AI 的操作手册,描述何时触发、调用哪些命令 |
| ID | `nanoid` 8 位 | 短、无序、URL 友好 |
| 鉴权 | Bearer / X-Den-Token | 单 token,`DEN_TOKEN` 环境变量为权威(未设时启动自动生成一次,打印到日志不落盘) |
| 服务端配置 | `DEN_TOKEN` / `DEN_DATA_DIR` / `DEN_HOST` / `DEN_BODY_LIMIT` / `DEN_PURGE_INTERVAL_SEC` | 详见 `docs/api.md` 与 `server/src/main.ts` |
| CLI 配置 | `DEN_URL` / `DEN_TOKEN` / `DEN_TIMEOUT_MS`(默认 30s) / `STASH_URL` / `STASH_TOKEN`(兼容) | 详见 `cli/src/cli.ts` |

## 目录结构

```
den/
├── AGENTS.md              ← 你在这里
├── docs/                  ← 设计文档、接口清单、数据模型
│   ├── design.md
│   ├── api.md
│   └── data-model.md
├── server/                ← 【层1】NestJS 服务端(存储 + HTTP API)
│   └── src/
│       ├── main.ts        ← 入口:监听 Tailscale 地址/端口;token 取自 DEN_TOKEN,未设时启动自动生成一次
│       ├── app.module.ts  ← 根模块,装载 DenModule
│       └── den/          ← 核心业务模块
│           ├── den.module.ts
│           ├── den.controller.ts   ← HTTP 路由
│           ├── store.ts              ← SQLite 存储后端 + TTL 定时清理
│           ├── token.guard.ts        ← 鉴权守卫
│           └── types.ts
├── cli/                   ← 【层2】纯 TS 客户端(零运行时依赖)
│   └── src/cli.ts         ← push / ls / get / rm / tag
└── skill/                 ← 【层3】pi skill(AI 操作手册)
    └── SKILL.md           ← frontmatter + 命令速查 + 典型流程
```

### 三层如何联动

```
AI agent  ──读取──►  skill/SKILL.md  (知道何时触发、调用哪些命令)
                          │
                          ▼ 执行
cmd: den push -m "..."   ◄── cli/src/cli.ts
                          │
                          ▼ HTTP + Token
                     server  ──► ~/.local/share/den/ (统一存储)
```

## 常用命令

```bash
# 服务端
cd server
npm run start:dev          # 热重载开发
npm run build && npm start # 生产
npm test                   # 单元测试(store/controller/guard)
PORT=8080 DEN_TOKEN=xxx npm start

# CLI
cd cli
npm run build              # esbuild 打包成单文件 dist/den.cjs
npm run typecheck          # 类型检查
npm test                   # 单元测试(纯函数 + 命令)
npm link                   # 装出 den 命令(开发机)

# skill
# 链接到 pi 的 skills 目录即可被 AI 发现。全局可用放 ~/.agents/skills/,仅本项目用放 .pi/skills/
ln -sf ../skill ~/.agents/skills/den   # 全局(所有项目可用)
# ln -sf ../skill .pi/skills/den       # 仅本项目
```

## 关键约束(改动前必读)

1. **CLI 零运行时依赖**:CLI 打包成单文件 JS,目标机器只要有 `node`。不要让 CLI import 任何 NestJS 包。
2. **skill 与 cli 必须对齐**:skill 里的命令、参数、行为要和 cli 实际实现一致;改了 cli 命令,要同步更新 `skill/SKILL.md` 和 `docs/api.md`。
3. **只监听 Tailscale 接口**:生产部署时服务端默认绑 Tailscale IP(如 `100.x.x.x`),不暴露公网。`main.ts` 负责探测绑定地址。
4. **存储用 SQLite + 文件系统 blob**:元信息/标签存 `den.db`(better-sqlite3,WAL 模式),blob 留 `files/<id>` 避免大文件拖慢查询。详见 `docs/data-model.md`。
5. **写操作原子化**:`store.ts` 用 better-sqlite3 事务(blob 先写成功,再单事务 INSERT entries + entry_tags;删除先 DELETE cascade 再删 blob)。新增写路径要包在事务里。

## 数据位置

- 默认:`~/.local/share/den/`(可被 `DEN_DATA_DIR` 覆盖)
- 结构见 `docs/data-model.md`

## 文档导航

- 想了解整体设计 → `docs/design.md`
- 想调接口/写 CLI → `docs/api.md`
- 想动存储/数据模型 → `docs/data-model.md`
