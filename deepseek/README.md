# Agent Bridge — DeepSeek版

此目录是独立双端仓库的 DeepSeek Harness 插件，版本 1.0.4。

- [安装、升级、卸载与回滚](../docs/INSTALL.md)
- [本端 agent 使用手册](MANUAL.md)
- [任务协议与示例](../docs/USAGE.md)
- [Codex版](../codex/)

在真实桌面宿主内挂认证回环 HTTP 服务，注册 bridge_agent、bridge_task、bridge_manual，以及兼容工具 codex_task、codex_result、codex_threads、bridge_status。使用工具前先读手册，准确登记当前会话并保管一次性能力密钥。

任务支持列表、编辑、可恢复删除、直接发送、更正与双方确认闭环。删除桥接条目不会撤回宿主消息。队列接受不证明聊天已消费。闭环通知只发一次并明确不要求回信，不使用 Stop hook 或自动 turn-end 通知。

状态默认保存在当前用户 .dsh/agent-bridge；卸载保留状态以便恢复编号和历史，不要删除整个状态目录。通过配置 stateDir 可更改位置。其他配置包括 prefix、workspaceRoot、codexBin、maxWaitMs、taskTimeoutMs；autoNotify 强制禁用。

插件图标使用用户确认形象的透明 PNG 导出版。宿主支持 PNG，导出文件需不超过 256 KiB；源码附静态检查。安装和验收范围以仓库文档与实际日志为准。
