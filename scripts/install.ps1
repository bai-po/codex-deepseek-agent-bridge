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
  $marketplaceListHelp = & $CodexCommand plugin marketplace list --help 2>&1
  if ($LASTEXITCODE -ne 0 -or (@($marketplaceListHelp) -join [Environment]::NewLine) -notmatch '--json') { throw 'Codex CLI 需要支持 plugin marketplace list --json；请升级 Codex CLI。' }
  $marketplaceRemoveHelp = & $CodexCommand plugin marketplace remove --help 2>&1
  if ($LASTEXITCODE -ne 0 -or (@($marketplaceRemoveHelp) -join [Environment]::NewLine) -notmatch '--json') { throw 'Codex CLI 需要支持 plugin marketplace remove --json；请升级 Codex CLI。' }
  $marketplaceAddHelp = & $CodexCommand plugin marketplace add --help 2>&1
  if ($LASTEXITCODE -ne 0 -or (@($marketplaceAddHelp) -join [Environment]::NewLine) -notmatch '--json') { throw 'Codex CLI 需要支持 plugin marketplace add --json；请升级 Codex CLI。' }
  $pluginAddHelp = & $CodexCommand plugin add --help 2>&1
  if ($LASTEXITCODE -ne 0 -or (@($pluginAddHelp) -join [Environment]::NewLine) -notmatch '--json') { throw 'Codex CLI 需要支持 plugin add --json；请升级 Codex CLI。' }
}
$plan = [ordered]@{ target=$Target; version=$version; destination=$destination; profile=$profileManifest; dryRun=[bool]$DryRun; backup='写入前保存 profile；版本目录存在则逐文件核对，不覆盖'; codex='通过 Codex CLI 注册并安装版本副本；遇到同名旧本地 marketplace 时先核验来源，再备份配置、切换并验证版本，失败时恢复旧来源' }
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

  function Invoke-CodexCli([string[]]$CommandArgs) {
    try {
      $output = & $CodexCommand @CommandArgs 2>&1
      $exitCode = $LASTEXITCODE
    } catch {
      return [PSCustomObject]@{ exitCode=127; text=$_.Exception.Message }
    }
    return [PSCustomObject]@{ exitCode=$exitCode; text=(@($output) -join [Environment]::NewLine) }
  }
  function Read-CodexJson($result, [string]$action) {
    if ($result.exitCode -ne 0) { throw "Codex $action 失败：$($result.text)" }
    try { return ($result.text | ConvertFrom-Json) }
    catch { throw "Codex $action 未返回有效 JSON：$($result.text)" }
  }
  function Get-CodexMarketplaces {
    $result = Invoke-CodexCli @('plugin','marketplace','list','--json')
    return Read-CodexJson $result 'marketplace list'
  }
  function Get-CodexPluginManifest([string]$rootPath, [string]$pluginName) {
    $manifestPath = Join-Path $rootPath 'codex/.codex-plugin/plugin.json'
    if (!(Test-Path -LiteralPath $manifestPath)) { $manifestPath = Join-Path $rootPath 'codex/plugin.json' }
    if (!(Test-Path -LiteralPath $manifestPath)) { throw "无法确认旧 marketplace 的插件清单：$manifestPath" }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.name -ne $pluginName) { throw "旧 marketplace 插件不匹配：$($manifest.name)" }
    return $manifest
  }
  function Assert-AgentBridgeMarketplace([string]$rootPath, [string]$marketplaceName, [string]$pluginName) {
    $manifestPath = Join-Path $rootPath '.agents/plugins/marketplace.json'
    if (!(Test-Path -LiteralPath $manifestPath)) { throw "旧 marketplace 清单不存在：$manifestPath" }
    $oldMarketplace = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($oldMarketplace.name -ne $marketplaceName) { throw "旧 marketplace 名称不匹配：$($oldMarketplace.name)" }
    $entries = @($oldMarketplace.plugins | Where-Object { $_.name -eq $pluginName })
    if ($entries.Count -ne 1 -or !$entries[0].source.path) { throw "旧 marketplace 未唯一登记插件 $pluginName；保留现有配置。" }
    $oldPluginRoot = Join-Path $rootPath ([string]$entries[0].source.path)
    $manifestPath = Join-Path $oldPluginRoot '.codex-plugin/plugin.json'
    if (!(Test-Path -LiteralPath $manifestPath)) { $manifestPath = Join-Path $oldPluginRoot 'plugin.json' }
    if (!(Test-Path -LiteralPath $manifestPath)) { throw "旧插件清单不存在：$manifestPath" }
    $oldPlugin = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($oldPlugin.name -ne $pluginName) { throw "旧 marketplace 指向了不同插件：$($oldPlugin.name)" }
    return $oldPlugin
  }
  function Get-FullPathKey([string]$value) {
    return [IO.Path]::GetFullPath($value).TrimEnd([char[]]@([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar))
  }

  $selector = "$($plugin.name)@$($marketplace.name)"
  $marketplaceState = Get-CodexMarketplaces
  $existing = @($marketplaceState.marketplaces | Where-Object { $_.name -eq $marketplace.name })
  if ($existing.Count -gt 1) { throw "Codex 中有多个同名 marketplace $($marketplace.name)；保留现有配置，未切换。" }
  $previousRoot = $null
  $previousPlugin = $null
  $previousWasRemoved = $false
  $newWasAdded = $false
  if ($existing.Count -eq 1) {
    $previousRoot = [string]$existing[0].root
    if ((Get-FullPathKey $previousRoot) -ne (Get-FullPathKey $destination)) {
      if (!(Test-Path -LiteralPath $previousRoot)) { throw "Codex 已登记的 marketplace 路径不存在；保留配置：$previousRoot" }
      $previousPlugin = Assert-AgentBridgeMarketplace $previousRoot $marketplace.name $plugin.name
      $remove = Invoke-CodexCli @('plugin','marketplace','remove',$marketplace.name,'--json')
      if ($remove.exitCode -ne 0) { throw "Codex 旧 marketplace 移除失败；保留原配置：$($remove.text)" }
      $previousWasRemoved = $true
    }
  }

  try {
    if ($existing.Count -eq 0 -or $previousWasRemoved) {
      $add = Invoke-CodexCli @('plugin','marketplace','add',$destination,'--json')
      if ($add.exitCode -ne 0) { throw "Codex 新 marketplace 注册失败：$($add.text)" }
      $newWasAdded = $true
      $added = Read-CodexJson $add 'marketplace add'
      if ($added.marketplaceName -ne $marketplace.name -or (Get-FullPathKey ([string]$added.installedRoot)) -ne (Get-FullPathKey $destination)) {
        throw 'Codex 注册到的 marketplace 名称或根目录与候选版本不符。'
      }
    }
    $install = Invoke-CodexCli @('plugin','add',$selector,'--json')
    if ($install.exitCode -ne 0) { throw "Codex 插件安装失败：$($install.text)" }
    $installedPlugin = Read-CodexJson $install 'plugin add'
    if ($installedPlugin.name -ne $plugin.name -or $installedPlugin.version -ne $version -or $installedPlugin.marketplaceName -ne $marketplace.name) {
      throw 'Codex CLI 安装结果与目标插件版本不符。'
    }
  } catch {
    $installFailure = $_.Exception.Message
    if ($previousWasRemoved) {
      $rollbackErrors = @()
      if ($newWasAdded) {
        $removeNew = Invoke-CodexCli @('plugin','marketplace','remove',$marketplace.name,'--json')
        if ($removeNew.exitCode -ne 0) { $rollbackErrors += "移除新 marketplace 失败：$($removeNew.text)" }
      }
      if ($rollbackErrors.Count -eq 0) {
        $restore = Invoke-CodexCli @('plugin','marketplace','add',$previousRoot,'--json')
        if ($restore.exitCode -ne 0) { $rollbackErrors += "恢复旧 marketplace 失败：$($restore.text)" }
        else {
          $restorePlugin = Invoke-CodexCli @('plugin','add',"$($plugin.name)@$($marketplace.name)",'--json')
          if ($restorePlugin.exitCode -ne 0) { $rollbackErrors += "恢复旧插件失败：$($restorePlugin.text)" }
          else {
            try {
              $restored = Read-CodexJson $restorePlugin 'rollback plugin add'
              if ($restored.name -ne $plugin.name -or $restored.version -ne $previousPlugin.version) { $rollbackErrors += '恢复后的插件版本与旧版本不符。' }
            } catch { $rollbackErrors += $_.Exception.Message }
          }
        }
      }
      if ($rollbackErrors.Count -gt 0) { throw "Codex 新版注册失败且自动回滚不完整：$installFailure；$($rollbackErrors -join '；')。配置备份：$codexBackup" }
      throw "Codex 新版注册失败，旧 marketplace 与插件已恢复：$installFailure"
    }
    throw "Codex 插件注册失败：$installFailure"
  }
  if ($previousWasRemoved) { Write-Output "Codex marketplace 已从旧目录切换到 $destination；旧版本文件保留：$previousRoot" }
  Write-Output "Codex 插件已安装：$selector（$version）"
}
Write-Output '文件安装完成。重启宿主后按 docs/INSTALL.md 做工具发现、health 和真实互发验收。'
