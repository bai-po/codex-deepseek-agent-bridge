import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
async function fixture(t){
 await mkdir(path.join(root,'work/test-state'),{recursive:true}); const home=await mkdtemp(path.join(root,'work/test-state/bridge-mcp-v2-')); const requests=[];
 const server=createServer(async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text||'{}');
  if(req.url==='/health'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,value:{readPolicy:'push-only-until-closed'}}));return;}
  requests.push({method:req.method,url:req.url,auth:req.headers.authorization,body});res.setHeader('Content-Type','application/json');
  if(req.method==='POST'&&req.url==='/tasks/open/wait'){
   res.end(JSON.stringify({ok:true,value:{taskId:'open',state:'running',title:'safe title',summary:'owner summary',reply:'OPEN_PEER_SECRET',replyPath:'D:/private/reply.txt',turnEnd:{at:'2026-10-19T00:00:00Z',text:'OPEN_PEER_SECRET'},error:{code:'dsh/turn-timeout',message:'OPEN_PEER_SECRET'},archiveAvailable:false,readPolicy:'push-only-until-closed'}}));return;
  }
  res.end(JSON.stringify(body.taskId==='reject'?{ok:false,error:{code:'task/conflict',message:'revision mismatch'}}:{ok:true,value:{received:body}}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 await writeFile(path.join(home,'token'),'isolated-token');await writeFile(path.join(home,'endpoint.json'),JSON.stringify({baseUrl:`http://127.0.0.1:${server.address().port}/`,tokenPath:path.join(home,'token')}));
 const child=spawn(process.execPath,[path.join(root,'codex/server.mjs')],{env:{...process.env,DSH_AGENT_BRIDGE_HOME:home},stdio:['pipe','pipe','pipe']});let seq=0;const pending=new Map();
 createInterface({input:child.stdout}).on('line',line=>{const data=JSON.parse(line);pending.get(data.id)?.(data);pending.delete(data.id);});
 t.after(async()=>{child.kill();await new Promise(resolve=>server.close(resolve));await rm(home,{recursive:true,force:true});});
 const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>reject(Error('MCP timeout')),5000);pending.set(id,value=>{clearTimeout(timer);resolve(value);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 return {rpc,requests,call:async(name,args)=>(await rpc('tools/call',{name,arguments:args})).result};
}
test('Codex MCP configs use plugin-relative startup paths',async()=>{
 for(const file of ['codex/.mcp.json','codex/mcp.json']){
  const config=JSON.parse(await readFile(path.join(root,file),'utf8')).mcpServers.deepseek_bridge;
  assert.equal(config.cwd,'.',file);
  assert.deepEqual(config.args,['./server.mjs'],file);
  assert.ok(!JSON.stringify(config).includes('${PLUGIN_ROOT}'),file);
 }
});
test('v2 discovery preserves legacy and uses standard schemas',async t=>{const {rpc}=await fixture(t);const init=(await rpc('initialize',{})).result;const manifest=JSON.parse(await readFile(path.join(root,'codex/plugin.json'),'utf8'));assert.equal(init.serverInfo.version,manifest.version);assert.ok(init.capabilities.resources);const tools=(await rpc('tools/list')).result.tools;for(const name of ['deepseek_task','deepseek_result','deepseek_status','bridge_agent','bridge_task','bridge_manual'])assert.ok(tools.some(x=>x.name===name),name);for(const tool of tools){assert.equal(tool.inputSchema.type,'object');assert.ok(tool.inputSchema.properties);}assert.deepEqual(tools.find(x=>x.name==='bridge_task').inputSchema.required,['action']);});

test('deepseek_result positive waitMs is one state wait and still filters open peer content',async t=>{
 const {call,requests,rpc}=await fixture(t);await rpc('initialize',{});const result=await call('deepseek_result',{taskId:'open',waitMs:5000});const value=result.structuredContent;
 assert.equal(result.isError,false);assert.deepEqual(requests.map(({method,url,body})=>({method,url,body})),[{method:'POST',url:'/tasks/open/wait',body:{waitMs:5000}}]);
 assert.equal(value.reply,null);assert.equal(value.archiveAvailable,false);assert.equal(value.readPolicy,'push-only-until-closed');assert.deepEqual(value.turnEnd,{at:'2026-10-19T00:00:00Z'});assert.deepEqual(value.error,{code:'dsh/turn-timeout'});assert.ok(!JSON.stringify(result).includes('OPEN_PEER_SECRET'));
 const description=(await rpc('tools/list',{})).result.tools.find(tool=>tool.name==='deepseek_result').description;
 assert.match(description,/waitMs defaults to 0/i);assert.match(description,/positive value sends one POST \/tasks\/\{id\}\/wait.*state changes only/i);
});

test('Codex and DSH manuals document default-zero state-only waiting',async()=>{
 for(const file of ['README.md','codex/MANUAL.md','deepseek/MANUAL.md','docs/USAGE.md','codex/skills/deepseek-bridge/SKILL.md']){
  const text=await readFile(path.join(root,file),'utf8');assert.match(text,/waitMs=0/,file);assert.match(text,/POST \/tasks\/\{id\}\/wait/,file);assert.match(text,/reply=null/,file);
 }
});
test('v2 HTTP forwarding injects side and preserves explicit identities and errors',async t=>{const {call,requests}=await fixture(t);const agent=await call('bridge_agent',{action:'register',sessionId:'be008ab0-21d4-4dd6-a4f4-cf0a67c3d30a',alias:'test',agentKey:'private-owner-capability'});assert.equal(agent.isError,false);assert.equal(requests[0].url,'/v2/agent');assert.equal(requests[0].auth,'Bearer isolated-token');assert.equal(requests[0].body.side,'codex');assert.equal(requests[0].body.agentKey,'private-owner-capability');const task={action:'send',actorId:'CX-owner',agentKey:'private-owner-capability',recipientId:'DS-target',title:'title',content:'real request',requestId:'retry-1'};assert.equal((await call('bridge_task',task)).isError,false);assert.deepEqual(requests[1].body,{...task,side:'codex'});const error=await call('bridge_task',{action:'get',actorId:'CX-owner',taskId:'reject'});assert.equal(error.isError,true);assert.equal(error.structuredContent.code,'task/conflict');});
test('invalid identities/types fail without reaching HTTP',async t=>{const {call,requests}=await fixture(t);for(const [name,args] of [['bridge_agent',{action:'register'}],['bridge_agent',{action:'register',sessionId:'latest'}],['bridge_task',{action:'unknown'}],['bridge_task',{action:'send',expectedRevision:1.5}],['bridge_task',{action:'list',includeDeleted:'yes'}],['bridge_task',{action:'list',side:'deepseek'}]]){assert.equal((await call(name,args))?.isError,true);}assert.equal(requests.length,0);});
test('manual tool and resource read the packaged manual',async t=>{const {call,rpc}=await fixture(t);const tools=await call('bridge_manual',{});assert.equal(tools?.isError,false);const resources=(await rpc('resources/list')).result.resources;assert.ok(resources.some(x=>x.uri==='bridge://manual'));const read=(await rpc('resources/read',{uri:'bridge://manual'})).result;assert.equal(read.contents[0].text,await readFile(path.join(root,'codex/MANUAL.md'),'utf8'));assert.equal(tools.structuredContent.text,read.contents[0].text);assert.ok((await rpc('resources/read',{uri:'bridge://unknown'})).error);});

test('legacy Codex tool refuses oversized summaries without HTTP truncation',async t=>{const {call,requests}=await fixture(t);const reply=await call('deepseek_task',{title:'long',status:'INFO',summary:'x'.repeat(4001)});assert.equal(reply.isError,true);assert.equal(reply.structuredContent.code,'request/too-large');assert.match(reply.structuredContent.message,/4001/);assert.match(reply.structuredContent.message,/4000/);assert.equal(requests.length,0);});
