# stash · 接口清单

> Base URL: `http://<host>:<port>`（Tailscale 内网）
> 所有非健康检查接口均需鉴权。

## 鉴权

通过请求头携带 token（二选一）：

```
Authorization: Bearer <STASH_TOKEN>
# 或
X-Stash-Token: <STASH_TOKEN>
```

- token 来源：`STASH_TOKEN` 环境变量为权威来源；未设置时服务端启动自动生成一次并打印到日志（不落盘），供首次拷贝到各设备 `~/.stashrc`。
- 以下路径**免鉴权**：`/`、`/health`、`/favicon.ico`。
- 鉴权失败返回 `401 Unauthorized`（`{ statusCode, message }`）。

> 实现约定：NestJS `CanActivate` 返回 `false` 默认抛 403；本服务在 Guard 内主动 `throw new UnauthorizedException()` 以返回 401，语义为“未携带 / 携带错误 token”。

---

## 1. 健康检查

`GET /health` ｜ 免鉴权

**响应**：`200 OK`

```json
{ "ok": true }
```

---

## 2. 推送文本

`POST /stash/text`

**请求头**

```
Content-Type: application/json
Authorization: Bearer <token>
```

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `text` | string | ✅ | 文本内容，不可为空 |
| `source` | string | ❌ | 来源标记（主机名/设备名） |
| `ttl` | number | ❌ | 有效期（秒），>0 生效；缺省 = 永不过期 |
| `tags` | string[] | ❌ | 标签数组 |

**请求示例**

```bash
curl -X POST http://<host>:<port>/stash/text \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"一段想法","source":"macmini","tags":["note"],"ttl":3600}'
```

**响应**：`201 Created`

```json
{
  "id": "aB3xK9pQ",
  "kind": "text",
  "name": "text.txt",
  "size": 12,
  "createdAt": 1782000000000,
  "source": "macmini",
  "tags": ["note"],
  "expiresAt": 1782003600000
}
```

**错误**

| 状态码 | 场景 |
|---|---|
| 400 | `text` 缺失或为空 |
| 401 | 鉴权失败 |

---

## 3. 推送文件

`POST /stash/file`

**请求头**

```
Content-Type: multipart/form-data
Authorization: Bearer <token>
```

**表单字段**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `file` | binary | ✅ | 文件内容 |
| `source` | string | ❌ | 来源标记 |
| `ttl` | number | ❌ | 有效期（秒） |
| `tags` | string | ❌ | 标签，逗号分隔（如 `note,doc`） |

**请求示例**

```bash
curl -X POST http://<host>:<port>/stash/file \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/path/to/note.pdf" \
  -F "source=macmini"
```

**响应**：`201 Created`

```json
{
  "id": "Mn2vR8wL",
  "kind": "file",
  "name": "note.pdf",
  "size": 204800,
  "createdAt": 1782000000000,
  "source": "macmini",
  "tags": [],
  "expiresAt": null
}
```

**约束**

- 当前实现文件完整读入内存（Multer memoryStorage）。**单文件上限 100MB**（服务端配置 `limits.fileSize`），超限返回 `413 Payload Too Large`；后续超大文件切换流式上传。

---

## 4. 列表

`GET /stash`

**查询参数**

| 参数 | 说明 |
|---|---|
| `kind` | 按类型过滤：`text` / `file` |
| `source` | 按来源过滤（精确匹配） |
| `tag` | 按标签过滤 |

**请求示例**

```bash
# 全部
curl http://<host>:<port>/stash -H "Authorization: Bearer $TOKEN"
# 按标签
curl 'http://<host>:<port>/stash?tag=note' -H "Authorization: Bearer $TOKEN"
```

**响应**：`200 OK`（按 `createdAt` 降序）

```json
[
  {
    "id": "aB3xK9pQ",
    "kind": "text",
    "name": "text.txt",
    "size": 12,
    "createdAt": 1782000000000,
    "source": "macmini",
    "tags": ["note"],
    "expiresAt": null
  }
]
```

> 说明：返回完整 Entry，按 `createdAt` 降序。**已过期条目不返回**（惰性过滤）；过期项的物理清理由后台定时任务完成（见 `data-model.md`）。分页等参数暂未实现。

---

## 5. 单条元信息

`GET /stash/:id`

**请求示例**

```bash
curl http://<host>:<port>/stash/aB3xK9pQ -H "Authorization: Bearer $TOKEN"
```

**响应**：`200 OK`

```json
{
  "id": "aB3xK9pQ",
  "kind": "text",
  "name": "text.txt",
  "size": 12,
  "createdAt": 1782000000000,
  "source": "macmini",
  "tags": ["note"],
  "expiresAt": null
}
```

**错误**：`404` ID 不存在（已过期条目同样返回 404）。

---

## 6. 下载原始内容

`GET /stash/:id/content`

**查询参数**

| 参数 | 默认 | 说明 |
|---|---|---|
| `download` | — | 传任意非 `0/false` 值则强制 `attachment` 下载 |

**响应头**

| 类型 | Content-Type | Content-Disposition |
|---|---|---|
| text | `text/plain; charset=utf-8` | 默认 `inline`；`download=1` 时 `attachment` |
| file | `application/octet-stream` | 始终 `attachment; filename="<原始名>"` |

**请求示例**

```bash
# 文本：直接打印
curl http://<host>:<port>/stash/aB3xK9pQ/content -H "Authorization: Bearer $TOKEN"

# 文件：下载到本地
curl -OJ http://<host>:<port>/stash/Mn2vR8wL/content -H "Authorization: Bearer $TOKEN"
```

**错误**：`404` ID 不存在或 blob 文件缺失。

---

## 7. 删除

`DELETE /stash/:id`

**请求示例**

```bash
curl -X DELETE http://<host>:<port>/stash/aB3xK9pQ -H "Authorization: Bearer $TOKEN"
```

**响应**：`200 OK`

```json
{ "ok": true }
```

**错误**：`404` ID 不存在。

---

## 8. 标签管理

### 追加标签

`POST /stash/:id/tags`

**请求体**

```json
{ "tags": ["new", "doc"] }
```

> 已存在的标签会被忽略（幂等）。

**响应**：`200 OK`，返回更新后的完整 Entry（同单条元信息）。

**错误**：`404` ID 不存在。

### 删除单个标签

`DELETE /stash/:id/tags/:tag`

`tag` 路径段需 URL 编码（中文 / 特殊字符）。

**响应**：`200 OK`，返回更新后的完整 Entry。

**错误**：`404` ID 不存在。

---

## 9. 统一错误格式

NestJS 默认异常过滤器返回：

```json
{
  "statusCode": 404,
  "message": "Cannot GET /stash/xxx",
  "error": "Not Found"
}
```

业务异常（`BadRequestException` / `NotFoundException` / `UnauthorizedException`）的 `message` 字段为**英文可读短句**（如 `` `text` is required ``），供 CLI/AI 直接展示；不引入额外 `code` 字段。

## 接口速查表

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/health` | ❌ | 健康检查 |
| POST | `/stash/text` | ✅ | 推送文本 |
| POST | `/stash/file` | ✅ | 推送文件 |
| GET | `/stash` | ✅ | 列表 |
| GET | `/stash/:id` | ✅ | 单条元信息 |
| GET | `/stash/:id/content` | ✅ | 下载内容 |
| DELETE | `/stash/:id` | ✅ | 删除 |
| POST | `/stash/:id/tags` | ✅ | 追加标签 |
| DELETE | `/stash/:id/tags/:tag` | ✅ | 删除单个标签 |
