# dsh-agent-bridge（DSH 端插件）

DSH 侧的一半：把 Codex 的短任务消息接进 DSH 会话，并让 DSH agent 反过来把任务发给既有 Codex 会话。

- 协议：`../docs/protocol.md`
- Codex 侧另一半：`../codex-plugin/`

## 它做什么

1. 在 DSH 内置回环 web server 上挂 `/agent-bridge`：
   - `GET /ping`、`GET /health`、`GET /sessions`
   - `POST /tasks/send`（Codex → DSH，注入一条普通 user 消息）
   - `GET /tasks/{id}`、`POST /tasks/{id}/wait`、`GET /tasks`
   - `POST /events`（Codex Stop hook 自动上报）
2. 激活时写发现文件 `~/.dsh/agent-bridge/endpoint.json` 与 token `~/.dsh/agent-bridge/token`。
3. 注册 DSH 工具：`codex_task`、`codex_result`、`codex_threads`、`bridge_status`（DSH → Codex，走本机 `codex` CLI）。
4. 审计：`~/.dsh/agent-bridge/audit.jsonl`（只有任务 ID、方向、长度、状态，不含正文）。

## 配置（cordis.patch.yml 的 config）

| 键 | 默认 | 说明 |
|---|---|---|
| `prefix` | `/agent-bridge` | 路由前缀 |
| `stateDir` | `~/.dsh/agent-bridge` | token / endpoint / tasks / audit 的目录 |
| `workspaceRoot` | `process.cwd()` | 默认 DSH 会话与默认 Codex 线程的筛选工作区 |
| `codexBin` | 自动探测 | `codex.exe` 路径 |
| `autoNotify` | `true` | 是否接受 Codex Stop hook 的 `POST /events` |
| `maxWaitMs` | `30000` | 长轮询上限 |
| `taskTimeoutMs` | `600000` | 单任务等待 DSH turn 结束的上限 |

## 安装 / 卸载

```powershell
# 安装（DSH 已登录桌面端时）
# 通过 DSH 的插件管理：plugin_manager install_bundle <本目录绝对路径>
# 或：DSH 设置 → 插件 → 添加插件 → 本地目录

# 卸载
# plugin_manager remove_bundle dsh-agent-bridge
# 删除 ~/.dsh/agent-bridge/ 即无残留（会话中的历史消息不受影响）
```

## 边界

- 只监听 DSH 自己的回环地址；不新开端口、不监听 `0.0.0.0`。
- 不读写 DSH / Codex 的会话存储文件；只通过 `sessionController` 和 `codex` CLI 的公开接口工作。
- 注入消息是普通 user 消息，DSH agent 自己决定是否处理，不会自动开始审查或改代码。
- 每个有任务的会话只保留一条 live tail；任务结束后 5 分钟无活动即断开。

## 1.0.2-local.1 消息投递

codex_task 必须提供接收方准确的 thread UUID；不再按最新聊天猜测。默认 delivery=queue，通过公开 codex queue 排入该聊天，避免与桌面端活动writer竞争。正在进行的轮次结束后才可处理排队消息；排队接受不代表已读或已回复。delivery=resume 只适合明确未被桌面或其他客户端占用的聊天。

队列命令的即时失败直接返回工具错误。codex_result用于查看命令接受或错误；队列投递不跟踪接收聊天的后续模型回复。

