import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createLifecycle} from '../shared/lifecycle.mjs';
import {createStore} from '../deepseek/lib/store.mjs';
import {createBridgeServer} from '../deepseek/lib/bridge-server.mjs';

const THREAD='11111111-2222-4333-8444-555555555555';
const SECRET='PEER_UNPUSHED_REPORT_TEXT';
async function directory(){await mkdir(resolve('work/push-tests'),{recursive:true});return mkdtemp(resolve('work/push-tests/run-'));}
async function lifecycle(){const dir=await directory(),sent=[];const opts={file:join(dir,'state.json'),deliver:async e=>{sent.push(e);return {state:'queued',transportTaskId:'transport-'+sent.length,reply:{text:SECRET},nested:{report:SECRET}}},readReceipt:async()=>({state:'done',reply:{text:SECRET},nested:{report:SECRET}})};const app=createLifecycle(opts);await app.init();const a=await app.command('agent',{action:'register',side:'codex',sessionId:THREAD}),b=await app.command('agent',{action:'register',side:'deepseek',sessionId:'session-peer'});return {app,a,b,sent,opts,call:(who,args)=>app.command('task',{...args,actorId:who.id,agentKey:who.agentKey})};}
async function httpFixture(t,{seed=true}={}){
 const dir=await directory();if(seed)await writeFile(join(dir,'tasks.json'),JSON.stringify({version:1,tasks:[{taskId:'tsk_probe',sessionId:'session-peer',state:'done',title:'own title',summary:'own request',status:'QUESTION',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),reply:{text:SECRET,at:new Date().toISOString()},turnEnd:{reason:'completed',report:SECRET},baselineSeq:0,refs:[]}]}));
 const store=createStore({stateDir:dir,logger:{warn(){}}}),received=[];
 const bridge=createBridgeServer({ctx:{sessionController:{list:async()=>({items:[{sessionId:'session-peer',agentAvailable:true,cwd:process.cwd()}]}),prompt:async(p)=>{received.push(p);return {accepted:true}},follow:()=>(async function*(){yield {type:'snapshot',cursor:0};yield {type:'event',event:{seq:1,type:'assistant',data:{content:[{type:'text',text:SECRET}]}}};})()}},store,config:{prefix:'/agent-bridge',stateDir:dir},codexRef:{client:{send:async()=>({taskId:'cx-close'}),wait:async()=>({state:'queued'})}},logger:{info(){},warn(){}}});await bridge.init();const server=createServer(bridge.handle);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{bridge.dispose();server.closeAllConnections();await new Promise(r=>server.close(r));await store.close()});
 const call=async(path,body)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/agent-bridge${path}`,{method:body?'POST':'GET',headers:{authorization:'Bearer '+store.token(),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,...await response.json()}};
 return {bridge,call,received};
}

test('unclosed v2 queries and mutations cannot pull peer body, evidence or nested receipts',async()=>{
 const f=await lifecycle();const task=await f.call(f.b,{action:'send',recipientId:f.a.id,title:SECRET,content:SECRET,requestId:'push'});assert.match(f.sent[0].content,new RegExp(SECRET));
 assert.equal((await f.call(f.b,{action:'get',taskId:task.id})).content,SECRET,'sender may read its own text');
 for(const action of ['get','refresh','list']){const result=await f.call(f.a,{action,taskId:task.id});assert.ok(!JSON.stringify(result).includes(SECRET),action+' disclosed peer text');}
 await f.call(f.b,{action:'complete',taskId:task.id,expectedRevision:1,evidence:SECRET});await f.call(f.b,{action:'confirm',taskId:task.id,expectedRevision:1,verdict:'accepted',evidence:SECRET});
 assert.ok(!JSON.stringify(await f.call(f.a,{action:'get',taskId:task.id})).includes(SECRET),'one confirmation is not closed');
 const closed=await f.call(f.a,{action:'confirm',taskId:task.id,expectedRevision:1,verdict:'accepted',evidence:'received through push'});assert.equal(closed.state,'closed');assert.equal(closed.content,SECRET,'verified closure permits scoped archival read');
 await f.call(f.b,{action:'reopen',taskId:task.id,expectedRevision:1,reason:'new work'});assert.ok(!JSON.stringify(await f.call(f.a,{action:'get',taskId:task.id})).includes(SECRET),'reopen restores push-only');
});

test('own task status does not leak peer data embedded by transport refresh',async()=>{
 const f=await lifecycle();const task=await f.call(f.a,{action:'send',recipientId:f.b.id,title:'own',content:'own body',requestId:'own'});assert.ok(!JSON.stringify(task).includes(SECRET));const result=await f.call(f.a,{action:'refresh',taskId:task.id});assert.equal(result.content,'own body');assert.ok(!JSON.stringify(result).includes(SECRET));
});

test('forged closed state without bilateral accepted close event does not unlock archive',async()=>{
 const f=await lifecycle();const task=await f.call(f.b,{action:'create',recipientId:f.a.id,content:SECRET});const data=JSON.parse(await readFile(f.opts.file,'utf8'));data.tasks[task.id].state='closed';data.tasks[task.id].archiveAvailable=true;await writeFile(f.opts.file,JSON.stringify(data));const app=createLifecycle(f.opts);await app.init();const view=await app.command('task',{action:'get',actorId:f.a.id,agentKey:f.a.agentKey,taskId:task.id});assert.ok(!JSON.stringify(view).includes(SECRET));
});

test('legacy done is not closure: get/list/wait/debug never expose unpushed report',async t=>{
 const f=await httpFixture(t);for(const [path,body] of [['/tasks/tsk_probe'],['/tasks'],['/tasks/tsk_probe/wait',{waitMs:0,closed:true}],['/debug/follow?sessionId=session-peer&ms=1']]){const reply=await f.call(path,body);assert.ok(!JSON.stringify(reply).includes(SECRET),path+' leaked unclosed report');}
});

test('legacy archive unlocks only after actual bilateral closure and relocks on reopen',async t=>{
 const f=await httpFixture(t);const a=await f.bridge.lifecycle.command('agent',{action:'register',side:'codex',sessionId:THREAD}),b=await f.bridge.lifecycle.command('agent',{action:'register',side:'deepseek',sessionId:'session-peer'});const call=(who,args)=>f.bridge.lifecycle.command('task',{...args,actorId:who.id,agentKey:who.agentKey});const task=await call(a,{action:'import',recipientId:b.id,legacyTaskId:'tsk_probe',legacyDirection:'codex-to-deepseek'});assert.ok(!JSON.stringify(await f.call('/tasks/tsk_probe')).includes(SECRET));await call(a,{action:'complete',taskId:task.id,expectedRevision:1,evidence:'pushed report verified'});await call(b,{action:'confirm',taskId:task.id,expectedRevision:1,verdict:'accepted',evidence:'peer check'});assert.ok(!JSON.stringify(await f.call('/tasks/tsk_probe')).includes(SECRET));await call(a,{action:'confirm',taskId:task.id,expectedRevision:1,verdict:'accepted',evidence:'sender check'});assert.equal((await f.call('/tasks/tsk_probe')).value.reply.text,SECRET);await call(a,{action:'reopen',taskId:task.id,expectedRevision:1,reason:'follow-up'});assert.ok(!JSON.stringify(await f.call('/tasks/tsk_probe')).includes(SECRET));
});

test('legacy dispatch requires real reply address and instructs explicit push, never pull',async t=>{
 const f=await httpFixture(t,{seed:false});const missing=await f.call('/tasks/send',{sessionId:'session-peer',summary:'review this',title:'task'});assert.equal(missing.status,400);assert.equal(f.received.length,0);const sent=await f.call('/tasks/send',{sessionId:'session-peer',summary:'review this',title:'task',replyThreadId:THREAD});assert.equal(sent.value.accepted,true);const text=f.received[0].content[0].text;assert.ok(text.includes(THREAD));assert.match(text,/codex_task/);assert.ok(!text.includes('Codex 端会用'));assert.match(text,/主动/);
});

async function mcp(t,response,{policy=true}={}){const dir=await directory(),requests=[],allRequests=[];const server=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;const request={url:req.url,body:JSON.parse(body||'{}')};allRequests.push(request);res.setHeader('content-type','application/json');if(req.url==='/health'){res.end(JSON.stringify({ok:true,value:{version:'test',...(policy?{readPolicy:'push-only-until-closed'}:{})}}));return;}requests.push(request);res.end(JSON.stringify({ok:true,value:response}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));await writeFile(join(dir,'token'),'isolated-token');await writeFile(join(dir,'endpoint.json'),JSON.stringify({baseUrl:`http://127.0.0.1:${server.address().port}`,tokenPath:join(dir,'token')}));const env={...process.env,DSH_AGENT_BRIDGE_HOME:dir};delete env.CODEX_THREAD_ID;const child=spawn(process.execPath,[resolve('codex/server.mjs')],{env,stdio:['pipe','pipe','pipe']});let seq=0;const pending=new Map();createInterface({input:child.stdout}).on('line',line=>{const value=JSON.parse(line);pending.get(value.id)?.(value);pending.delete(value.id)});const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>reject(Error('MCP timeout')),5000);pending.set(id,result=>{clearTimeout(timer);resolve(result)});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')});t.after(async()=>{child.kill();server.closeAllConnections();await new Promise(r=>server.close(r))});return {requests,allRequests,call:async(name,args)=>(await rpc('tools/call',{name,arguments:args})).result};}

