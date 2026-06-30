# stash · 设计文档

## 1. 背景与目标

用户拥有多台设备(腾讯云服务器、Mac、Windows、手机等),通过 Tailscale 组网(`leyuwangyou` 网络)。核心诉求:**任意设备推送文本或文件,其他设备(尤其是 AI agent)能统一读取/下载**。

早期考虑过"极空间 NAS + WebDAV 挂载"方案,但极空间(Q2Z,ARM 入门款)未加入 Tailscale,跨网打通成本高;最终决定**自建轻量服务**,数据与逻辑完全自控。

### 目标(已实现 v1.0)

核心 CRUD:
- 推送文本 / 文件,返回短 ID
- 列表(按类型 / 来源 / 标签过滤)
- 按 ID 查看 / 下载
- 按 ID 删除(物理删除,不可恢复)

标签与过期:
- 推送时可打标签(`tags`),支持按标签过滤(`ls --tag`)
- 推送时可设 TTL(`--ttl`),到期自动清理(查询惰性过滤 + 定时物理删除)

基建:
- 单一 CLI,跨平台分发(零运行时依赖,目标机只要有 `node`)
- 只在 Tailscale 内网暴露,公网零可达
- SQLite 存元信息 / 标签,blob 留文件系统

> 全文搜索 / 语义检索(v0.3 草案)暂不规划。

## 2. 整体架构

stash 由三个物理组件构成 **server / cli / skill**,形成完整闭环:

```
┌─────────────────────────────────────────────────────────────┐
│                      Tailscale 网络 (leyuwangyou)             │
│                                                              │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐                  │
│  │ 腾讯云    │   │  macmini │   │  手机     │   ...            │
│  │ +server  │   │  +cli    │   │  +cli    │                  │
│  │ +cli     │   │  +skill  │   │           │                  │
│  │ +skill   │   │          │   │           │                  │
│  └─┬──┬─────┘   └───┬──────┘   └────┬─────┘                 │
│    │  │             │ (2) cli           │ (2) cli             │
│    │  │  (1) AI 读   │                   │                   │
│    │  └─skill────────┤                   │                   │
│    │     SKILL.md     │                   │                   │
│    │                  │  HTTP + Bearer Token                  │
│    │            ┌─────▼──────┐                             │
│    └───────────►│ stash server│  ← 监听 <tailscale-ip>:<port>      │
│                 │  (NestJS)   │                             │
│                 └─────┬──────┘                             │
│                       │                                    │
│                 ┌─────▼──────┐                             │
│                 │ ~/.stash/   │  ← SQLite + 文件系统             │
│                 │  stash.db    │                             │
│                 │  files/<id> │                             │
│                 └─────────────┘                             │
└─────────────────────────────────────────────────────────────┘
```

### 三层职责

| 层 | 位置 | 职责 |
|---|---|---|
| **server** | `server/` | NestJS 服务端:路由、鉴权、请求解析、元信息维护、blob 落盘、并发控制 |
| **cli** | `cli/` | 纯 TS 客户端:命令行交互(`push`/`ls`/`get`/`rm`)、HTTP 调用、文件读写。零运行时依赖 |
| **skill** | `skill/SKILL.md` | pi skill:AI 读取后知道**何时触发**、**调用哪些 cli 命令**,实现 AI 驱动 stash |

### 闭环说明

1. **AI 读 skill**:当用户说"把这段文字存起来"/"看看 stash 里有什么",pi 匹配到 `skill/SKILL.md` 的 description,加载完整手册。
2. **AI 调 cli**:按手册执行 `stash push ...` / `stash ls` 等。
3. **cli 打 server**:cli 读 `~/.stashrc` 拿到 url+token,发 HTTP 请求。
4. **server 读写存储**:落盘到 `~/.stash/`,返回结果给 cli,cli 打印给 AI,AI 转述用户。

这样 AI 在任意设备(装了 cli+skill)都能读写同一份统一存储。

## 3. 技术选型理由

