# Codex Proxy Account Factory 集成与交接

更新时间：2026-08-10

本文替代此前仅描述“调用记录 MVP”的旧交接内容。调用记录仍是现有功能，但当前跨项目交接重点是：

- `/home/devops/projects/hand-gpt/mail-code-dashboard`
- `/home/devops/projects/hand-gpt/free-account-tool`
- `/home/devops/projects/codex-proxy-src`

## 1. 当前架构

Codex Proxy 已成为三个项目的账号信息和生命周期中枢：

```text
Mail Dashboard
  Apple HME 目录 + 自动补货 + 转发邮箱验证码
       ↓ account-factory-mailbox-sync.timer（5 分钟）
Codex Proxy backup-resources.sqlite
  备用账号 + 租约 + 生命周期 + 加密凭据
       ↓ claim / commit / poll / complete
Free Account Tool
  浏览器注册 + Session/AT 采集 + 持久 outbox
       ↓ optional promote
Codex Proxy 核心账号池
```

三个主体功能已经完成 MVP 联动，不需要再分别导出邮箱、手工复制验证码或手工把注册结果录入备用账号库。

## 2. 已完成能力

### 邮箱同步

- `/integration/account-factory/v1/mailboxes/sync` 从 Mail Dashboard `/api/icloud/list` 读取 Apple 当前 HME 目录。
- 以标准化邮箱作为 `externalId`，以邮箱和 Apple label 形成 source revision。
- 创建或更新 `mail_dashboard` 来源账号。
- 每轮同步后对来源快照做 reconcile，不再存在的来源账号标为 inactive。
- 已存在的手工账号若邮箱匹配，可以被来源同步接管，避免重复行。
- systemd timer 每 5 分钟自动同步。

### 注册生命周期

```text
available -> leased -> registering -> registered -> promoted
                         \-> invalid / retired
```

- claim 绑定 consumer、task 和 lease。
- 邮箱提交前必须显式 `submission-commit`。
- 验证码查询必须匹配 account、lease、task 和 after 时间。
- progress、complete、fail 都使用 operation identity 幂等处理。
- complete 与 promotion 分离；注册完成不会偷偷导入核心池。

### 插件回写

Free Account Tool 第 9 步会从本地规范账号记录重建 complete DTO，并回写：

```text
emailPassword
chatgptPassword / password
totpSecret
session
accessToken
refreshToken
accountStatus
registrationRoute
eligibility / validity metadata
```

插件 outbox 本身不保存 secret；网络失败、Service Worker 重启或响应丢失后通过重试和 `sync-state` 对账。

### 备用资源管理 UI

页面：

```text
http://127.0.0.1:8080/#/backup-resources
```

当前支持：

- 搜索邮箱、备注、账号状态和来源。
- 按账号状态、生命周期筛选。
- 按录入时间排序。
- 列表压缩为：邮箱、账号状态、来源、操作，避免横向滚动。
- 详情按需读取凭据，并提供显示/隐藏/复制。
- 新增或编辑时可填写、修改、保留或清空：
  - 邮箱密码
  - ChatGPT 密码
  - TOTP
  - 邮箱接码 URL
  - Session
  - Access Token
  - Refresh Token
- Session 支持较长 JSON 或原始文本。

列表 API 只返回 `hasSession/hasAccessToken/hasRefreshToken` 等布尔值，不暴露实际 secret。实际值只在带 `Cache-Control: no-store` 的详情接口返回。

### 本地加密与备份

- 数据库：`data-source/backup-resources.sqlite`
- 密钥：`data-source/backup-resources.key`
- 算法：AES-256-GCM
- Schema version：7
- 支持迁移前检查、SQLite snapshot 和 restore 脚本。
- 数据库存在但密钥丢失时拒绝自动创建新密钥，避免静默破坏旧数据。

### 提升到核心账号池

- 已注册账号可以显式 promotion。
- 有 Refresh Token 时使用 refreshable 模式。
- 没有 Refresh Token 时只有调用方明确允许才可使用 ephemeral 模式。
- import 和 link 状态分开保存，失败可重试。
- Dashboard 当前提供提升/重试操作。

## 3. 运行层

当前用户服务：

```text
mail-code-dashboard.service
codex-proxy-source.service
account-factory-mailbox-sync.timer
account-factory-mailbox-sync.service
```

常用命令：

```bash
systemctl --user status codex-proxy-source.service
systemctl --user status mail-code-dashboard.service
systemctl --user list-timers account-factory-mailbox-sync.timer
systemctl --user start account-factory-mailbox-sync.service
journalctl --user -u account-factory-mailbox-sync.service -n 20 --no-pager
```

同步脚本使用：

```text
~/.local/bin/account-factory-mailbox-sync
~/.config/account-factory/mailbox-sync.env
```

环境文件必须保持 `0600`，其中的集成令牌不能写入仓库。

## 4. 当前配置边界

活动服务数据目录：

```text
/home/devops/projects/codex-proxy-src/data-source
```

`data-source/local.yaml` 已启用：

