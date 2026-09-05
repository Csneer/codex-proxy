# Codex Proxy Account Factory 集成与交接

更新时间：2026-08-12

本文替代此前仅描述“调用记录 MVP”的旧交接内容。调用记录仍是现有功能，但当前跨项目交接重点是：

- `/home/pokison/projects/hand-gpt/mail-code-dashboard`
- `/home/pokison/projects/hand-gpt/free-account-tool`
- `/home/pokison/projects/codex-proxy-src`

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
- 在账号状态区域展示优惠资格；“检测资格”会按当前筛选结果选取有 AT/Session 的账号，每次最多 10 个。
- 按账号状态、生命周期筛选。
- 按录入时间排序。
- 列表压缩为：邮箱、账号状态、来源、操作，避免横向滚动。
- 详情按需读取凭据，并提供显示/隐藏/复制。
- 已存储 TOTP 的账号可在详情中打开高层弹窗，按 RFC 6238 查看当前 6 位验证码、倒计时和进度条，并可复制；验证码按需生成，不会持久化。
- 首页“已连接账号”列表默认将 `active`（启用）账号置于第一页前面；同一组内继续保持接口原有录入顺序，状态筛选和展开/收起行为不变。
- 新增或编辑时可填写、修改、保留或清空：
  - 邮箱密码
  - ChatGPT 密码
  - TOTP
  - 邮箱接码 URL
  - Session
  - Access Token
  - Refresh Token
- Session 支持较长 JSON 或原始文本。

列表 API 只返回 `hasSession/hasAccessToken/hasRefreshToken` 等布尔值，不暴露实际 secret。实际值只在带 `Cache-Control: no-store` 的详情接口返回；TOTP 验证码接口同样使用 `no-store`，只返回短时有效的验证码快照，不返回密钥。

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
/home/pokison/projects/codex-proxy-src/data-source
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

如果扩展 ID 固定，可用具体 ID 替代 `"*"`。解压目录变化会导致 Chrome 扩展 ID 变化；当前主要使用场景仍是本机 localhost 或加密 ZeroTier/隧道入口，依赖独立集成 token 控制访问。

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

配置入口已由提交 `d78dda1` 恢复显示。插件接受 HTTP(S) 地址，可使用本机 loopback 或私有隧道入口，并先检查服务 health、capability 和可用库存数。

邮箱不需要在插件里再次导入：`account-factory-mailbox-sync.timer` 负责将 Mail Dashboard 同步到 Proxy 数据库。只有 Dashboard 中 `group=unused` 的邮箱具备注册资格；`finished / trash / unknown` 会被阻止。Proxy 还会排除已有 `free / plus` 状态或 ChatGPT 密码、TOTP、Session、Access Token、Refresh Token 的账号。

首次部署此资格规则后，需要打开或刷新一次 Mail Dashboard 页面，把旧浏览器 `localStorage` 分组迁移到服务端；在完成迁移前，历史邮箱按 unknown 保守处理，不会被误领。

插件通过 `GET /candidates?limit=10` 随机读取最多 10 个 Mail Dashboard 候选，并保存用户勾选的账号 ID。`POST /claims` 的 `selectedAccountIds` 将领取范围限制在所选账号中；所选账号已被使用时返回 `selected_inventory_unavailable`，不会回退到其它后台库存。若旧版插件曾覆盖本地 checkpoint，新版会在步骤 5、9、10 需要账号工厂上下文时，按原 `taskId` 调用 `GET /claims/recovery` 恢复既有租约。

使用顺序：

1. 确认两个服务和同步 timer 正常。
2. 首次升级后刷新 Mail Dashboard，并等待一次同步日志出现 `eligible/blocked` 摘要。
3. 在插件选择 `Codex Proxy Local`，点击“检查”或“换一批”，勾选本轮候选邮箱。
4. 自动运行轮数设置为不超过已勾选邮箱数量，然后开始注册。
5. 注册完成后检查插件第 10 步或“远端同步”计数；如果浏览器中途异常，可单独再次执行第 10 步作为兜底。
6. 在 Proxy 中筛选 `free + registered`，点击“查看”核对 Session/AT/RT。
7. 需要加入核心轮转池时再点击“提升”。

## 6. 当前运行快照