test('MCP cannot leak old backend result and no PID is used as reply address',async t=>{
 const f=await mcp(t,{taskId:'tsk_probe',state:'done',reply:{text:SECRET},turnEnd:{reason:'completed',report:SECRET}});const result=await f.call('deepseek_result',{taskId:'tsk_probe',waitMs:0});assert.ok(!JSON.stringify(result).includes(SECRET));const missing=await f.call('deepseek_task',{title:'request',status:'QUESTION',summary:'review'});assert.equal(missing.isError,true);assert.equal(f.requests.length,1);await f.call('deepseek_task',{title:'request',status:'QUESTION',summary:'review',replyThreadId:THREAD});assert.equal(f.requests.at(-1).body.replyThreadId,THREAD);assert.ok(!String(f.requests.at(-1).body.replyTo).startsWith('codex:'));
});

test('MCP v2 also redacts peer content from an old backend',async t=>{
 const f=await mcp(t,{id:'AB-old',state:'queued',ownerId:'DS-peer',recipientId:'CX-self',content:SECRET,title:SECRET,receipt:{reply:{text:SECRET}}});const result=await f.call('bridge_task',{action:'get',taskId:'AB-old',actorId:'CX-self',agentKey:'test-key'});assert.ok(!JSON.stringify(result).includes(SECRET));assert.notEqual(result.isError,true);
});