| 决策 | 选择 | 理由 |
|---|---|---|
| 语言 | TypeScript | 全部设备已有 Node 运行时;生态成熟 |
| 服务端框架 | NestJS | 脚手架快速起项目;模块/依赖注入清晰;Guard 鉴权开箱即用 |
| CLI 形态 | 纯 TS + 单文件打包 | 目标机器只需 `node`;规避把 NestJS 运行时拖进客户端 |
| 存储 | SQLite(better-sqlite3)+ 文件系统 | SQLite 存元信息 / 标签,单文件易备份、并发安全;blob 留文件系统,避免大文件拖慢查询;同步 API 简单可靠 |
| ID | nanoid(8 位) | 短、无序、URL 友好;8 位足够避免碰撞 |
| 网络 | Tailscale 内网 | 设备间已组网;P2P 直连;无需公网 IP 或端口转发 |

## 4. 目录结构

三层独立目录,详见 `AGENTS.md`。核心约定:

- `server/src/stash/` 是服务端业务模块,`server/src/` 根目录仅放 NestJS 脚手架文件 + 入口。
- `cli/src/cli.ts` 是客户端实现,不 import 任何 NestJS 包。
- `skill/SKILL.md` 的命令清单必须与 cli 实际命令同步,改 cli 必同步更新 skill 与 `docs/api.md`。
- 存储逻辑全在 `store.ts`,不散落到 controller。
- CLI 与 server **共享类型**通过各自定义对齐(当前 CLI 待建,类型见 `server/src/stash/types.ts`)。

## 5. 数据流

### 推送文本

```
cli: POST /stash/text  { text: "...", source: "macmini" }
  → TokenGuard 校验
  → StashController.pushText
  → StashStore.addText → 生成 id,写入 files/<id>(blob)+ INSERT SQLite entries / entry_tags
  ← 返回 { id, kind:'text', ... }
```

### 推送文件

```
cli: POST /stash/file  multipart, field 'file' + 'source'
  → FileInterceptor 解析
  → StashStore.addFile(buffer, originalname)
  ← 返回 { id, kind:'file', name, size, ... }
```

### 下载

```
cli: GET /stash/<id>/content?download=1
  → 查找 entry,流式返回 blob
  → text 默认 inline,file 默认 attachment
```

### 删除

```
cli: DELETE /stash/<id>
  → 从 index 移除 + 删除 blob 文件
```

## 6. 安全模型

| 威胁 | 防护 |
|---|---|
| 公网扫描 | 服务端默认只 bind Tailscale 接口 IP,不监听 0.0.0.0 |
| 未授权访问 | 全局 TokenGuard,除 `/health`、`/` 外均需 Bearer token |
| token 泄露 | token 以 `STASH_TOKEN` 环境变量为权威来源;未设置时启动自动生成一次并打印到日志(不落盘),供首次拷贝到各设备 `.stashrc`。token 不入仓库 |
| 跨设备身份伪造 | `source` 字段为软标记(非强校验),用于列表展示来源 |

> 说明:本方案假设**Tailscale 网络本身可信**。token 防的是网络内其他设备误触/扫描,而非对抗性攻击者。如需更强隔离,后续可加 mTLS。

## 7. 部署模型

- **单点部署**:服务端跑在腾讯云节点(<tailscale-ip>),常开、稳定。
- **CLI 分发**:主路径是单文件——构建产物 `dist/stash.cjs`(esbuild 打包,带 shebang,零运行时依赖)用 `scp` 拷到各设备,直接 `node stash.cjs` 运行(目标机器只需 Node)。`npm link` 仅用于开发机装出 `stash` 命令,不是分发主路径。
- **配置约定**:每个设备持有一份 `.stashrc`(`{ url, token }`),指向服务端。
- **备份**:`~/.stash/` 整目录定期 `rsync` 到极空间或其他冷备即可。
- **单点说明**:server 是单点,挂掉期间所有设备读写中断;个人工具可接受,不做多副本。

## 8. 后续演进路线

| 阶段 | 能力 | 状态 |
|---|---|---|
| v1.0 | 文本/文件 CRUD + CLI + 标签 + 过期清理(TTL)+ SQLite 存储 | ✅ 已实现 |
| 后续 | 全文搜索 / 语义检索 | ⏸ 暂不规划 |
