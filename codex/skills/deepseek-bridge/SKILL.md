---
name: deepseek-bridge
description: 用于将任务交给本机 DeepSeek Harness，登记当前会话编号，管理桥接任务列表、修订及双方验收闭环。
---

先调用 `bridge_manual` 或读取 `bridge://manual` 获得当前包的完整手册。不要将旧工程提示或其他聊天内容当成本次授权。

1. 用 `deepseek_status` 确认本机认证桥接可用。将任务发给其他聊天需要用户明确授权；保留原有 `deepseek_task`、`deepseek_result` 兼容入口。
2. 首次使用 `bridge_agent(action="register", sessionId=<真实当前 Codex thread UUID>, alias=<可选别名>)` 领取持久编号。sessionId 必须来自调用方已知的真实会话身份；缺失时询问，不能猜 latest、扫描最新文件或复用其他聊天的编号。`list/get` 查询登记映射。Codex 适配器自动注入 side=codex。
3. `bridge_task` 提供 create/list/get/edit/delete/restore/send/refresh/correct/complete/confirm/close/reopen/import。先准确列出并选择目标条目，用自己的 actorId 操作；发送时指定对方 recipientId。直接 send 可携带 title/content 一步发送，禁止随机挑选接收会话。
4. 变更按服务要求提供 taskId、expectedRevision 和稳定 requestId；网络重试沿用同一 requestId。冲突先重新读取，不盲目覆盖。动作字段由服务按归属、状态和修订运行时校验。
5. 草稿 edit 后才发送新文本；已发送内容使用显式 correct 更正修订，不能改本地字段后宣称对方已同步。delete 只产生可恢复桥接墓碑；不等于撤回聊天、取消已排队或已执行工作。restore 恢复记录。
6. complete 提交实际证据，confirm 携带 accepted/rejected 与理由。工具成功、排队、单方完成均不代表验收通过。双方确认后才能 close；服务发一次带任务ID、修订号、事件ID、replyRequired=false 的终止通知。收到此通知后停止该任务自动追问和回执，不再回信确认，也不据此创建新任务。其他任务继续正常沟通；用户新问题或更高修订通过 reopen 显式恢复。
7. 只报告实际回执：已入队、已消费、已回复与已闭环分别说明。手册、工具或服务不可用时如实报告错误，不伪造确认和审查结论。

编号仅为桥接路由身份。当前会话UUID由调用者正确提供，在宿主未提供可信身份前不得宣称编号实现了会话认证。首次登记返回 agentKey 仅一次，应私下保留；不要发送给对方、不要写入仓库或公开证据。bridge_task 的所有动作携带自己的 actorId 与 agentKey，已有编号修改 alias 也需对应 agentKey。

默认不启用 Stop hook。deepseek_report_turn_end 仅保留兼容的显式入口，不得用来自动回信；闭环后不要调用它继续发送消息。