2026-08-12 采样：

```text
Mail Dashboard Apple 目录     434
同步资格摘要                  370 eligible / 64 blocked / 0 deactivated
Proxy health 可领取            364
mail_dashboard available       363
mail_dashboard registered      42
mail_dashboard registering     15
mail_dashboard retired         14
```

`available` 的统计和 claim 使用同一严格条件：账号必须 active、unregistered、lifecycle=available，且不存在任何 GPT 凭据。health 的 `inventory.available` 只统计真正可 claim 的严格库存，因此会小于数据库里单纯按 lifecycle 汇总的 available 数。

因此当前页面显示大量“未注册/未设置”是库存尚未消费的结果，不是同步或存储错误。当前链路已经可以稳定领取、注册、保存本地账号并同步回 Proxy；详情页中已有注册完成账号可直接查看和复制凭据，也可以直接获取已存储 TOTP 的当前验证码。

## 7. 关键接口

### Account Factory 集成接口

基础路径：`/integration/account-factory/v1`

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/health` | schema/capability 检查 |
| GET | `/candidates` | 随机列出最多 10 个 Mail Dashboard 严格候选，并优先保留已选 ID |
| POST | `/mailboxes/sync` | 同步邮件目录 |
| POST | `/claims` | 仅从 `selectedAccountIds` 中领取账号 |
| GET | `/claims/recovery?taskId=...` | checkpoint 丢失时只读恢复既有租约；不存在时返回 404，不领取新账号 |
| POST | `/accounts/:id/submission-commit` | 邮箱提交确认 |
| GET | `/accounts/:id/verification-code` | 验证码轮询 |
| PATCH | `/accounts/:id/progress` | 进度回写 |
| GET | `/accounts/:id/sync-state` | complete 对账 |
| POST | `/accounts/:id/complete` | 最终账号、注册备注和资格状态回写 |
| POST | `/accounts/:id/fail` | 失败处理 |
| POST | `/accounts/:id/promote` | 显式提升 |

### Dashboard 管理接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET/POST | `/admin/backup-resources/accounts` | 列出或新增 |
| GET/PATCH/DELETE | `/admin/backup-resources/accounts/:id` | 详情、编辑、删除 |
| GET | `/admin/backup-resources/accounts/:id/totp` | 按需生成当前 TOTP 验证码（`Cache-Control: no-store`） |
| POST | `/admin/backup-resources/accounts/:id/promote` | 提升或重试 |
| GET/POST | `/admin/backup-resources/phones` | 接码手机号列表/新增 |

Account Factory 使用 `X-Account-Factory-Token`；Dashboard API 使用 Dashboard 管理认证。二者不能混用。

## 8. 验证记录

最近完成的验证：

- Account Factory 路由测试：12/12 通过，覆盖 `claims/recovery`。
- 插件账号工厂定向测试：24/24 通过，覆盖 checkpoint 保留、租约恢复和消息恢复。
- 插件 `npm run check` 通过；Proxy `npm run build`、`npx tsc --noEmit` 通过。
- TOTP RFC 6238 生成器测试 10/10、TOTP 管理路由测试 2/2 通过，覆盖标准向量、URI 参数、无密钥/坏密钥、404 和 `no-store`。
- Web 备用账号交互测试 16 个文件 / 75 个测试通过，覆盖高层 TOTP 弹窗、倒计时、复制入口和 Esc 关闭行为。
- 实际同步日志输出 `accounts / eligible / blocked / deactivated` 摘要，当前 timer 按 5 分钟稳定运行。
- `codex-proxy-source.service`、`mail-code-dashboard.service`、`account-factory-mailbox-sync.timer` 当前均为 active。

## 9. 已知边界和后续工作

- complete 不自动 promotion，这是当前有意设计。
- Mail Dashboard 使用 Apple 私有接口，可能受 Apple 变更影响。
- 当前面向本机或加密 ZeroTier 网络的个人工具，不按公网发布系统设计。
- 如果以后启用 ZeroTier 访问，必须明确处理 HTTPS、Origin、扩展 ID 和访问控制，而不是直接放宽所有 host。
- `config/default.yaml` 的用户修改和 `data-source` 运行数据必须继续独立于功能提交。
