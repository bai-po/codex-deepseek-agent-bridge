# Codex agent 手册

版本 1.0.5。通过 MCP 使用，bridge_manual 可读本手册；sessionId 是当前真实 Codex thread ID。DeepSeek 须先启动插件。默认 queue 投递，活动聊天不要用 exec resume 抢 writer。

# 工具操作

bridge_agent 的 action 为 register/list/get；字段含 side（codex/deepseek）、真实 sessionId、agentId、可选 alias。同一真实会话复用持久编号。别名不是底层会话身份，不冒用编号，不猜“最新聊天”。缺当前真实 ID 时明确请求信息。

bridge_task 的 action 为 create/list/get/edit/delete/restore/send/refresh/correct/complete/confirm/close/reopen/import。按动作提供 actorId、recipientId、taskId、expectedRevision、requestId、title、content、evidence、verdict、reason、includeDeleted、legacyTaskId、legacyDirection。具体必填以工具 schema 为准。

示例中的占位符必须替换为实际值：

```json
{"action":"register","side":"codex","sessionId":"<当前真实会话ID>","alias":"执行者"}
```

```json
{"action":"list","actorId":"<自己的agentId>","agentKey":"PLACEHOLDER","includeDeleted":false}
```

```json
{"action":"send","actorId":"<自己编号>","agentKey":"PLACEHOLDER","recipientId":"<已注册对方编号>","title":"检查候选","content":"任务、边界、验收条件、证据路径","requestId":"<本次唯一ID>"}
```

发送前双方均须真实注册。create 建草稿；list/get 选择准确条目；edit 用 taskId 和刚读到的 expectedRevision 防并发覆盖；send 支持已有草稿或一步创建发送。重试沿用同一 requestId，新意图使用新 ID。冲突先重读，不盲目递增修订。

delete 仅设置可恢复桥列表墓碑；list includeDeleted=true 可查，restore 恢复。底层消息与执行记录保留。不支持底层撤回时明确失败，不将软删除称为撤回。已发送正文修改被拒绝；correct 明确发送新修订更正，不暗示旧消息被改写。refresh 查询可得真实状态；queue 接受不代表已读/完成。import 按明确 legacyTaskId/legacyDirection 导入旧桥记录，不伪造历史成功。

complete 必须提供实际 evidence，只是提交本修订完成报告，不是工具自己证明测试通过。双方检查证据后各自 confirm，verdict 为 accepted/rejected，拒绝给 reason。双方确认必须指向同一修订；单方完成、单方确认、旧修订确认不能提前闭环；close 不绕过前提。

双方确认后自动向对方发送一次闭环通知，含任务 ID、修订、事件 ID、replyRequired=false：“本任务已验收并完成双方确认，现已闭环，后续无需回复”。收到后停止本任务追问；禁止再次回执、确认或新建确认任务。重试沿用事件 ID。闭环不关闭聊天，不影响其他任务；新问题或高修订使用 reopen 并说明 reason，不静默丢弃。


## 身份能力密钥与安全边界

首次 register 创建身份时仅返回一次 agentKey。请在自己的会话、本机私有状态中保留该能力密钥；所有 bridge_task 操作（包括 list/get）都必须同时提供 actorId 与 agentKey。修改已注册身份的 alias 也必须提供正确密钥。示例中的 agentKey 字符串 PLACEHOLDER 必须替换为自己的真实密钥，不能直接执行占位值。

同 session 的后续查询或重复登记仅返回公开编号，不再次泄露密钥。丢失 agentKey 不能靠查询编号或重复登记取回；不要将对方 agentKey 用作路由参数。密钥不要发给对方、写入任务正文、审查材料、日志或 GitHub。编号是持久路由映射，不是可信宿主 session 认证；真实 sessionId 仍由调用者提供，登记前必须自行核对宿主当前会话。

本版本不发布 standalone 脚本，不依赖 Stop hook 自动上报。autoNotify 强制禁用；完成、确认与闭环通知由 lifecycle 负责。不要额外创建 Stop-hook 回执或自动确认流程。

## 全新会话的首次调用顺序

1. Codex agent 从宿主核对自己当前真实 thread ID，调用 bridge_agent register，side=codex、sessionId=该 ID；私下保留首次返回的 agentKey 和公开编号。
2. DeepSeek agent 在自己的真实当前 Harness 会话调用 bridge_agent register，side=deepseek、sessionId=该会话 ID；私下保留自己首次返回的 agentKey 和公开编号。不能由 Codex 猜一个 DeepSeek sessionId 代为登记。
3. 双方只交换/查询公开编号，核对 side 与会话映射后，使用自己的 actorId、自己的 agentKey 和对方 recipientId 发送。密钥不交给对方。
4. 接收方没有先登记时不能直接接收 v2 任务；遇到 agent/not-found，先检查该接收会话是否已自行登记，不把它直接判成安装损坏。新会话需重新登记，不能复用旧会话身份。

当前 DSH 投递封装上限是 **4000 字符，包含桥接生成的头信息**，可用正文空间小于 4000。长说明、diff 与证据应写入双方确实可访问的文件，在正文给简短摘要、准确路径与验收要求；不能假定对方能读取共享范围之外的本机路径。先确认对方访问权限，必要时使用经授权的共享位置。超限失败后缩短材料并按实际投递状态重试，不把失败报告成成功。

身份发现边界：bridge_agent list/get 是回环 token 保护下的公开只读名录，不要求 agentKey，仅返回编号、side、sessionId、alias 等路由信息，绝不返回密钥或哈希。所有 bridge_task 操作（包括任务 list/get）及修改身份别名均要求自己的 agentKey；名录可见不表示可冒充该编号。
更正重试：correct 必须提供 reason、requestId 和首次操作时的 expectedRevision。一次更正意图始终沿用同一 requestId；重复调用返回当前条目，不重复投递；同一 ID 对应不同正文会冲突。结果不确定先查事件，不能换 ID 盲重发。

更正投递的确定失败（definitive，明确未发送）会向调用方抛错；可用同一requestId安全重试，不会建立新修订事件。不确定结果（uncertain）禁止盲重发，应先核对任务事件与对方记录。

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
