# 安装、升级、卸载与回滚

要求 Node.js 22+、PowerShell 7+、Git、Codex CLI 和 DeepSeek Harness。Windows PowerShell 5.1（系统自带 `powershell.exe`）不兼容安装器；必须安装 PowerShell 7 并通过 `pwsh` 执行 `scripts/install.ps1`。脚本在任何文件操作前检查版本并拒绝 5.1。保存所有工作并暂停或退出相关宿主；安装器不会强杀进程。

```powershell
git clone https://github.com/bai-po/codex-deepseek-agent-bridge.git
Set-Location codex-deepseek-agent-bridge
git checkout v1.0.4
node --version
pwsh --version
codex plugin --help
codex plugin marketplace add --help
codex plugin add --help
npm test
npm run verify
pwsh -NoProfile -File ./scripts/install.ps1 -Target Both -DryRun
# 保存并暂停/退出宿主后：
pwsh -NoProfile -File ./scripts/install.ps1 -Target Both -HostStopped
```

若标签未发布，固定发布页给出的完整提交 SHA，不把未验证 main 当作验收版本。可以使用 `-Target Codex` 或 `DeepSeek` 单端安装。`-InstallRoot` 指定持久版本目录，默认从平台 Documents（MyDocuments）发现。DeepSeek 默认从 UserProfile 下 `.dsh/profiles/desktop` 发现 profile；非默认 profile 显式传 `-DeepSeekProfile <目录>`。`-CodexCommand <CLI路径>` 可选择 CLI。

Codex 安装使用版本副本的 `.agents/plugins/marketplace.json`，通过公开 `codex plugin marketplace` 与 `codex plugin add` 命令注册、安装并核对插件版本。若 Codex 已登记同名 marketplace，脚本先确认原路径存在且其 marketplace 清单和插件清单都指向 Agent Bridge，再备份配置、移除旧来源并注册新版本；验证失败时恢复旧来源和插件。无法确认旧来源时保留现有配置并停止。旧版本目录始终保留。脚本先探测 CLI 对 JSON 输出的支持，不手工改写 Codex 配置；失败不得称安装完成。

DeepSeek profile 修改 dependencies 的 dsh-agent-bridge link 与 dsh.profile.bundles；保留其他依赖、bundle、用户字段。实际变更前在 profile 旁保存 UTC 时间命名备份，JSON 使用 UTF-8 无 BOM。Windows 下同时更新 profile/node_modules/dsh-agent-bridge 的真实 Junction：先验证原路径确为同名包，将旧 Junction 或实体目录改名为唯一时间戳备份，再建立指向新版本 deepseek 的 Junction，并读取实际包版本核对。重试同一目标不重复备份。遇到非预期包、普通文件、无包清单目录或损坏链接明确拒绝，不递归删除。Junction 创建失败时尽力恢复旧名称并报错；失败后应检查终端给出的备份路径，不声称安装成功。

版本目录不可覆盖：重复执行核对源文件，不一致则拒绝。升级创建新版本目录，保留旧版和设置。脚本不处理聊天数据库或上传。

## 重启后的无害检查与真实验收

先确认两端实际加载版本。DeepSeek 发现 bridge_agent、bridge_task、bridge_status；Codex 发现 bridge_agent、bridge_task、bridge_manual。调用只读 health/status，确认回环发现和认证；自定义状态目录遵循宿主配置与 DSH_AGENT_BRIDGE_HOME，不复制别人的 token。

两端从宿主取得当前真实会话 ID 后登记，list/get 核对映射。经用户授权后向明确会话发带唯一标记的无害任务，确认真实收到并回传，反向也测一次。保存任务 ID、修订、实际接收会话和结果证据。再测列表编辑、删除恢复、已发送编辑拒绝、更正、双方确认闭环且通知不回信；固定 ACK 或入队成功不能替代验收。

## 卸载、回滚

保存并暂停宿主。Codex 先执行 `codex plugin remove --help` 和 `codex plugin marketplace remove --help`，按实际 CLI 支持的选择器卸载。只有不被其他插件使用时才移除 marketplace，不删除整个用户配置。

DeepSeek 用公开插件管理器停用/移除 dsh-agent-bridge，或恢复本次生成的 profile 备份。恢复整个 profile 前比较后续其他插件变更，必要时只还原本插件 dependency 和 bundle。回滚需同时还原 manifest link 和 node_modules 实际入口。先核对当前 Junction 目标，保存其名称，再把安装日志中的 dsh-agent-bridge.backup-... 备份改回 dsh-agent-bridge；不要递归删除链接目标。重启后读取实际 node_modules 包版本并核对宿主加载版本。保留状态目录以保留编号、任务和审计；不删除聊天。确认无人引用后才能清理指定旧副本。

以上可交给 agent 执行：提供真实路径、检查退出码、记录备份与实际测试；未经授权不进行真实互发、上传或删除历史。


默认安装根为当前用户的Documents/AgentBridge。可用 -InstallRoot 指定双方宿主均能访问的绝对目录。Windows商店版进程可能将AppData路径映射到其LocalCache；若两端实际加载路径不同，应使用明确的共享磁盘目录，保留旧版后重装并核对health。
