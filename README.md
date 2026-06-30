# den

> 自托管的跨设备文件/文本暂存服务。跑在 Tailscale 内网,让所有设备(含 AI agent)互相推送、查看、下载内容。

由三层组成:

| 层 | 目录 | 技术 | 说明 |
|---|---|---|---|
| **server** | `server/` | NestJS 11 + TypeScript + SQLite | HTTP API + 存储 |
| **cli** | `cli/` | 纯 TypeScript(单文件打包,零运行时依赖) | 客户端,分发到各设备 |
| **skill** | `skill/` | pi skill(`SKILL.md`) | AI 的操作手册 |

核心闭环:**AI 读取 skill → 调用 cli → 操作 server → 读写统一存储**。

## 快速开始

### 服务端

```bash
cd server
npm install
npm run start:dev          # 热重载开发
# 生产:PORT=8080 STASH_TOKEN=xxx npm start
```

### CLI

```bash
cd cli
npm install
npm link                   # 注册全局 den 命令
den config set --url <URL> --token <TOKEN>
den push -m "hello"        # 推文本
den ls                     # 列表
den get <id>               # 取回
```

### skill

```bash
ln -sf "$PWD/skill" ~/.agents/skills/den   # 让 pi 发现
```

## 文档

- 整体设计 → [`docs/design.md`](docs/design.md)
- HTTP 接口 → [`docs/api.md`](docs/api.md)
- 数据模型 → [`docs/data-model.md`](docs/data-model.md)
- 协作上下文 → [`AGENTS.md`](AGENTS.md)

## 鉴权

单 Bearer token,服务端从 `STASH_TOKEN` 环境变量读取(未设时启动自动生成一次)。CLI 通过 `den config set` 或环境变量 `DEN_URL` / `DEN_TOKEN` 配置。
