# Codex Proxy API 文档

## 鉴权方式

服务端点接受 `Authorization: Bearer {proxy_api_key}` 或已有的账号级 `codex-proxy-*` 密钥。Dashboard 登录与管理自动化只使用独立且必需的 `dashboard.admin_key`，服务密钥不能访问管理面。浏览器管理请求使用 `_codex_session` 并校验 Origin/CSRF，本机访问也不例外；自动化脚本可使用 `Authorization: Bearer {dashboard.admin_key}`。

---

## API 代理端点

### POST /v1/chat/completions
OpenAI 兼容的聊天补全接口。

```jsonc
// 请求体
{
  "model": "o4-mini",
  "messages": [{"role": "user", "content": "Hello"}],
  "stream": true,
  "reasoning_effort": "medium"  // 可选: low | medium | high | xhigh
}
```

- 流式：SSE，事件包含 `choice.delta`
- 非流式：`{ id, choices, usage }`
- 错误格式：`{ error: { message, type, code } }`
- `max_tokens`、`max_completion_tokens`、`max_output_tokens` 仅做客户端兼容解析，不会转发给 Codex。

### POST /v1/messages
Anthropic Messages API 兼容接口。

```jsonc
// 请求体
{
  "model": "claude-sonnet-4-20250514",
  "messages": [{"role": "user", "content": "Hello"}],
  "max_tokens": 1024,
  "stream": true,
  "thinking": {"type": "enabled"}  // 可选
}
```

- 鉴权：`x-api-key` 或 `Authorization: Bearer`
- 错误格式：`{ type: "error", error: { type, message } }`

### POST /v1beta/models/:model\:generateContent
### POST /v1beta/models/:model\:streamGenerateContent
Google Gemini 兼容接口。

```jsonc
// 请求体
{
  "contents": [{"role": "user", "parts": [{"text": "Hello"}]}],
  "generationConfig": {"temperature": 0.7, "maxOutputTokens": 1024},
  "systemInstruction": {"parts": [{"text": "你是一个助手。"}]}
}
```

- 鉴权：`x-goog-api-key` 请求头、`key` 查询参数、或 Bearer token
- 错误格式：`{ error: { code, message, status } }`

### POST /v1/responses
原生 Codex Responses API 透传（底层走 WebSocket）。

```jsonc
// 请求体
{
  "model": "o4-mini",
  "instructions": "你是一个助手。",
  "input": [{"type": "message", "content": "Hello"}],
  "stream": true,
  "reasoning": {"effort": "medium"},
  "tools": [],
  "previous_response_id": "resp_xxx"  // 多轮对话
}
```

- 流式：SSE 事件 `response.created`、`response.output_text.delta`、`response.completed`
- 非流式：`{ response, usage, responseId }`
- 不要向原生 Codex 发送 `max_output_tokens`。代理只兼容解析并剥离该字段，因为真实 Codex 后端会返回 `400 Unsupported parameter: max_output_tokens`。

#### image_generation 工具

在 `tools[]` 里声明 `{"type": "image_generation", ...}`，模型可以调用服务端图像
生成后端（`gpt-image-2`）。前提：**ChatGPT Plus 及以上** 账号——free 账号上游
会静默剥掉工具，模型会改用 SVG 文本假装画图。

**支持字段**（除 `type` 全部可选）：

| 字段 | 枚举 / 范围 | 默认 | 备注 |
|---|---|---|---|
| `size` | `1024x1024`、`1024x1536`、`1536x1024`、`2048x2048`、`2048x3072`、`3072x2048`、`3840x2160`（4K UHD）、`2160x3840`（4K 竖）、`2304x3072`（3:4）、`auto` | `auto` | 宽高必须都是 16 的倍数；最长边 ≤ 3840 px；总像素预算约 8 MP（`3072x3072` 会被拒）；1024 以下分辨率也被拒（最小像素预算）|
| `output_format` | `png` / `jpeg` / `webp` | `png` | `gif` 被拒 |
| `output_compression` | 整数 0–100 | `100` | **仅 jpeg / webp 生效** — png 下非 100 报错 |
| `background` | `auto` / `opaque` | `auto` | `transparent` 被拒 |
| `moderation` | `auto` / `low` | `auto` | 其他枚举被拒 |
| `partial_images` | 整数 0–3 | 0 | `>3` 被拒 |

**静默改写 / 明确拒绝的字段**：

