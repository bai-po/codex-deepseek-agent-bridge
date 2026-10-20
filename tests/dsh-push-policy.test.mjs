import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createLifecycle} from '../shared/lifecycle.mjs';
import {legacyResultView} from '../shared/read-policy.mjs';
import {createCodexClient} from '../deepseek/lib/codex-client.mjs';

// Only the host schema-conversion dependency is stubbed; execute/render are the real tools.
const hook=registerHooks({resolve(specifier,context,next){return specifier==='@deepseek-ai/dsh-tools'?{url:'data:text/javascript,export const parameterSchemaSpecToJsonSchema=x=>x;',shortCircuit:true}:next(specifier,context)}});
const {registerTools}=await import('../deepseek/lib/tools.mjs');hook.deregister();
const SECRET='UNPUSHED_CODEX_REPORT';
async function directory(){await mkdir(resolve('work/dsh-policy'),{recursive:true});return mkdtemp(resolve('work/dsh-policy/run-'));}
function tools({closed=false}={}){const defs=new Map(),calls=[];const result={taskId:'cx-probe',threadId:'thread-known',state:'done',reply:SECRET,replyPath:SECRET,turnEnd:{reason:SECRET,at:'now'},error:{code:'test/error',message:SECRET},usage:{report:SECRET}};const client={send:async args=>(calls.push(['send',args]),result),wait:async args=>(calls.push(['wait',args]),result),status:async args=>(calls.push(['status',args]),result)};registerTools({tools:{register:d=>defs.set(d.name,d)}},{bridge:{lifecycle:{isTransportClosed:()=>closed}},codexRef:{client},store:{dir:'isolated'}});return {defs,calls};}

test('DSH send is message-only even with waitMs; open result uses metadata and never waits for peer',async()=>{
 const f=tools();const sendTool=f.defs.get('codex_task');assert.match(sendTool.description,/does not wait for or read a reply/);assert.match(sendTool.description,/actively pushed into this chat/);for(const delivery of ['queue','resume']){const result=await sendTool.execute({message:'own request',thread:'thread-known',delivery,waitMs:120000});assert.ok(!JSON.stringify(result).includes(SECRET));}
 assert.equal(f.calls.filter(([name])=>name==='wait').length,0);const result=await f.defs.get('codex_result').execute({taskId:'cx-probe',waitMs:120000});assert.ok(!JSON.stringify(result).includes(SECRET));assert.equal(result.reply,null);assert.deepEqual(f.calls.at(-1),['status',{taskId:'cx-probe',metadataOnly:true}]);assert.ok(!JSON.stringify(f.defs.get('codex_result').output.render({},result)).includes(SECRET));
});

test('DSH may read exact transport archive only after verified bilateral closure',async()=>{
 const f=tools({closed:true});const result=await f.defs.get('codex_result').execute({taskId:'cx-probe',waitMs:0});assert.equal(result.reply,SECRET);assert.deepEqual(f.calls.at(-1),['status',{taskId:'cx-probe',metadataOnly:false}]);
});

test('closed archive query ignores legacy waitMs and never waits',async()=>{
 const f=tools({closed:true});const resultTool=f.defs.get('codex_result');assert.match(resultTool.parameters.waitMs.description,/ignored/i);const result=await resultTool.execute({taskId:'cx-probe',waitMs:120000});assert.equal(result.reply,SECRET);assert.equal(f.calls.filter(([name])=>name==='wait').length,0);assert.deepEqual(f.calls.at(-1),['status',{taskId:'cx-probe',metadataOnly:false}]);
});

test('result rendering shows projected error code without an undefined message',()=>{
 const f=tools();const rendered=f.defs.get('codex_result').output.render({}, {taskId:'cx-probe',threadId:'thread-known',state:'error',error:{code:'codex/queue-failed'}});assert.equal(rendered.length,1);assert.match(rendered[0].text,/error: codex\/queue-failed/);assert.doesNotMatch(rendered[0].text,/undefined/);
});

test('legacy owner summary remains readable without exposing peer reply',()=>{const view=legacyResultView({taskId:'tsk-own',summary:'own request',reply:{text:SECRET}},false);assert.equal(view.summary,'own request');assert.ok(!JSON.stringify(view).includes(SECRET));});

test('import transfers a reference, never launders source peer text into owner content',async()=>{
 const dir=await directory(),file=join(dir,'lifecycle.json');const app=createLifecycle({file,deliver:async()=>({state:'queued'}),lookupLegacy:async()=>({title:SECRET,content:SECRET,summary:SECRET,receipt:{reply:{text:SECRET}}})});await app.init();const a=await app.command('agent',{action:'register',side:'codex',sessionId:'thread-own'}),b=await app.command('agent',{action:'register',side:'deepseek',sessionId:'session-peer'});const task=await app.command('task',{action:'import',actorId:a.id,agentKey:a.agentKey,recipientId:b.id,legacyTaskId:'tsk-legacy',legacyDirection:'codex-to-deepseek'});assert.equal(task.legacyTaskId,'tsk-legacy');assert.ok(!JSON.stringify(task).includes(SECRET));assert.ok(!(await readFile(file,'utf8')).includes(SECRET));
});

test('metadata-only client restart reads separate status, never legacy reply record',async()=>{
 const dir=await directory(),id='cx-isolated';await mkdir(join(dir,id));await writeFile(join(dir,id,'meta.json'),'{not metadata');await writeFile(join(dir,id,'reply.txt'),SECRET);await writeFile(join(dir,id,'status.json'),JSON.stringify({taskId:id,threadId:'known',state:'done',readPolicy:'push-only-until-closed',reply:null}));const client=createCodexClient({logDir:dir,codexBin:process.execPath});const result=await client.status({taskId:id,metadataOnly:true});assert.equal(result.state,'done');assert.ok(!JSON.stringify(result).includes(SECRET));
});

test('old records without separate status stay unknown without opening meta or reply',async()=>{
 const dir=await directory(),id='cx-legacy';await mkdir(join(dir,id));await writeFile(join(dir,id,'meta.json'),'{not valid json: '+SECRET);await writeFile(join(dir,id,'reply.txt'),SECRET);const client=createCodexClient({logDir:dir,codexBin:process.execPath});const result=await client.status({taskId:id,metadataOnly:true});assert.equal(result.state,'unknown');assert.ok(!JSON.stringify(result).includes(SECRET));
});

test('DSH declared output schemas accept protected null fields',async()=>{
 const f=tools();for(const name of ['codex_task','codex_result']){const tool=f.defs.get(name),value=await tool.execute({message:'own',thread:'known',taskId:'cx-probe'});for(const field of ['reply','turnEnd']){const schema=tool.output.schema.properties[field],schemas=schema.oneOf??[schema],actual=value[field]===null?'null':typeof value[field];assert.ok(schemas.some(branch=>branch.type===actual),`${name}.${field} rejects its real protected result`);}}
});

test('queue send settles transport acceptance without waiting for a peer reply',async()=>{
 const dir=await directory();let accepted=false;const client=createCodexClient({logDir:dir,codexBin:process.execPath,spawn:()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();setTimeout(()=>{accepted=true;child.stdout.write('Queued message isolated for thread known');child.emit('close',0,null)},25);return child}});const sent=await client.send({threadId:'known',message:'own request',delivery:'queue'});assert.equal(accepted,true,'send must wait only for queue command acceptance');assert.equal(sent.state,'queued');const status=await client.status({taskId:sent.taskId,metadataOnly:true});assert.equal(status.state,'queued');assert.equal(status.reply,null);assert.ok(!(await readFile(join(dir,sent.taskId,'status.json'),'utf8')).includes('own request'));
});
