# Codex ⇄ DeepSeek Agent Bridge

本地双向 agent 任务桥，版本 **1.0.5**，MIT。独立仓库：[bai-po/codex-deepseek-agent-bridge](https://github.com/bai-po/codex-deepseek-agent-bridge)。

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

## 未闭环只接受主动消息（1.0.4）

DeepSeek 必须主动用 codex_task(thread=<派发方真实 Codex thread UUID>, delivery=queue, message=<实际进度或审查结果>) 发送回报；只在自己的聊天回复、写 DONE、落盘报告或返回工具成功均不算发给 Codex。

Codex 等待主动到达当前聊天的消息。即使等待十分钟、旧工具描述叫“读回”、工具不可用或发现报告文件，也不得调用结果/会话/日志/报告读取来取得未闭环的 DeepSeek 正文。可以按需要检查健康、运行状态与任务归属元数据，不持续轮询正文。超时不是完成或闭环。不要绕过桥接限制用文件系统、会话记录或其他接口读取对方回报；工具不可用时报告未发送并修复推送通道。

bridge_task 的 list/get/refresh 及变更回执在未闭环时隐藏对方正文、证据与嵌套回执；自己写的内容仍可查。deepseek_result 对未闭环任务仅返回状态且 reply=null。queued/running/done/error、停止运行、单方 complete/confirm 或工具返回成功都不是闭环。只有服务验证同修订 complete、双方 accepted confirm 和已送达的 replyRequired=false 闭环事件后，才允许读取这个任务的归档；reopen 后重新隐藏。不得为读正文先做虚假验收或提前关闭。

旧 deepseek_task 必须携带 replyThreadId=<当前真实 Codex thread UUID>；旧工具不支持该字段时，在 summary 单独一行写 [Agent Bridge Reply-To: codex <UUID>]。没有实际会话 UUID 时先解决身份缺失，禁止 PID、最新会话猜测和其他聊天编号。Codex→DSH 时以发送方真实 thread UUID 作为回信目标；DSH→Codex 时使用登记接收方的 sessionId 路由，不设置 replyThreadId。replyRequired=false 闭环通知不带回信目标，收到后不回执。

发送较长审查时可分条主动发送。共享文件可作为事先授权的输入材料，但不能用其替代未闭环的对方回报推送；对方应主动发送结论与必要证据。插件限制桥接接口和代理使用流程，不宣称撤销通用文件系统权限。

遇到推送未到达时，按 docs/PUSH-RECOVERY.md 的元数据排查步骤处理；不得以超时或工具故障转读对方报告。

新客户端首先检查health.readPolicy；不支持push-only-until-closed的旧服务返回bridge/upgrade-required，且不调用任务结果或v2任务端点。请升级服务，不把客户端二次过滤当成允许从旧服务拉取正文。

## 双端兼容入口与导入（local.4）

DSH 的 codex_task 只发送消息，不等待或返回对方正文；旧 waitMs 参数仅兼容接收，不开启读回。codex_result 对所有任务都立即读取一次状态，不因 waitMs 等待；开放任务只查独立元数据，验证闭环后才可读取归档。Codex 的 deepseek_result 默认 waitMs=0，立即读取状态；显式 waitMs>0 时只发一次 POST /tasks/{id}/wait 等待状态变化（最长 30000ms），响应仍按闭环策略过滤，开放任务 reply=null。这不是等待对方正文的接口，也不能用于轮询。Codex 仍通过主动 deepseek_task / bridge_task 将结果发回明确会话，DSH 也必须主动 codex_task 回报。

新版运行时为 Codex 出站任务另存 status.json。旧记录若只有混合正文的 meta.json，则未闭环状态显示 unknown，不能为了补状态读取旧 meta.json / reply.txt。原记录保留不改写，闭环后才可按任务核验归档。

import 只迁移旧任务指向与状态，不复制源标题、正文或嵌套回报；不能把未闭环内容变成“自己拥有的正文”。旧数据原地保留，主动消息与双边验收仍按真实证据进行。legacy owner 的 summary 仅对带独立 status.json 的新记录可查询；只有旧 meta.json 的记录显示 unknown，未闭环时不读取旧混合正文，因此无法恢复其中的 summary。

codex_threads 是本插件唯一保留的 rollout 读取，仅读取首行/头部元数据用于线程发现，不读取任务或对话正文。

deepseek_report_turn_end 已禁用为兼容空操作：不读 rollout、不发 HTTP、无自动消息。不得用它回复闭环通知。