```yaml
account_factory:
  enabled: true
  token: <local-secret>
  allowed_extension_ids:
    - "*" # 仅适用于 loopback + 私有 token 的个人解压扩展
  mail_dashboard_base_url: http://127.0.0.1:4173
```

如果扩展 ID 固定，可用具体 ID 替代 `"*"`。解压目录变化会导致 Chrome 扩展 ID 变化；个人本机模式仍同时要求 loopback 来源和独立集成 token。

不要在文档中填写真实 token、Dashboard 密码或扩展运行数据。

仓库根目录 `config/default.yaml` 有用户原有未提交修改，当前保护基线为：

```text
git hash-object: 096ce1e779a39867979aee750d374e8bce929e78
sha256:          67564379eabab85ff7d86ab3a8d0ec54ed7b2ec385ec4c6d37573a4516333105
```

整理提交时不要把该文件混入 Account Factory 文档或功能提交。

## 5. 插件配置和使用

在 Free Account Tool 中：

```text
邮箱 Provider = Codex Proxy Local
Base URL       = http://127.0.0.1:8080
Token          = account_factory.token
Consumer ID    = free-account-tool
```

配置入口已由提交 `d78dda1` 恢复显示。插件只接受 loopback HTTP 地址，并先检查服务 health、capability 和可用库存数。

邮箱不需要在插件里再次导入：`account-factory-mailbox-sync.timer` 负责将 Mail Dashboard 同步到 Proxy 数据库。启动自动注册时，插件会从 `available` 库存按入库顺序自动领取；MVP 不要求每轮手工选邮箱。

使用顺序：

1. 确认两个服务和同步 timer 正常。
2. 打开 Proxy 备用资源页面，确认存在 `available` 邮箱。
3. 在插件选择 `Codex Proxy Local` 并开始注册。
4. 注册完成后检查插件“远端同步”计数。
5. 在 Proxy 中筛选 `free + registered`，点击“查看”核对 Session/AT/RT。
6. 需要加入核心轮转池时再点击“提升”。

## 6. 当前运行快照

2026-08-10 采样：

```text
Mail Dashboard Apple 目录     199
Proxy mail_dashboard active   199
Proxy manual/unset            18
Proxy 总备用账号              217
available                     217
registered/promoted           0
带 Session/AT/RT              0 / 0 / 0
```

因此当前页面显示大量“未注册/未设置”是库存尚未消费的结果，不是同步或存储错误。完成第一条真实插件注册后，相应账号才会变为 `registered` 并出现可复制凭据。

## 7. 关键接口

### Account Factory 集成接口

基础路径：`/integration/account-factory/v1`

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/health` | schema/capability 检查 |
| POST | `/mailboxes/sync` | 同步邮件目录 |
| POST | `/claims` | 领取账号 |
| POST | `/accounts/:id/submission-commit` | 邮箱提交确认 |
| GET | `/accounts/:id/verification-code` | 验证码轮询 |
| PATCH | `/accounts/:id/progress` | 进度回写 |
| GET | `/accounts/:id/sync-state` | complete 对账 |
| POST | `/accounts/:id/complete` | 最终账号回写 |
| POST | `/accounts/:id/fail` | 失败处理 |
| POST | `/accounts/:id/promote` | 显式提升 |

### Dashboard 管理接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET/POST | `/admin/backup-resources/accounts` | 列出或新增 |
| GET/PATCH/DELETE | `/admin/backup-resources/accounts/:id` | 详情、编辑、删除 |
| POST | `/admin/backup-resources/accounts/:id/promote` | 提升或重试 |
| GET/POST | `/admin/backup-resources/phones` | 接码手机号列表/新增 |

Account Factory 使用 `X-Account-Factory-Token`；Dashboard API 使用 Dashboard 管理认证。二者不能混用。

## 8. 验证记录

最近完成的验证：

- Account Factory 生命周期测试：12/12 通过。
- 备用账号 Admin CRUD 测试：4/4 通过。
- 备用资源前端测试：13/13 通过。
- `npm run build` 通过。
- 实际服务 API 完成新增、查看解密、修改、清空和删除 Session/AT/RT 冒烟验证。
- `codex-proxy-source.service` 重启后 active。

当前关键提交：

```text
dce05e1 feat: manage backup session credentials
f1a3e06 fix: compact backup account list
da5a9ec feat: filter and sort backup accounts
809b09c fix: adopt matching mailbox inventory accounts
dbea993 task: add promotion dashboard controls
```

## 9. 已知边界和后续工作

- 需要用真实浏览器注册完成一条端到端链路；当前库存尚未产生 registered 账号。
- complete 不自动 promotion，这是当前有意设计。
- Mail Dashboard 使用 Apple 私有接口，可能受 Apple 变更影响。
- 当前面向本机或加密 ZeroTier 网络的个人工具，不按公网发布系统设计。
- 如果以后启用 ZeroTier 访问，必须明确处理 HTTPS、Origin、扩展 ID 和访问控制，而不是直接放宽所有 host。
- `config/default.yaml` 的用户修改和 `data-source` 运行数据必须继续独立于功能提交。
