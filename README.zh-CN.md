# opencode-plugin-peers

[English](./README.md) | **中文**

[![npm version](https://img.shields.io/npm/v/opencode-plugin-peers.svg)](https://www.npmjs.com/package/opencode-plugin-peers)
[![npm downloads](https://img.shields.io/npm/dm/opencode-plugin-peers.svg)](https://www.npmjs.com/package/opencode-plugin-peers)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/jkrandom-sudo/opencode-plugin-peers/blob/main/LICENSE)

[opencode](https://opencode.ai) 的跨会话消息插件 —— 让同一台机器上彼此独立的 opencode 实例互相发现、互发纯文本消息。设计参考了 [Claude Code 的跨会话消息](https://claudefa.st/blog/guide/mechanics/cross-session-messaging)。

并行运行多个 opencode 终端（不同的仓库、worktree 或任务），让它们直接互相传递结论，而不是在窗口之间手动复制粘贴上下文：

> 前端会话：*"API 契约变了，字段现在是 `user_id`"*
> 后端会话：*"迁移已完成，可以安全 rebase 到 main 了"*

## 功能特性

- `list_agents` / `send_message` 工具 —— Agent 可以发现对端并给它们发消息
- `/peers`（别名 `/list-agents`）、`/peers-name`、`/peers-inbox`、`/peers-outbox` 命令 —— 面向用户的控制入口
- 入站消息的 **accept / auto / hold / refuse** 四种门禁策略；`auto` 接受同目录对端，跨目录消息进入待审
- 每个 OpenCode 会话（包括子会话）都有一个可独立寻址的端点；出现重名时可用精确的端点 ID 区分
- 持久化机制完善：按会话的队列、待审消息、投递结果和发送方发件箱都能在进程重启后存活
- 被接受的消息会立即注入 —— 每条消息一次 `promptAsync` 调用，目标会话忙时同样立即注入
- 消息**仅限纯文本** —— 不能传文件，也不能共享对话历史
- **由对端消息触发的回合默认无人值守运行**：处理注入的对端消息期间产生的权限请求会被自动批准（`peerPermissions`，参考了 Claude Code 的权限模式）。你自己输入的回合不受影响
- 命令结果和通知**内联显示在会话中** —— 没有 toast 弹窗
- **明确的 TUI 控制**：面板操作使用宿主对话框进行选择确认；斜杠命令封装仍可用于自动化和兼容性场景
- 纯本地运行：一切都在你的机器上（macOS/Linux 使用 Unix 域套接字，Windows 使用回环 TCP，另有一个兼容 v1 对端的回环监听器）

## 安装

```bash
opencode plugin -g opencode-plugin-peers
```

或者加入你的 `opencode.json`：

```json
{
  "plugin": ["opencode-plugin-peers"]
}
```

要求 opencode >= 1.18.0。

**单回车执行命令（可选但推荐）。** 本包附带一个 TUI 入口，让插件的斜杠命令按一次回车即可执行。opencode 的 TUI 从 `~/.config/opencode/tui.json` 加载插件（这是与 `opencode.json` 相互独立的另一个列表），所以请把插件也加进去：

```json
{
  "plugin": ["opencode-plugin-peers"]
}
```

不加这个入口一切也照常工作 —— 只是命令会保持 opencode 默认的行为：第一次回车插入 `/name `，第二次回车才提交。说明：

- 自动补全仍然为每条命令显示**单独一行** `/peers*`（服务器定义的那个）。立即执行来自 TUI 入口中的一个高优先级回车绑定：当输入框内容恰好是一条插件命令 —— 或能唯一识别某条命令的前缀（如 `/peers-nam`）—— 回车立即执行；其他内容全部原样落回 opencode 的原生绑定。无论在会话内还是开始（主页）界面都有效 —— 主页界面会先创建一个会话，和普通提交完全一样。
- 携带**参数**输入的命令（如 `/peers-name frontend`）不受影响 —— 回车按正常方式提交，参数会被保留。
- 旧版 opencode 完全忽略 TUI 入口，保持两次回车的行为。

本地从源码目录开发时，把构建产物软链接到全局插件目录：

```bash
npm install && npm run build
ln -sf "$PWD/dist/index.js" ~/.config/opencode/plugins/opencode-plugin-peers.js
```

（`~/.config/opencode/plugins/*.js` 会在启动时自动加载。）

## 使用方法

**给实例命名**，让对端可以寻址你：

```
/peers-name frontend
```

**看看谁在线：**

```
/peers
```

```
Other Opencode sessions (2):
  [waiting]  ·  frontend  ·  /Users/you/app/frontend  ·  started 9m ago
  [idle]  ·  backend  ·  /Users/you/app/backend  ·  started 29m ago
```

`[waiting]` = 该处有一个回合正在运行，但对端消息仍会立即注入；`[idle]` = 没有回合在运行。出现排队消息只表示某次立即注入尝试需要重试，不代表投递会等待空闲；发送方在此期间会持有一个待确认的最终 ACK。

**让 Agent 来对话：**

```
Use send_message to tell "backend" that the login form now posts to /v2/login.
```

接收方会话会立即收到这条文本，以一条合成的用户消息形式出现，其中包含发送方精确的端点 ID 以及回复方式。`send_message` 返回一个追踪 ID；用 `peer_message_status` 或 `/peers-outbox` 来区分"传输层已收到"和"最终已投递"。

**审阅待审消息**（当 `inboundPolicy` 为 `"hold"` 时）：

```
/peers-inbox                 # 列出待审消息
/peers-inbox accept 2        # 投递第 2 条消息
/peers-inbox drop all        # 全部丢弃
/peers-outbox                # 回执与最终 ACK 结果
```

## 配置

可以通过 `opencode.json` 中的元组形式传入选项：

```json
{
  "plugin": [
    ["opencode-plugin-peers", { "inboundPolicy": "hold", "name": "frontend" }]
  ]
}
```

| 选项 | 默认值 | 说明 |
|---|---|---|
| `inboundPolicy` | `"accept"` | `accept` 立即投递；`auto` 仅当发送方与接收方目录相同时接受，否则进入待审；`hold` 暂存消息供人工审阅；`refuse` 直接拒绝 |
| `peerPermissions` | `"allow"` | 对端来源的权限请求：`allow` 自动批准普通请求，`ask` 保持原生提示不变，`deny` 拒绝。即使在 `allow` 模式下，OpenCode/插件权限配置、`AGENTS.md`、凭据/密钥以及权限升级也永远不会被自动批准；已存在的 OpenCode 拒绝规则始终优先 |
| `name` | `<dir>-<hex4>` | 其他对端用来寻址你的显示名；默认值在目录名后追加一个短十六进制后缀（取自实例 ID），使同目录的多个实例可以区分，与 Claude Code 的 `my-app-3f` 命名方式一致 |
| `storageDir` | `$XDG_DATA_HOME/opencode-plugin-peers` | 注册表与待审收件箱的存储目录 |
| `heartbeatMs` | `10000` | 注册表心跳间隔 |
| `staleMs` | `30000` | 心跳早于该时长则视为对端离线 |
| `maxQueue` | `50` | 排队中（已接受、未投递）消息上限 |
| `maxHeld` | `100` | 待审收件箱容量 |
| `heldExpiryMs` | `300000` | 待审消息的批准时限；超时会产生一条最终 ACK |
| `maxMessageBytes` | `8192` | 单条消息大小上限 |
| `sendRatePerMin` | `10` | 每个对端的出站限流 |
| `recvRatePerMin` | `20` | 每个发送方的入站限流 |
| `sweepMs` | `15000` | 投递/ACK 可靠性兜底扫描间隔 |

## 工作原理

```
OpenCode 进程 A                             OpenCode 进程 B
┌──────────────────────────────┐           ┌──────────────────────────────┐
│ 会话 A1 → 端点/spool          │           │ 会话 B1 → 端点/spool          │
│ 会话 A2 → 端点/spool          │           │ 会话 B2 → 端点/spool          │
│ 持久化发件箱 ◄── 最终 ACK      ├───────────┤ 本地 UDS/TCP 监听器           │
│ 注册表 v1 + v2 ─────────────┼──────────►│ promptAsync(精确会话)        │
└──────────────────────────────┘           └──────────────────────────────┘
```

- **发现**：协议 v2 为每个会话端点发布一条 `0600` 权限的注册表记录，并额外为最近活跃的根会话发布一条 v1 兼容记录。只有在本进程内有活跃迹象的会话才会被公布 —— 启动时的 busy/retry 状态、此后任何会话事件或消息活动，或有未投递 spool 记录等待恢复的会话。`session.list()` 返回的历史会话永远不会被公布，因此 `/peers` 只显示活跃会话（已关闭的进程在一个 stale 窗口内消失；已删除的会话在下一次心跳后消失）。读取方同时接受两个版本。默认对端名为 `<dir>-<hex4>`（如 `my-app-a3f2`），使同目录实例可以区分；显式的 `name` 选项或 `/peers-name` 会完全替换它。
- **传输**：v2 在 macOS/Linux 上使用带认证的 Unix 域套接字，Windows 上使用回环 TCP。另保留一个回环 HTTP 监听器供协议 v1 发送方使用。对端之间永远不会直接调用对方的 OpenCode 服务器。
- **投递与恢复**：每条消息是 `spool/<endpoint>/{queued,held,inflight,done}` 下一条 `0600` 权限的 JSON 记录。原子状态转移、进程锁、确定性的 OpenCode 消息 ID 和持久化去重使重试与重启都是安全的。旧版 `inbox.json` 会被归档但不投递，因为它没有可信的会话目标。
- **ACK 语义**：HTTP 接受只代表"已收到"。最终的 `delivered`、`refused`、`expired`、`dropped` 或 `duplicate` ACK 会持久化重试到发送方，并存入 `outbox/<sender-endpoint>`。
- **环路保护**：消息携带 `via` 跳数列表；超过 4 跳的链会被拒绝。

## 安全模型 —— 请务必阅读

- **同机信任**：任何以你的用户身份运行的进程都能读取注册表文件，从而向你实例的收件箱发消息。bearer token 只能防其他用户和误连，防不住拥有你 UID 的恶意进程。这与 Claude Code 本地 IPC 的信任级别一致。
- **提示注入**：对端消息对模型而言是不可信输入，和你手动粘贴的文本一样。纯文本无法传递文件、历史、授权或可执行的斜杠命令。在兼容默认的 `peerPermissions: "allow"` 下，普通工具请求可以无人值守执行；敏感项目请改用 `ask`、`hold` 或 `refuse`。
- **受保护类别护栏是尽力而为的，不是安全边界**：在 `allow` 模式下，插件对*提及*权限配置、`AGENTS.md`、凭据/密钥文件、shell 启动文件等敏感路径的请求会保留自己的自动批准 —— 但它匹配的只是请求文本，精心措辞的请求可以不出现这些路径（例如 `npm config set x y` 会写 `~/.npmrc` 但全程不显示该路径）。请把 `allow` 视为**完全信任机器上的每一个对端**；当这种信任不成立时，请设置 `ask`（或 `inboundPolicy: "hold"`/`"refuse"`）。
- **自动批准如何保持作用域**：插件监听权限请求事件，仅当发起请求的回合是由它注入的消息启动时（通过从工具调用的消息沿 `parentID` 向上追溯到原始用户消息并检查其 metadata 来判定）才会自动回复。你自己输入的回合产生的权限请求不会收到任何回复，原样落回 opencode 的正常提示流程。

## 局限性

- 仅支持同一台机器（暂不支持跨主机转发）
- OpenCode 的 `command.execute.before` 钩子目前不可取消。因此斜杠命令通过把提示文本替换为一个无害的已处理标记来"消费"；TUI 面板操作提供了显式对话框，但服务器钩子本身无法阻止后续的命令处理。
- 没有共享对话记录、Remote Control、Agent View、跨机器转发，也没有兼容 Claude Code 的团队/任务编排。

## 与 Claude Code 的对比

| 能力 | Claude Code | peers 0.2.0 |
|---|---|---|
| 跨进程与同进程会话寻址 | 原生支持 | 是，本地端点注册表 |
| 重名时的精确目标 | 是 | 是，存在歧义时要求使用端点 ID |
| 目标忙时发消息 | 是 | 是，立即注入一条消息的 `promptAsync` |
| 持久化投递/重启恢复 | 产品层面托管 | 是，文件系统 spool 与持久化 ACK/发件箱 |
| 权限边界 | 原生策略集成 | 基于事件的 allow/ask/deny，带受保护类别护栏 |
| 用户批准交互 | 原生 | 显式的宿主 TUI 对话框加斜杠命令封装 |
| 远程控制 / 共享任务 UI | Claude 生态可用 | 超出范围 |

本地纯文本交接在发现、精确寻址、忙时投递、重启恢复和最终结果追踪这些方面的效果基本等价。但它不是 Claude Code 产品级编排或远程 UI 的平替实现。

## 端到端验证

```bash
# 终端 1
cd /tmp/proj-a && opencode
/peers-name alpha

# 终端 2
cd /tmp/proj-b && opencode
/peers-name beta
/peers        # 应该能看到 alpha

# 在 beta 的会话中：
Use send_message to tell "alpha": the deploy keys rotated, pull again.

# alpha 会立即收到这条文本，即使它的会话正在忙；
# "传输层已收到"与"最终投递 ACK"始终是两个不同的概念。
```

开发中使用的无头（headless）变体：

```bash
cd /tmp/proj-a && opencode serve --port 14100 &
cd /tmp/proj-b && opencode serve --port 14101 &
# 然后通过 HTTP API 驱动两边（POST /session、/session/:id/prompt_async）
```

无凭据的真实进程测试会启动真实的 OpenCode 进程，并驱动已加载插件的事件与命令钩子。它会在真实 `promptAsync` 注入前验证 busy 注册表状态，通过真实存储的对端消息解析权限来源，验证默认 `allow` 与 `ask` 的差异，并检查受保护请求是否被留给原生策略处理。由于缺少模型提供商凭据，它无法产生真实的提供商权限请求，因此测试桩记录的是插件的回复调用，而不是声称完成了端到端原生权限提示；其余的原生拒绝和受保护类别判定由专项测试覆盖。

## 开发

```bash
npm install
npm run build       # tsc → dist/
npm test            # build + node --test tests/*.test.mjs
npm run typecheck
npm run dry-run     # npm publish --dry-run
```

除 `@opencode-ai/plugin`（peer 依赖）和 `zod`（工具 schema）外，零运行时依赖。

## 许可证

MIT
