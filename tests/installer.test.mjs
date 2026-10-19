import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm, cp} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const scratch=path.join(root,'work');
await mkdir(scratch,{recursive:true});
const run=(script,args)=>spawnSync('pwsh',['-NoProfile','-File',script,...args],{encoding:'utf8'});
test('DeepSeek isolated install: dry-run, backup, unrelated data, BOM, idempotence, immutable version',async()=>{
 const fixture=await mkdtemp(path.join(scratch,'installer-'));
 try {
 const source=path.join(fixture,'source'),profile=path.join(fixture,'profile'),install=path.join(fixture,'installed');
 await mkdir(path.join(source,'scripts'),{recursive:true});await mkdir(path.join(source,'deepseek'),{recursive:true});await mkdir(profile);
 await cp(path.join(root,'scripts/install.ps1'),path.join(source,'scripts/install.ps1'));
 await writeFile(path.join(source,'package.json'),JSON.stringify({version:'1.0.3-local.3'}));
 await writeFile(path.join(source,'deepseek/index.js'),'export const fixture=true;');
 await writeFile(path.join(source,'deepseek/package.json'),JSON.stringify({name:'dsh-agent-bridge',version:'1.0.3-local.3'}));
 const original=JSON.stringify({name:'fixture',dependencies:{other:'1'},dsh:{profile:{bundles:['other']}},custom:{keep:true}});
 const manifest=path.join(profile,'package.json');await writeFile(manifest,original);
 const args=['-Target','DeepSeek','-DeepSeekProfile',profile,'-InstallRoot',install];
 let result=run(path.join(source,'scripts/install.ps1'),[...args,'-DryRun']);assert.equal(result.status,0,result.stderr);assert.equal(await readFile(manifest,'utf8'),original);assert.deepEqual(await readdir(profile),['package.json']);
 result=run(path.join(source,'scripts/install.ps1'),args);assert.notEqual(result.status,0);assert.equal(await readFile(manifest,'utf8'),original);
 result=run(path.join(source,'scripts/install.ps1'),[...args,'-HostStopped']);assert.equal(result.status,0,result.stderr);
 const bytes=await readFile(manifest);assert.notEqual(bytes.subarray(0,3).toString('hex'),'efbbbf');
 const updated=JSON.parse(bytes);assert.equal(updated.dependencies.other,'1');assert.equal(updated.custom.keep,true);assert.deepEqual(updated.dsh.profile.bundles,['other','dsh-agent-bridge']);assert.match(updated.dependencies['dsh-agent-bridge'],/^link:/);
 const before=await readdir(profile);assert.equal(before.filter(x=>x.endsWith('.bak')).length,1);assert.equal(await readFile(path.join(profile,before.find(x=>x.endsWith('.bak'))),'utf8'),original);
 result=run(path.join(source,'scripts/install.ps1'),[...args,'-HostStopped']);assert.equal(result.status,0,result.stderr);assert.deepEqual(await readdir(profile),before);
 await writeFile(path.join(source,'deepseek/index.js'),'changed');result=run(path.join(source,'scripts/install.ps1'),[...args,'-HostStopped']);assert.notEqual(result.status,0);assert.equal(await readFile(path.join(install,'1.0.3-local.3/deepseek/index.js'),'utf8'),'export const fixture=true;');
 } finally {await rm(fixture,{recursive:true,force:true});}
});
test('portable docs and installer have no developer machine paths',async()=>{
 for(const file of ['README.md','docs/INSTALL.md','docs/USAGE.md','codex/MANUAL.md','deepseek/MANUAL.md','scripts/install.ps1']){
 const text=await readFile(path.join(root,file),'utf8');assert.doesNotMatch(text,/[A-Z]:[\\/](?:Users|Codex)[\\/]/i,file);
 }
});

for(const oldKind of ['junction','directory','unexpected']) test(`DeepSeek actual package replacement preserves ${oldKind}`,async()=>{
 const fixture=await mkdtemp(path.join(scratch,'link-'));
 try {
 const source=path.join(fixture,'source'),profile=path.join(fixture,'profile'),install=path.join(fixture,'installed'),old=path.join(fixture,'old');
 await mkdir(path.join(source,'scripts'),{recursive:true});await mkdir(path.join(source,'deepseek'),{recursive:true});await mkdir(path.join(profile,'node_modules'),{recursive:true});await mkdir(old);
 await cp(path.join(root,'scripts/install.ps1'),path.join(source,'scripts/install.ps1'));
 await writeFile(path.join(source,'package.json'),JSON.stringify({version:'1.0.3-local.3'}));await writeFile(path.join(source,'deepseek/package.json'),JSON.stringify({name:'dsh-agent-bridge',version:'1.0.3-local.3'}));
 await writeFile(path.join(profile,'package.json'),JSON.stringify({dependencies:{'dsh-agent-bridge':'link:old'},dsh:{profile:{bundles:['dsh-agent-bridge']}}}));
 await writeFile(path.join(old,'package.json'),JSON.stringify({name:'dsh-agent-bridge',version:'0.9.0'}));
 const entry=path.join(profile,'node_modules/dsh-agent-bridge');
 if(oldKind==='junction') {const {symlink}=await import('node:fs/promises');await symlink(old,entry,'junction');}
 else {await mkdir(entry);await writeFile(path.join(entry,'package.json'),JSON.stringify({name:oldKind==='unexpected'?'another-package':'dsh-agent-bridge',version:'0.9.0'}));}
 const args=['-Target','DeepSeek','-DeepSeekProfile',profile,'-InstallRoot',install,'-HostStopped'];
 let result=run(path.join(source,'scripts/install.ps1'),args);
 if(oldKind==='unexpected') {assert.notEqual(result.status,0);assert.equal(JSON.parse(await readFile(path.join(entry,'package.json'),'utf8')).name,'another-package');return;}
 assert.equal(result.status,0,result.stderr);
 const {realpath,lstat}=await import('node:fs/promises');
 assert.equal((await realpath(entry)).toLowerCase(),path.join(install,'1.0.3-local.3/deepseek').toLowerCase());
 assert.equal(JSON.parse(await readFile(path.join(entry,'package.json'),'utf8')).version,'1.0.3-local.3');
 const backups=(await readdir(path.join(profile,'node_modules'))).filter(x=>x.startsWith('dsh-agent-bridge.backup-'));assert.equal(backups.length,1);
 const backup=path.join(profile,'node_modules',backups[0]);assert.equal(JSON.parse(await readFile(path.join(backup,'package.json'),'utf8')).version,'0.9.0');assert.equal((await lstat(backup)).isSymbolicLink(),oldKind==='junction');
 result=run(path.join(source,'scripts/install.ps1'),args);assert.equal(result.status,0,result.stderr);assert.equal((await readdir(path.join(profile,'node_modules'))).filter(x=>x.startsWith('dsh-agent-bridge.backup-')).length,1);
 assert.equal(JSON.parse(await readFile(path.join(old,'package.json'),'utf8')).version,'0.9.0');
 } finally {await rm(fixture,{recursive:true,force:true});}
});
