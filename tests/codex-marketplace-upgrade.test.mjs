import test from 'node:test';
import assert from 'node:assert/strict';
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const scratch=path.join(root,'work','codex-marketplace-upgrade');
await mkdir(scratch,{recursive:true});
const pwsh=process.platform==='win32'?spawnSync('pwsh',['-NoProfile','-Command','$PSVersionTable.PSVersion.Major'],{encoding:'utf8'}):null;
const major=Number.parseInt(pwsh?.stdout?.trim()??'',10);
const skip=process.platform!=='win32'||pwsh?.status!==0||major<7
  ?'Codex marketplace installer integration requires Windows and PowerShell 7.'
  :undefined;
const options=skip?{skip}:{};

async function fixture(t,{failNewRoot=false}={}){
  const dir=await mkdtemp(path.join(scratch,'case-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=path.join(dir,'source');
  const install=path.join(dir,'installed');
  const old=path.join(dir,'old-marketplace');
  const codexHome=path.join(dir,'codex-home');
  const statePath=path.join(dir,'codex-state.json');
  const mockCli=path.join(dir,'codex-mock.ps1');
  const version=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
  await mkdir(path.join(source,'scripts'),{recursive:true});
  await mkdir(path.join(source,'deepseek'),{recursive:true});
  await mkdir(path.join(source,'codex','.codex-plugin'),{recursive:true});
  await mkdir(path.join(source,'.agents','plugins'),{recursive:true});
  await mkdir(path.join(old,'codex','.codex-plugin'),{recursive:true});
  await mkdir(path.join(old,'.agents','plugins'),{recursive:true});
  await mkdir(codexHome,{recursive:true});
  await cp(path.join(root,'scripts','install.ps1'),path.join(source,'scripts','install.ps1'));
  await writeFile(path.join(source,'package.json'),JSON.stringify({version}));
  await writeFile(path.join(source,'deepseek','package.json'),JSON.stringify({name:'dsh-agent-bridge',version}));
  const marketplace={name:'agent-bridge',plugins:[{name:'deepseek-bridge',source:{path:'./codex',source:'local'}}]};
  await writeFile(path.join(source,'.agents','plugins','marketplace.json'),JSON.stringify(marketplace));
  await writeFile(path.join(source,'codex','plugin.json'),JSON.stringify({name:'deepseek-bridge',version,mcpServers:'./mcp.json'}));
  await writeFile(path.join(source,'codex','.codex-plugin','plugin.json'),JSON.stringify({name:'deepseek-bridge',version}));
  await writeFile(path.join(source,'codex','mcp.json'),JSON.stringify({mcpServers:{deepseek_bridge:{command:'node',args:['${PLUGIN_ROOT}/server.mjs']}}}));
  await writeFile(path.join(source,'codex','server.mjs'),'');
  await writeFile(path.join(old,'.agents','plugins','marketplace.json'),JSON.stringify(marketplace));
  await writeFile(path.join(old,'codex','plugin.json'),JSON.stringify({name:'deepseek-bridge',version:'1.0.3-local.3',mcpServers:'./mcp.json'}));
  await writeFile(path.join(old,'codex','.codex-plugin','plugin.json'),JSON.stringify({name:'deepseek-bridge',version:'1.0.3-local.3'}));
  await writeFile(path.join(codexHome,'config.toml'),'# isolated plugin installer test\n');
  await writeFile(statePath,JSON.stringify({
    marketplace:{name:'agent-bridge',root:old},
    pluginVersion:'1.0.3-local.3',
    pluginEnabled:true,
    failNewRoot:failNewRoot?path.join(install,version):null,
    calls:[],
  }));
  await writeFile(mockCli,`$ErrorActionPreference='Stop'
$statePath=$env:CODEX_MOCK_STATE
$state=Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json -AsHashtable
$argv=@($args | ForEach-Object { [string]$_ })
$state.calls += ,($argv -join ' ')
function Save-State { [IO.File]::WriteAllText($statePath,($state | ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false)) }
if ($argv[-1] -eq '--help' -and $argv[0] -eq 'plugin') { Save-State; Write-Output '--json supported'; exit 0 }
if ($argv.Count -ge 3 -and $argv[0] -eq 'plugin' -and $argv[1] -eq 'marketplace' -and $argv[2] -eq 'list') {
  Save-State
  $items=@(); if($state.marketplace){$items+=@{name=$state.marketplace.name;root=$state.marketplace.root}}
  @{marketplaces=$items} | ConvertTo-Json -Compress -Depth 10
  exit 0
}
if ($argv.Count -ge 4 -and $argv[0] -eq 'plugin' -and $argv[1] -eq 'marketplace' -and $argv[2] -eq 'remove') {
  $removedName=$argv[3]
  if($state.marketplace -and $state.marketplace.name -eq $removedName){$state.marketplace=$null;$state.pluginEnabled=$false}
  Save-State; @{marketplaceName=$removedName;installedRoot=$null} | ConvertTo-Json -Compress; exit 0
}
if ($argv.Count -ge 4 -and $argv[0] -eq 'plugin' -and $argv[1] -eq 'marketplace' -and $argv[2] -eq 'add') {
  $newRoot=$argv[3]
  if($state.failNewRoot -and $newRoot -eq $state.failNewRoot){Save-State;[Console]::Error.WriteLine('simulated new marketplace failure');exit 1}
  if($state.marketplace -and $state.marketplace.name -eq 'agent-bridge' -and $state.marketplace.root -ne $newRoot){Save-State;[Console]::Error.WriteLine("Error: marketplace 'agent-bridge' is already added from a different source; remove it before adding this source");exit 1}
  $state.marketplace=@{name='agent-bridge';root=$newRoot};Save-State;@{marketplaceName='agent-bridge';installedRoot=$newRoot;alreadyAdded=$false} | ConvertTo-Json -Compress;exit 0
}
if ($argv.Count -ge 3 -and $argv[0] -eq 'plugin' -and $argv[1] -eq 'add') {
  if(!$state.marketplace){Save-State;[Console]::Error.WriteLine('marketplace missing');exit 1}
  $manifest=Get-Content -LiteralPath (Join-Path $state.marketplace.root 'codex/plugin.json') -Raw | ConvertFrom-Json
  $state.pluginVersion=$manifest.version;$state.pluginEnabled=$true;Save-State;@{pluginId='deepseek-bridge@agent-bridge';name='deepseek-bridge';marketplaceName='agent-bridge';version=$manifest.version} | ConvertTo-Json -Compress;exit 0
}
Save-State;[Console]::Error.WriteLine('unsupported mock Codex command');exit 2
`);
  return {dir,source,install,old,codexHome,statePath,mockCli,version};
}

function install(f){
  return spawnSync('pwsh',[
    '-NoProfile','-File',path.join(f.source,'scripts','install.ps1'),
    '-Target','Codex','-InstallRoot',f.install,'-CodexCommand',f.mockCli,'-HostStopped',
  ],{encoding:'utf8',env:{...process.env,CODEX_HOME:f.codexHome,CODEX_MOCK_STATE:f.statePath}});
}

test('Codex install upgrades an existing same-name local marketplace',options,async t=>{
  const f=await fixture(t);
  const result=install(f);
  assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
  const state=JSON.parse(await readFile(f.statePath,'utf8'));
  assert.equal(state.marketplace.root,path.join(f.install,f.version));
  assert.equal(state.pluginVersion,f.version);
  assert.equal(state.pluginEnabled,true);
  assert.ok(state.calls.some(call=>call.startsWith('plugin marketplace remove agent-bridge')));
  assert.equal(JSON.parse(await readFile(path.join(f.old,'codex','plugin.json'),'utf8')).version,'1.0.3-local.3');
});

test('Codex install can be repeated against the already registered version',options,async t=>{
  const f=await fixture(t);
  const first=install(f);
  assert.equal(first.status,0,`${first.stdout}\n${first.stderr}`);
  const second=install(f);
  assert.equal(second.status,0,`${second.stdout}\n${second.stderr}`);
  const state=JSON.parse(await readFile(f.statePath,'utf8'));
  assert.equal(state.marketplace.root,path.join(f.install,f.version));
  assert.equal(state.pluginVersion,f.version);
  assert.equal(state.pluginEnabled,true);
  assert.equal(state.calls.filter(call=>call.startsWith('plugin marketplace remove agent-bridge')).length,1);
  assert.equal(state.calls.filter(call=>call.startsWith('plugin marketplace add ')&&!call.endsWith('--help')).length,1);
});

test('Codex install restores the previous marketplace if the new source fails',options,async t=>{
  const f=await fixture(t,{failNewRoot:true});
  const result=install(f);
  assert.notEqual(result.status,0);
  const state=JSON.parse(await readFile(f.statePath,'utf8'));
  assert.equal(state.marketplace.root,f.old);
  assert.equal(state.pluginVersion,'1.0.3-local.3');
  assert.equal(state.pluginEnabled,true);
  assert.equal(state.calls.filter(call=>call.includes('marketplace add')&&!call.endsWith('--help')).length,2);
});
