[CmdletBinding()]
param([Parameter(Mandatory)][string]$OutputPath)
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$output=[IO.Path]::GetFullPath($OutputPath)
if(Test-Path -LiteralPath $output){throw '拒绝覆盖已有安装包；请指定新文件名。'}
Add-Type -AssemblyName System.IO.Compression
$stream=[IO.File]::Open($output,[IO.FileMode]::CreateNew)
try {
  $zip=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create,$false)
  try {
    foreach($file in Get-ChildItem -LiteralPath $root -File -Recurse -Force){
      $relative=[IO.Path]::GetRelativePath($root,$file.FullName).Replace('\','/')
      if($relative -match '(^|/)(work|node_modules|\.git|版本发布)(/|$)' -or $file.Name -in @('token','endpoint.json','audit.jsonl') -or $relative -match '\.(log|bak)$'){continue}
      $entry=$zip.CreateEntry($relative,[IO.Compression.CompressionLevel]::Optimal)
      $target=$entry.Open();$source=$file.OpenRead()
      try{$source.CopyTo($target)}finally{$source.Dispose();$target.Dispose()}
    }
  } finally {$zip.Dispose()}
} finally {$stream.Dispose()}
$read=[IO.Compression.ZipFile]::OpenRead($output)
try {
  if($read.Entries.Count -eq 0){throw '空安装包'}
  foreach($entry in $read.Entries){if($entry.FullName -match '(^|/)(work|node_modules|\.git)(/|$)' -or $entry.Name -in @('token','endpoint.json','audit.jsonl')){throw '安装包包含运行状态或私有数据'}}
  Write-Output "entries=$($read.Entries.Count)"
}finally{$read.Dispose()}
Get-FileHash -LiteralPath $output -Algorithm SHA256
