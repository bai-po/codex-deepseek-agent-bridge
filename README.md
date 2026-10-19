# Codex ⇄ DeepSeek Agent Bridge

本地双向 agent 任务桥，版本 **1.0.3-local.2**，MIT。独立仓库：[bai-po/codex-deepseek-agent-bridge](https://github.com/bai-po/codex-deepseek-agent-bridge)。

Codex 端是 MCP 插件；DeepSeek Harness 端提供回环 HTTP 服务、身份映射和持久任务状态。两端均支持真实会话登记、任务列表、草稿、编辑、软删除/恢复、直接发送、更正修订与验收闭环。

- [安装、卸载与回滚](docs/INSTALL.md)
- [操作协议与示例](docs/USAGE.md)
- [Codex agent 手册](codex/MANUAL.md) · [DeepSeek agent 手册](deepseek/MANUAL.md)
- [测试范围和限制](docs/TESTING.md)

队列接受不证明已读、回复或验收通过。删除仅隐藏可恢复的桥接列表条目，不撤回聊天消息。双方确认同一修订后只发一次无需回信通知，接收方不再回执。

依赖 Node.js 22+、PowerShell 7+、支持插件与 queue 的 Codex CLI、DeepSeek Harness。主要安装验证平台为 Windows；其他系统未承诺安装器支持。运行 `npm test` 与 `npm run verify`；静态检查不能替代真实宿主功能验收。发布包不含本地 token、聊天或用户配置。

首次身份登记只返回一次能力密钥 agentKey，后续查询/重复登记不泄漏密钥。所有 bridge_task（含 list/get）需要 actorId 与 agentKey；修改 alias 也需要密钥。将自己的密钥保存在自己会话的本机私有状态，不发给对方，不写入 GitHub；丢失不能靠查编号取回。编号不构成可信宿主 session 认证，真实 sessionId 由调用者提供并核对。

任务列表参数示例（PLACEHOLDER 必须换成自己的密钥）：

```json
{"action":"list","actorId":"<自己的agentId>","agentKey":"PLACEHOLDER","includeDeleted":false}
```

本版本不发布 standalone 脚本，不依赖 Stop hook；autoNotify 强制禁用。闭环自动通知仅由 lifecycle 负责。

## 全新会话的首次调用顺序

1. Codex agent 从宿主核对自己当前真实 thread ID，调用 bridge_agent register，side=codex、sessionId=该 ID；私下保留首次返回的 agentKey 和公开编号。
2. DeepSeek agent 在自己的真实当前 Harness 会话调用 bridge_agent register，side=deepseek、sessionId=该会话 ID；私下保留自己首次返回的 agentKey 和公开编号。不能由 Codex 猜一个 DeepSeek sessionId 代为登记。
3. 双方只交换/查询公开编号，核对 side 与会话映射后，使用自己的 actorId、自己的 agentKey 和对方 recipientId 发送。密钥不交给对方。
4. 接收方没有先登记时不能直接接收 v2 任务；遇到 agent/not-found，先检查该接收会话是否已自行登记，不把它直接判成安装损坏。新会话需重新登记，不能复用旧会话身份。

当前 DSH 投递封装上限是 **4000 字符，包含桥接生成的头信息**，可用正文空间小于 4000。长说明、diff 与证据应写入双方确实可访问的文件，在正文给简短摘要、准确路径与验收要求；不能假定对方能读取共享范围之外的本机路径。先确认对方访问权限，必要时使用经授权的共享位置。超限失败后缩短材料并按实际投递状态重试，不把失败报告成成功。

身份发现边界：bridge_agent list/get 是回环 token 保护下的公开只读名录，不要求 agentKey，仅返回编号、side、sessionId、alias 等路由信息，绝不返回密钥或哈希。所有 bridge_task 操作（包括任务 list/get）及修改身份别名均要求自己的 agentKey；名录可见不表示可冒充该编号。
更正重试：correct 必须提供 reason、requestId 和首次操作时的 expectedRevision。一次更正意图始终沿用同一 requestId；重复调用返回当前条目，不重复投递；同一 ID 对应不同正文会冲突。结果不确定先查事件，不能换 ID 盲重发。
