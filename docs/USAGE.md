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
