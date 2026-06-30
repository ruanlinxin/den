---
name: den
description: 推送、查看、下载、删除跨设备暂存的文本或文件。当用户想把一段文字、笔记、文件"存到统一位置"供其他设备/AI 读取，或要从 den 取回、列出、删除之前存的内容时使用。通过调用 den CLI 操作自托管服务端。
---

# den — 跨设备暂存

den 让你在任意设备上把**文本或文件**推送到一个统一的自托管服务端，其他设备（包括 AI）可以查看、下载、删除。

## 前提

调用前先确认 den CLI 可用:运行 `which den`,能输出路径即可直接用下面的命令。

若 `which den` 不可用,按以下方式安装配置(仅需一次):

1. **获取 CLI 文件**:从服务端拷贝单文件 `den.cjs`(零运行时依赖,只需 Node)到本机,例如:
   ```bash
   scp <user>@<server-host>:/home/ubuntu/dev/den/cli/dist/den.cjs ~/bin/den.cjs
   chmod +x ~/bin/den.cjs
   # 设 alias 或软链,让 `den` 可调用:
   ln -sf ~/bin/den.cjs /usr/local/bin/den   # 或 alias den='node ~/bin/den.cjs'
   ```
2. **配置连接**(二选一):
   - 环境变量(加进 shell rc):`export DEN_URL=http://<host>:<port>` + `export DEN_TOKEN=<token>`
   - 配置文件:`den config set --url http://<host>:<port> --token <token>`(写入 `~/.denrc`)

> 服务端地址 `http://<host>:<port>`(Tailscale 内网),token 由部署者提供。本机必须在同一 Tailscale 网络内。

## 命令速查

| 想做的事 | 命令 |
|---|---|
| 存一段文本 | `den push -m "内容"` |
| 存文本并打标签 / 设有效期 | `den push -m "内容" --tags note,doc --ttl 1h` |
| 从管道存文本 | `echo "x" \| den push -m -` |
| 存一个文件 | `den push /path/to/file` |
| 看全部条目 | `den ls` |
| 按标签筛选 | `den ls --tag note` |
| 按类型 / 来源筛选 | `den ls --kind file --source macmini` |
| 取文本（打印） | `den get <id>` |
| 下载文件到当前目录 | `den get <id>` |
| 下载到指定路径 | `den get <id> -o out.txt` |
| 给已有条目加标签 | `den tag <id> add note,doc` |
| 删除单个标签 | `den tag <id> rm note` |
| 删除条目 | `den rm <id>` | TTY 下会二次确认;非 TTY 需 `--yes` |
| 删除条目(脚本) | `den rm <id> --yes` | 跳过确认,适合脚本调用 |

每条 `push` 成功后会返回一个短 `id`（如 `aB3xK9pQ`），用这个 id 做后续操作。

## 典型流程（AI 视角）

1. **用户给了文本/文件想统一存起来** → `den push ...`，拿到 id 告诉用户。
2. **用户想看存了什么** → `den ls`，把列表整理给用户。
3. **用户想取回内容** → 文本用 `den get <id>` 直接打印读给用户；文件用 `den get <id>` 下载后用 `read` 工具读取。

## 注意事项

- **有效期 / 标签**：`push` 可带 `--ttl`（单位 `s/m/h/d/w`，纯数字=秒）和 `--tags`（逗号分隔）。已过期条目不会出现在 `ls` / `get`（视为不存在）。
- 大文件（>100MB）不建议走 den；先提示用户。
- `source` 字段会自动带本机主机名，列表里可用于区分来源。
- 删除（`rm`）不可恢复。TTY 下会列出元信息并提示 `[y/N]`，用户输入 `y`/`yes` 才执行；非交互式环境（管道、脚本、CI）默认拒绝，必须显式带 `--yes`（或短写 `-y`）才删除。