test('explicit compatibility address works, conflicting addresses fail, notices require no reply',async t=>{
 const f=await httpFixture(t,{seed:false});const summary=`[Agent Bridge Reply-To: codex ${THREAD}]\nreview`;const ok=await f.call('/tasks/send',{sessionId:'session-peer',summary});assert.equal(ok.value.accepted,true);const conflict=await f.call('/tasks/send',{sessionId:'session-peer',summary,replyThreadId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'});assert.equal(conflict.status,400);assert.equal(f.received.length,1);const notice=await f.call('/tasks/send',{sessionId:'session-peer',summary:'closed',replyRequired:false});assert.equal(notice.value.accepted,true);const text=f.received[1].content[0].text;assert.match(text,/无需回复|不要求回复|不要求回执/);assert.ok(!text.includes('codex_task('));
});

test('unsupported backend is never asked for task content even for mutations',async t=>{
 const f=await mcp(t,{id:'AB-private',state:'queued',content:SECRET,reply:{text:SECRET}},{policy:false});
 for(const [tool,args] of [['deepseek_result',{taskId:'tsk_probe'}],['bridge_task',{action:'get',taskId:'AB-private',actorId:'CX-self',agentKey:'key'}],['bridge_task',{action:'confirm',taskId:'AB-private',actorId:'CX-self',agentKey:'key',expectedRevision:1,verdict:'accepted',evidence:'own'}]]){const result=await f.call(tool,args);assert.equal(result.isError,true);assert.equal(result.structuredContent.code,'bridge/upgrade-required');assert.ok(!JSON.stringify(result).includes(SECRET));}
 assert.equal(f.requests.length,0,'no task endpoint may be called');assert.deepEqual(f.allRequests.map(r=>r.url),['/health','/health','/health']);
});

test('disabled Stop entry does not read rollouts or send HTTP',async t=>{
 const f=await mcp(t,{});const result=await f.call('deepseek_report_turn_end',{session_id:THREAD});assert.equal(result.structuredContent.delivered,false);assert.equal(result.structuredContent.reason,'disabled');assert.equal(f.allRequests.length,0);
});

test('forged closed state cannot make close or confirm return success',async()=>{
 const f=await lifecycle();const task=await f.call(f.a,{action:'create',recipientId:f.b.id,content:'own body'});const data=JSON.parse(await readFile(f.opts.file,'utf8'));data.tasks[task.id].state='closed';await writeFile(f.opts.file,JSON.stringify(data));const app=createLifecycle(f.opts);await app.init();for(const action of ['close','confirm'])await assert.rejects(app.command('task',{action,actorId:f.a.id,agentKey:f.a.agentKey,taskId:task.id,expectedRevision:1,verdict:'accepted',evidence:'own'}),{code:'task/acceptance'});
});