- `model` — 不管传啥，上游强制改回 `gpt-image-2`。
- `quality` — 传任何值都被 echo 为 `auto`，用户值不生效。
- `n` — `unknown_parameter`；一次只能出一张图。
- `input_image`、`mask`、`input_fidelity`、`style`、`response_format` — 全部拒绝。

**事件顺序**（模型调用工具时）：

1. `response.created` — `tools[]` 被上游补全默认字段回显。
2. `response.output_item.added` — `{type: "image_generation_call", ...}`。
3. `response.image_generation_call.in_progress` → `.generating` → （可选）`.partial_image` × N。
4. `response.output_item.done` — 完整的 `image_generation_call`：
   - `result` — base64 图像（格式跟 `output_format`）。
   - `revised_prompt` — 模型实际使用的最终提示词。
5. `response.completed`。

**Token 计费**：`response.completed.response.usage` 是主模型的 token；图像工具
的 token 单独走 `response.completed.response.tool_usage.image_gen.{input_tokens,
output_tokens, total_tokens}`。代理两边都原样透传，并且在仪表盘里把图像 token
单列为 `total_image_input_tokens` / `total_image_output_tokens`，不会和主模型的
token 混到一起。

**请求计数**：代理同时分别统计图像生成的成功 / 失败次数。`total_image_request_count`
在上游返回真实图像（`tool_usage.image_gen.output_tokens > 0`）时 +1；
`total_image_request_failed_count` 在工具被静默剥（Free 账号）、上游错误、空响应等
任何失败路径下 +1。两者都通过 `/admin/usage-stats/summary` 暴露，Dashboard 的
「Image Requests」卡片直接展示 `N ok · M failed`。

**编辑模式**（带参考图）：在 user message 的 content 数组里加 `input_image`
块，`data:` URL 和 HTTPS URL 都支持。

```jsonc
{
  "model": "gpt-5.6-sol",
  "stream": true,
  "input": [{
    "role": "user",
    "content": [
      {"type": "input_text", "text": "把这张图的天空改成黄昏。"},
      {"type": "input_image", "image_url": "data:image/png;base64,AAA...", "detail": "high"}
    ]
  }],
  "tools": [{"type": "image_generation", "size": "1024x1024"}]
}
```

合法 content-part 类型（由上游枚举校验回显）：`input_text`、`input_image`、
`output_text`、`refusal`、`input_file`、`computer_screenshot`、`summary_text`。

OpenAI Chat 兼容路径会接受 `tools: [{"type":"image_generation"}]`，但稳定的
图像 payload 只会通过 `/v1/responses` 的 `image_generation_call.result` 暴露。
需要拿到 base64 图片字节时，请使用 `/v1/responses`。

---

## 模型

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/models` | 列出所有模型（OpenAI 格式） |
| GET | `/v1/models/catalog` | 完整模型目录（含 reasoning effort） |
| GET | `/v1/models/:id` | 单个模型详情 |
| GET | `/v1/models/:id/info` | 扩展模型信息 |
| GET | `/v1beta/models` | 列出模型（Gemini 格式） |
| POST | `/admin/refresh-models` | 强制从上游刷新模型列表 |

模型目录条目可以包含 token 元数据：

| 字段 | 含义 |
|------|------|
| `contextWindow` | 静态或上游提供的上下文窗口，用于展示和客户端参考 |
| `maxContextWindow` | 上游提供的最大可扩展上下文窗口（如果返回） |
| `maxOutputTokens` | 静态或上游提供的最大输出 token，用于展示和客户端参考 |
| `truncationPolicyLimit` | 上游提供的截断策略限制（如果返回） |

静态值定义在 `config/models.yaml`；同一模型 ID 如果从
`/backend-api/codex/models` 拉到动态条目，则以上游动态值为准。
ChatGPT UI 专用的 `auto` 选择器会从实时模型目录及两种缓存格式中排除，
因此 `/v1/models` 只会公布可实际调用的模型 ID。静态 GPT-5.6
家族（`gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` / `gpt-5.6`）使用
1,050,000 上下文与 128,000 最大输出。更早的运行时样本仍记录 `gpt-5.5` /
`gpt-5.4` 的 `context_window=272000`，以及 `gpt-5.4` 的
`max_context_window=1000000`。这些是 Codex 运行时限制，不代表请求级
context 或 max-token 开关可用。

---

## 账号管理

### 增删改查

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/auth/accounts` | 列出所有账号 |
| POST | `/auth/accounts` | 添加单个账号（`{ token?, refreshToken? }`） |
| DELETE | `/auth/accounts/:id` | 删除账号 |
| PATCH | `/auth/accounts/:id/label` | 设置标签（`{ label }`） |

