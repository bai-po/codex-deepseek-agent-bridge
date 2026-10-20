[CmdletBinding()]
param(
  [ValidateSet('Codex','DeepSeek','Both')][string]$Target = 'Both',
  [switch]$DryRun,
  [string]$InstallRoot,
  [string]$DeepSeekProfile,
  [string]$CodexCommand = 'codex',
  [switch]$HostStopped
)
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7+ is required; run this installer with pwsh. Windows PowerShell 5.1 is not supported.' }
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path $PSScriptRoot -Parent
$version = (Get-Content -LiteralPath (Join-Path $sourceRoot 'package.json') -Raw | ConvertFrom-Json).version
if (!$InstallRoot) { $InstallRoot = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'AgentBridge' }
if (!$DeepSeekProfile) { $DeepSeekProfile = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh/profiles/desktop' }
$destination = [IO.Path]::GetFullPath((Join-Path $InstallRoot $version))
$profileManifest = Join-Path $DeepSeekProfile 'package.json'
$codexSelected = $Target -in @('Codex','Both')
$deepseekSelected = $Target -in @('DeepSeek','Both')
if ($deepseekSelected -and !(Test-Path -LiteralPath $profileManifest)) { throw "找不到 DeepSeek profile：$profileManifest；请用 -DeepSeekProfile 指定真实 profile。" }
$packageLink = [IO.Path]::GetFullPath((Join-Path $DeepSeekProfile 'node_modules/dsh-agent-bridge'))
$packageTarget = Join-Path $destination 'deepseek'
if ($deepseekSelected) {
  if (!$IsWindows) { throw 'DeepSeek 本地 Junction 安装目前仅支持 Windows。' }
  $sourcePackage = Get-Content -LiteralPath (Join-Path $sourceRoot 'deepseek/package.json') -Raw | ConvertFrom-Json
  if ($sourcePackage.name -ne 'dsh-agent-bridge' -or $sourcePackage.version -ne $version) { throw 'DeepSeek 包名或版本不匹配。' }
  $existingLink = Get-Item -LiteralPath $packageLink -Force -ErrorAction SilentlyContinue
  if ($existingLink) {
    $existingManifest = Join-Path $packageLink 'package.json'
    if (!$existingLink.PSIsContainer -or !(Test-Path -LiteralPath $existingManifest)) { throw "拒绝移动非预期包路径：$packageLink" }
    $existingPackage = Get-Content -LiteralPath $existingManifest -Raw | ConvertFrom-Json
    if ($existingPackage.name -ne 'dsh-agent-bridge') { throw "拒绝移动其他包：$packageLink" }
  }
}
$marketplaceManifest = Join-Path $sourceRoot '.agents/plugins/marketplace.json'
if ($codexSelected -and !(Test-Path -LiteralPath $marketplaceManifest)) { throw "缺少本地 marketplace 清单：$marketplaceManifest" }
if ($codexSelected) {
  & $CodexCommand plugin marketplace add --help | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Codex CLI 不支持 marketplace add；请升级或使用公开插件管理入口。' }
  & $CodexCommand plugin add --help | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Codex CLI 不支持 plugin add。' }
}
$plan = [ordered]@{ target=$Target; version=$version; destination=$destination; profile=$profileManifest; dryRun=[bool]$DryRun; backup='写入前保存 profile；版本目录存在则逐文件核对，不覆盖'; codex='通过 codex plugin marketplace add / plugin add 注册版本副本' }
$plan | ConvertTo-Json
if ($DryRun) { return }
if (!$HostStopped) { throw '请先保存工作并暂停/退出相关宿主，再传 -HostStopped；脚本不会终止进程。' }
# An existing version is immutable: reject changed files rather than overwrite it.
if (Test-Path -LiteralPath $destination) {
  foreach ($file in Get-ChildItem -LiteralPath $sourceRoot -Recurse -File -Force) {
    $relative = [IO.Path]::GetRelativePath($sourceRoot,$file.FullName)
    if ($relative -match '^(node_modules|work|\.git)[\\/]') { continue }
    $installedFile = Join-Path $destination $relative
    if (!(Test-Path -LiteralPath $installedFile) -or (Get-FileHash -LiteralPath $file.FullName).Hash -ne (Get-FileHash -LiteralPath $installedFile).Hash) { throw "版本副本内容不一致：$relative；请使用新版本目录。" }
  }
} else {
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  Get-ChildItem -LiteralPath $sourceRoot -Force | Where-Object { $_.Name -notin @('.git','node_modules','work') } | Copy-Item -Destination $destination -Recurse -Force
}
if ($deepseekSelected) {
  # Only the validated, exact package path is renamed; old directories and links remain recoverable.
  $existingLink = Get-Item -LiteralPath $packageLink -Force -ErrorAction SilentlyContinue
  $sameTarget = $existingLink -and $existingLink.LinkType -eq 'Junction' -and [IO.Path]::GetFullPath($existingLink.Target).TrimEnd('\') -eq [IO.Path]::GetFullPath($packageTarget).TrimEnd('\')
  if (!$sameTarget) {
    $linkBackup = $null
    if ($existingLink) {
      $linkBackup = "$packageLink.backup-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffffffZ'))-$([Guid]::NewGuid().ToString('N'))"
      if ([IO.Path]::GetDirectoryName($linkBackup) -ne [IO.Path]::GetDirectoryName($packageLink)) { throw '备份路径越界。' }
      Move-Item -LiteralPath $packageLink -Destination $linkBackup
      Write-Output "DeepSeek 实际包备份：$linkBackup"
    }
    try {
      New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($packageLink)) -Force | Out-Null
      New-Item -ItemType Junction -Path $packageLink -Target $packageTarget | Out-Null
    } catch {
      if ($linkBackup -and !(Get-Item -LiteralPath $packageLink -Force -ErrorAction SilentlyContinue)) { Move-Item -LiteralPath $linkBackup -Destination $packageLink }
      throw
    }
  }
  $loadedPackage = Get-Content -LiteralPath (Join-Path $packageLink 'package.json') -Raw | ConvertFrom-Json
  if ($loadedPackage.name -ne 'dsh-agent-bridge' -or $loadedPackage.version -ne $version) { throw '实际 node_modules 包版本核对失败。' }
  $profile = Get-Content -LiteralPath $profileManifest -Raw | ConvertFrom-Json -AsHashtable
  if (!$profile.dependencies) { $profile.dependencies = @{} }
  if (!$profile.dsh) { $profile.dsh = @{} }
  if (!$profile.dsh.profile) { $profile.dsh.profile = @{} }
  $bundles = @($profile.dsh.profile.bundles)
  $link = 'link:' + ((Join-Path $destination 'deepseek') -replace '\\','/')
  if ($profile.dependencies['dsh-agent-bridge'] -ne $link -or 'dsh-agent-bridge' -notin $bundles) {
    $backup = "$profileManifest.agent-bridge-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffffffZ')).bak"
    Copy-Item -LiteralPath $profileManifest -Destination $backup
    $profile.dependencies['dsh-agent-bridge'] = $link
    if ('dsh-agent-bridge' -notin $bundles) { $bundles += 'dsh-agent-bridge' }
    $profile.dsh.profile.bundles = $bundles
    $temporary = "$profileManifest.agent-bridge.tmp"
    [IO.File]::WriteAllText($temporary, ($profile | ConvertTo-Json -Depth 100), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $profileManifest -Force
    Write-Output "DeepSeek profile 备份：$backup"
  }
}
if ($codexSelected) {
  $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex' }
  $codexConfig = Join-Path $codexHome 'config.toml'
  if (Test-Path -LiteralPath $codexConfig) {
    $codexBackup = "$codexConfig.agent-bridge-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffffffZ')).bak"
    Copy-Item -LiteralPath $codexConfig -Destination $codexBackup
    Write-Output "Codex 配置备份：$codexBackup"
  }
  $marketplace = Get-Content -LiteralPath (Join-Path $destination '.agents/plugins/marketplace.json') -Raw | ConvertFrom-Json
  $plugin = Get-Content -LiteralPath (Join-Path $destination 'codex/.codex-plugin/plugin.json') -Raw | ConvertFrom-Json
  & $CodexCommand plugin marketplace add $destination
  if ($LASTEXITCODE -ne 0) { throw 'Codex marketplace 注册失败；保留版本副本以供检查。' }
  & $CodexCommand plugin add "$($plugin.name)@$($marketplace.name)"
  if ($LASTEXITCODE -ne 0) { throw 'Codex 插件安装失败；请根据 CLI 输出恢复，不能视为安装完成。' }
}
Write-Output '文件安装完成。重启宿主后按 docs/INSTALL.md 做工具发现、health 和真实互发验收。'
