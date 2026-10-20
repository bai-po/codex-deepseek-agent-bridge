# 测试范围与限制

在仓库根目录统一运行 `npm test`；Node 24 下不要用 `node --test tests/` 把目录当作测试文件，npm 脚本会展开 `tests/*.test.mjs`。Windows 安装器集成用例需要 PowerShell 7（`pwsh`）和 Windows Junction；缺少 `pwsh` 时仅这些用例会标记为 skip 并打印原因，其余 Node 测试照常运行。Windows PowerShell 5.1 不兼容 `scripts/install.ps1`；直接调用会在文件操作前明确拒绝。安装器测试使用任务内临时夹具，不操作真实 profile。`npm run verify` 仅验证文件存在和版本，不能证明宿主加载或消息已送达。

若要验证当前 DeepSeek 宿主的工具 schema，将 `DSH_TOOLS_PACKAGE_DIR` 指向宿主实际加载的 `@deepseek-ai/dsh-tools` 包目录后再运行 `npm test`。例如 PowerShell：`$env:DSH_TOOLS_PACKAGE_DIR='C:\path\to\dsh-tools'; npm test`。该用例会调用包内真实的 JSON Schema 断言函数并核对七个工具；未设置变量时仅这条宿主兼容用例会 skip，不能据此声称已验证目标宿主版本。

发布验收分别记录共享生命周期、HTTP/MCP、安装器备份/保留字段/无BOM/幂等/dry-run、最终ZIP哈希、实际加载版本、真实互发与闭环。DeepSeek 审查必须有实际回复；未回复标记待审查。

覆盖草稿增改发、准确选择已有列表条目、直接发送、删除恢复、已发送编辑拒绝、更正、缺目标/错误编号、修订冲突、重试/重启、单方不闭环、双方同修订只通知一次、通知不回信、其他任务和重开、旧数据保护。队列未提供的消费/回复信息不可猜测；Windows UI、多版本、性能只有存在证据时才称通过。