### 批量操作

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/accounts/import` | 批量导入（`{ accounts: [{token?, refreshToken?, label?}] }`） |
| POST | `/auth/accounts/batch-delete` | 批量删除（`{ ids: [] }`） |
| POST | `/auth/accounts/batch-status` | 批量启停（`{ ids: [], status: "active"\|"disabled" }`） |

### 健康检查 & 配额

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/accounts/health-check` | 检查账号连通性（`{ ids?, stagger_ms?, concurrency? }`） |
| POST | `/auth/accounts/:id/refresh` | 刷新单个账号 token 和状态 |
| GET | `/auth/accounts/:id/quota` | 查看配额和用量 |
| GET | `/auth/accounts/:id/reset-credits` | 查看 ChatGPT/Codex 可用额度重置卡 |
| POST | `/auth/accounts/:id/reset-credits/consume` | 消耗 1 张重置卡并重置 5 小时速率窗口（`{ redeem_request_id? }`） |
| POST | `/auth/accounts/:id/reset-usage` | 重置用量计数 |

### 导出

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/auth/accounts/export` | 导出账号（`?ids=a,b&format=minimal`） |

### Cookies（Cloudflare）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/auth/accounts/:id/cookies` | 获取已存 cookies |
| POST | `/auth/accounts/:id/cookies` | 设置 cookies（`{ cookies }`） |
| DELETE | `/auth/accounts/:id/cookies` | 清除 cookies |

---

## 备用资源

备用资源是与活动账号池及其导入导出格式相互独立的手工维护记录。所有端点都要求
Dashboard 管理认证；写操作还必须通过现有管理 mutation/CSRF 校验。

### 备用账号

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/backup-resources/accounts` | 列出不含秘密值的账号摘要 |
| POST | `/admin/backup-resources/accounts` | 新增备用账号 |
| GET | `/admin/backup-resources/accounts/:id` | 获取单个账号及解密后的秘密字段（`Cache-Control: no-store`） |
| GET | `/admin/backup-resources/accounts/:id/totp` | 按需生成当前 TOTP 验证码（`Cache-Control: no-store`） |
| PATCH | `/admin/backup-resources/accounts/:id` | 部分更新元数据或秘密字段 |
| DELETE | `/admin/backup-resources/accounts/:id` | 删除单个备用账号 |

`accountStatus` 由用户手工维护，只允许 `plus`、`free`、`unregistered`、`pro`。
已有数据库记录以及未传状态的新增请求默认使用 `unregistered`。列表只返回邮箱、
状态、备注、时间戳和 `has*` 存在标记；邮箱密码、ChatGPT 密码、TOTP 密钥和
邮箱接码 URL 只由单条详情接口返回。
TOTP 端点使用已存储的密钥按需计算当前验证码，不会持久化或返回密钥本身。

### 接码手机号

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/backup-resources/phones` | 列出接码手机号 |
| POST | `/admin/backup-resources/phones` | 新增接码手机号 |
| GET | `/admin/backup-resources/phones/:id` | 获取单条手机号记录 |
| PATCH | `/admin/backup-resources/phones/:id` | 更新号码、备注或使用次数 |
| DELETE | `/admin/backup-resources/phones/:id` | 删除单条手机号记录 |
| POST | `/admin/backup-resources/phones/:id/use` | 原子递增使用次数 |

---

## OAuth & 登录

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/login-start` | 发起 OAuth → 返回 `{ authUrl, state }` |
| GET | `/auth/login` | 302 重定向到 Auth0 |
| POST | `/auth/code-relay` | OAuth 授权码交换（`{ callbackUrl }`） |
| GET | `/auth/callback` | OAuth 回调处理 |
| POST | `/auth/device-login` | 发起设备码流程 |
| GET | `/auth/device-poll/:deviceCode` | 轮询设备授权状态 |
| POST | `/auth/import-cli` | 从 Codex CLI auth.json 导入 |
| POST | `/auth/token` | 手动提交 token |
| GET | `/auth/status` | 认证状态 + 账号池概要 |
| POST | `/auth/logout` | 清空所有账号 |

---

## 代理池管理

### 增删改查

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/proxies` | 列出所有代理（含健康状态和分配） |
| POST | `/api/proxies` | 添加代理（`{ url }` 或 `{ host, port, username, password }`） |
| PUT | `/api/proxies/:id` | 更新代理 |
| DELETE | `/api/proxies/:id` | 删除代理 |

