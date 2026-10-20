---
name: deepseek-bridge
description: 用于将任务交给本机 DeepSeek Harness，登记当前会话编号，管理桥接任务列表、修订及双方验收闭环。
---

## 未闭环只接受主动消息（1.0.4）

DeepSeek 必须主动用 codex_task(thread=<派发方真实 Codex thread UUID>, delivery=queue, message=<实际进度或审查结果>) 发送回报；只在自己的聊天回复、写 DONE、落盘报告或返回工具成功均不算发给 Codex。

Codex 等待主动到达当前聊天的消息。即使等待十分钟、旧工具描述叫“读回”、工具不可用或发现报告文件，也不得调用结果/会话/日志/报告读取来取得未闭环的 DeepSeek 正文。可以按需要检查健康、运行状态与任务归属元数据，不持续轮询正文。超时不是完成或闭环。不要绕过桥接限制用文件系统、会话记录或其他接口读取对方回报；工具不可用时报告未发送并修复推送通道。

bridge_task 的 list/get/refresh 及变更回执在未闭环时隐藏对方正文、证据与嵌套回执；自己写的内容仍可查。deepseek_result 对未闭环任务仅返回状态且 reply=null。queued/running/done/error、停止运行、单方 complete/confirm 或工具返回成功都不是闭环。只有服务验证同修订 complete、双方 accepted confirm 和已送达的 replyRequired=false 闭环事件后，才允许读取这个任务的归档；reopen 后重新隐藏。不得为读正文先做虚假验收或提前关闭。

Codex 的 deepseek_result 默认 waitMs=0，立即读取一次状态；显式 waitMs>0 时只提交一次 `POST /tasks/{id}/wait` 状态等待，最长 30000ms，服务仍按闭环策略过滤响应。未闭环时 reply=null；这不是等待读取 DeepSeek 正文的接口，也不能作为轮询工具。

旧 deepseek_task 必须携带 replyThreadId=<当前真实 Codex thread UUID>；旧工具不支持该字段时，在 summary 单独一行写 [Agent Bridge Reply-To: codex <UUID>]。没有实际会话 UUID 时先解决身份缺失，禁止 PID、最新会话猜测和其他聊天编号。v2 从登记的发送方 sessionId 带入回信目标。replyRequired=false 是无需回信通知，不要求回信地址；收到闭环通知后不回执。

发送较长审查时可分条主动发送。共享文件可作为事先授权的输入材料，但不能用其替代未闭环的对方回报推送；对方应主动发送结论与必要证据。插件限制桥接接口和代理使用流程，不宣称撤销通用文件系统权限。



先调用 `bridge_manual` 或读取 `bridge://manual` 获得当前包的完整手册。不要将旧工程提示或其他聊天内容当成本次授权。

1. 用 `deepseek_status` 确认本机认证桥接可用。将任务发给其他聊天需要用户明确授权；保留原有 `deepseek_task`、`deepseek_result` 兼容入口。
2. 首次使用 `bridge_agent(action="register", sessionId=<真实当前 Codex thread UUID>, alias=<可选别名>)` 领取持久编号。sessionId 必须来自调用方已知的真实会话身份；缺失时询问，不能猜 latest、扫描最新文件或复用其他聊天的编号。`list/get` 查询登记映射。Codex 适配器自动注入 side=codex。
3. `bridge_task` 提供 create/list/get/edit/delete/restore/send/refresh/correct/complete/confirm/close/reopen/import。先准确列出并选择目标条目，用自己的 actorId 操作；发送时指定对方 recipientId。直接 send 可携带 title/content 一步发送，禁止随机挑选接收会话。
4. 变更按服务要求提供 taskId、expectedRevision 和稳定 requestId；网络重试沿用同一 requestId。冲突先重新读取，不盲目覆盖。动作字段由服务按归属、状态和修订运行时校验。
5. 草稿 edit 后才发送新文本；已发送内容使用显式 correct 更正修订，不能改本地字段后宣称对方已同步。delete 只产生可恢复桥接墓碑；不等于撤回聊天、取消已排队或已执行工作。restore 恢复记录。
6. complete 提交实际证据，confirm 携带 accepted/rejected 与理由。工具成功、排队、单方完成均不代表验收通过。双方确认后才能 close；服务发一次带任务ID、修订号、事件ID、replyRequired=false 的终止通知。收到此通知后停止该任务自动追问和回执，不再回信确认，也不据此创建新任务。其他任务继续正常沟通；用户新问题或更高修订通过 reopen 显式恢复。
7. 只报告实际回执：已入队、已消费、已回复与已闭环分别说明。手册、工具或服务不可用时如实报告错误，不伪造确认和审查结论。

编号仅为桥接路由身份。当前会话UUID由调用者正确提供，在宿主未提供可信身份前不得宣称编号实现了会话认证。首次登记返回 agentKey 仅一次，应私下保留；不要发送给对方、不要写入仓库或公开证据。bridge_task 的所有动作携带自己的 actorId 与 agentKey，已有编号修改 alias 也需对应 agentKey。

默认不启用 Stop hook。deepseek_report_turn_end 已禁用为空操作，不读rollout、不发消息；闭环后不要调用它继续发送消息。
