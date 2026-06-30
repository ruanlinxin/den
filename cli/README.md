# den

> 跨设备暂存 CLI —— 把文本/文件丢进一个"洞穴",凭短码在另一台机器取走。

零运行时依赖(仅 Node 内置 `fetch` / `fs` / `crypto`),纯 TypeScript 实现。

## 安装

```bash
npm link        # 在本仓库目录内,注册全局 den 命令
```

## 配置

配置写入 `~/.denrc`(JSON:`{ url, token }`),也可用环境变量覆盖。

```bash
den config set --url <URL> --token <TOKEN>
den config show
```

环境变量：`DEN_URL` / `DEN_TOKEN`。

## 用法

```bash
den push -m "<文本>" [--ttl 1h] [--tags a,b] [--source <host>]
den push -m -                        # 从 stdin 推文本
den push <file> [--ttl 1h] [--tags a,b] [--source <host>]
den ls [--kind text|file] [--source <host>] [--tag <tag>]
den get <id> [-o <path>]            # 文本→打印 / 文件→下载到 cwd
den rm <id>
den tag <id> add <a,b> | den tag <id> rm <tag>
den config set --url <u> --token <t>
den config show
```

`ttl` 单位:`s` / `m` / `h` / `d` / `w`,纯数字 = 秒。

## 开发

```bash
npm run build       # esbuild 打包到 dist/den.cjs
npm test            # jest
npm run typecheck   # tsc --noEmit
npm run dev         # tsx 直接跑源码
```