### 健康检查 & 控制

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/proxies/:id/check` | 检查单个代理 |
| POST | `/api/proxies/check-all` | 检查所有代理 |
| POST | `/api/proxies/:id/enable` | 启用代理 |
| POST | `/api/proxies/:id/disable` | 禁用代理 |

### 分配（账号 ↔ 代理）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/proxies/assignments` | 列出所有分配关系 |
| POST | `/api/proxies/assign` | 分配代理给账号（`{ accountId, proxyId }`） |
| DELETE | `/api/proxies/assign/:accountId` | 取消分配 |
| POST | `/api/proxies/assign-bulk` | 批量分配（`{ assignments: [] }`） |
| POST | `/api/proxies/assign-rule` | 按规则自动分配（`{ rule: "round-robin", ... }`） |

### 导入/导出

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/proxies/export` | 导出为 YAML |
| POST | `/api/proxies/import` | 导入 YAML 或纯文本（`host:port:user:pass` 格式） |
| GET | `/api/proxies/assignments/export` | 导出分配关系 |
| POST | `/api/proxies/assignments/import` | 预览分配导入（不执行） |
| POST | `/api/proxies/assignments/apply` | 应用分配导入 |

### 设置

| 方法 | 路径 | 说明 |
|------|------|------|
| PUT | `/api/proxies/settings` | 更新健康检查间隔 |

---

## 管理 & 设置

### 通用设置

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/general-settings` | 获取全部设置 |
| POST | `/admin/general-settings` | 更新设置（返回 `restart_required` 标志） |
| GET | `/admin/settings` | 获取 proxy API key |
| POST | `/admin/settings` | 设置 proxy API key |
| GET | `/admin/rotation-settings` | 获取轮转策略 |
| POST | `/admin/rotation-settings` | 设置轮转策略 |
| GET | `/admin/quota-settings` | 获取配额设置 |
| POST | `/admin/quota-settings` | 更新配额设置 |

### 诊断

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康探针 → `{ status, authenticated, pool }` |
| POST | `/admin/test-connection` | 完整连通性诊断 |
| GET | `/debug/fingerprint` | TLS 指纹配置（仅 localhost） |
| GET | `/debug/diagnostics` | 系统诊断信息（仅 localhost） |
| GET | `/debug/models` | 模型存储内部状态 |

### 成功调用记录

以下端点复用现有 Dashboard 鉴权。列表只返回短预览；完整脱敏正文仅由详情端点返回。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/call-records` | 按服务端筛选与分页列出成功调用 |
| GET | `/admin/call-records/:id` | 获取一条记录及完整脱敏请求/响应 JSON |
| GET | `/admin/call-contexts` | 按会话、任务和执行目录聚合 |
| GET | `/admin/call-records/state` | 返回采集配置、SQLite 路径、数量、大小和搜索模式 |
| POST | `/admin/call-records/clear` | 删除全部调用记录与上下文 |

`GET /admin/call-records` 支持 `from`、`to`、`context_id`、`session_id`、`task_id`、`cwd`、`model`、`provider`、`account_id`、`protocol`、`stream`、`search`、`sort`、`order`、`limit`（最大 200）和 `offset`。`sort` 仅允许 `completed_at`、`latency_ms`、`input_tokens`、`output_tokens`，`order` 仅允许 `asc` 或 `desc`。

采集通过 `call_records.enabled`（或 `/admin/general-settings` 的 `call_records_enabled`）显式开启，数据保存在 `data/call-records.sqlite`。只写入成功调用，正文会脱敏并限制大小；当前 MVP 不评分、不评估。显式分组请求头为 `x-codex-proxy-session-id`、`x-codex-proxy-task-id` 和 `x-codex-proxy-cwd`。

## 官方 Codex App Server Bridge

可选桥接到本机官方 `codex app-server`。这条路径用于复用官方 Codex app
插件能力，例如 Chrome/browser 插件。默认关闭：`official_agent.enabled:
false`。

以下端点强制要求独立的 `official_agent.api_key`；未配置该 key 时，桥接会拒绝请求。
不要复用 `server.proxy_api_key`，因为该桥接可以驱动本机 app-server 插件和审批流程。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/official-agent/apps` | 通过 `app/list` 列出官方 Codex apps/connectors |
| POST | `/official-agent/threads` | 创建 app-server thread（`{ model?, cwd? }`） |
| POST | `/official-agent/threads/:threadId/turns` | 发起 turn，并以 SSE 流式返回 app-server notifications |

turn 请求里的 `approvalPolicy` 如需传入，只允许 `untrusted`、`on-request`、
`on-failure`、`never`。

使用官方 Chrome app mention 的请求示例：

```json
{
  "text": "Open localhost:8080 and inspect the dashboard",
  "app": { "id": "chrome", "name": "Chrome" }
}
```

桥接层会发送一个 text item 和一个 `path: "app://{id}"` 的 `mention`
item。实际 app id 请先通过 `/official-agent/apps` 探测，不要默认硬编码。

### 更新

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/update-status` | 检查可用更新 |
| POST | `/admin/check-update` | 触发更新检查 |
| POST | `/admin/apply-update` | 执行自更新（SSE 进度流） |

### 用量统计

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/usage-stats/summary` | 按账号/模型的累计用量 |
| GET | `/admin/usage-stats/history` | 时序数据（`?granularity=hourly&hours=24`） |

### 局域网额度汇总

`GET /api/quota-summary` 汇总所有 `status=active` 账号的缓存额度，供局域网内的
外部系统读取。该端点不需要 Dashboard 密钥，但只接受回环地址、RFC1918 IPv4、
IPv4 link-local、IPv6 ULA 或 IPv6 link-local 来源；公网来源返回 `403`。启用
`server.trust_proxy` 后，来源地址按 `X-Forwarded-For` / `X-Real-IP` 判定。

```bash
curl http://172.16.100.175:8080/api/quota-summary
```

返回的 `windows` 按实际 `limit_window_seconds` 分类：`five_hour`（18000 秒）、
`seven_day`（604800 秒）、`thirty_day`（2592000 秒），其他或上游未提供时长的
窗口进入 `other`，不会把 30 天额度混入周额度。`remaining_percent_total` 是各已
上报账号的剩余百分比点之和（例如 80% + 60% = 140），并同时返回平均值、已上报
/缺失账号数、耗尽账号数、重置时间范围和实际来源窗口。查询只读缓存，不会触发
上游额度请求；可用 `oldest_quota_fetched_at` / `newest_quota_fetched_at` 判断数据
新鲜度。

### 配额告警

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/auth/quota/warnings` | 当前活跃的配额告警 |

启用 `quota.skip_exhausted` 后，账号池会在获取账号时过滤缓存额度中
`rate_limit.limit_reached === true` 或
`secondary_rate_limit.limit_reached === true` 或
`code_review_rate_limit.limit_reached === true` 的 active 账号。过滤发生在
session affinity 之前，所以 `preferredEntryId` 不能把请求继续粘到已耗尽账号。
如果只是 `used_percent=99` 这类临近满额，但上游还没标记 `limit_reached`，代理
不会主动跳过；等上游返回 429 后，该账号会进入 `rate_limited` 退避并切换账号。
secondary / code review 窗口自己的 `reset_at` 过期后会从缓存中清除，避免账号被
永久跳过。

---

## Dashboard 认证

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/dashboard-login` | 使用 `dashboard.admin_key` 登录 → 设置 session cookie（限流：5次/分钟） |
| POST | `/auth/dashboard-logout` | 退出登录 |
| GET | `/auth/dashboard-status` | 检查 session 状态；管理登录始终必需 |

缺少 `dashboard.admin_key` 时会自动生成并持久化，且绝不回退到 `server.proxy_api_key`。API 和页面都不会返回现有管理密钥。通过 `POST /admin/settings` 替换管理密钥会撤销全部 Dashboard session 和 CSRF token。管理自动化可以发送管理 Bearer；浏览器页面应使用 session + CSRF 流程。

---

## 错误格式

各协议返回各自原生的错误结构：

| 协议 | 格式 |
|------|------|
| OpenAI | `{ error: { message, type, code, param } }` |
| Anthropic | `{ type: "error", error: { type, message } }` |
| Gemini | `{ error: { code, message, status } }` |
| Responses | `{ type: "error", error: { type, code, message } }` |
| Admin | `{ error: "..." }` |

常见 HTTP 状态码：`401`（未认证）、`429`（限流）、`503`（无可用账号）。
