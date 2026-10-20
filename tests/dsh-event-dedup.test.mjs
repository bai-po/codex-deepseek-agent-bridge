import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createStore} from '../deepseek/lib/store.mjs';
import {createBridgeServer} from '../deepseek/lib/bridge-server.mjs';

function eventChannel(){
 const pending=[];const readers=[];let closed=false;
 const take=signal=>{
  if(pending.length>0)return Promise.resolve(pending.shift());
  if(closed||signal.aborted)return Promise.resolve(null);
  return new Promise(resolve=>{
   const reader=item=>{signal.removeEventListener('abort',abort);resolve(item)};
   const abort=()=>{const index=readers.indexOf(reader);if(index>=0)readers.splice(index,1);resolve(null)};
   readers.push(reader);signal.addEventListener('abort',abort,{once:true});
  });
 };
 return {
  push(frame){return new Promise((resolve,reject)=>{if(closed){reject(new Error('event channel closed'));return;}const item={frame,done:resolve};const reader=readers.shift();if(reader)reader(item);else pending.push(item);});},
  close(){closed=true;for(const reader of readers.splice(0))reader(null);},
  async *follow(signal){yield {type:'snapshot',cursor:0};while(!signal.aborted){const item=await take(signal);if(item===null)return;yield item.frame;item.done();}},
 };
}

test('spliced and user/message copies of one marker prompt exactly once and match only user/message',async()=>{
 await mkdir(resolve('work/event-dedup'),{recursive:true});
 const dir=await mkdtemp(resolve('work/event-dedup/run-'));
 const store=createStore({stateDir:dir,logger:{warn(){}}});
 const channel=eventChannel();const prompts=[];const logs=[];
 const threadId='11111111-2222-4333-8444-555555555555';
 const bridge=createBridgeServer({ctx:{sessionController:{list:async()=>({items:[{sessionId:'session-test',cwd:process.cwd(),agentAvailable:true,blank:false}]}),prompt:async(prompt,signal)=>{signal.throwIfAborted();prompts.push(prompt);const text=prompt.content[0].text;await channel.push({type:'event',event:{seq:1,type:'user/message',data:{content:[{type:'text',text}]}}});await channel.push({type:'event',event:{seq:2,type:'agent/inbox/spliced',data:{content:[{type:'text',text}]}}});return {accepted:true}},follow:(_request,signal)=>channel.follow(signal)}},store,config:{prefix:'/agent-bridge',stateDir:dir,workspaceRoot:process.cwd(),autoNotify:false,taskTimeoutMs:30000},codexRef:{client:null},logger:{info(message){logs.push(message)},warn(){}},version:'1.0.4'});
 await bridge.init();
 const server=createServer(bridge.handle);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const sent=await bridge.sendTask({sessionId:'session-test',title:'event fixture',status:'INFO',summary:'test same message routed through two event types',replyThreadId:threadId});
  const response=await fetch(`http://127.0.0.1:${server.address().port}/agent-bridge/tasks/${sent.taskId}`,{headers:{authorization:`Bearer ${store.token()}`}});
  assert.equal(response.status,200);const payload=await response.json();const task=payload.value;
  assert.equal(prompts.length,1,'one bridge send must call sessionController.prompt once');
  assert.equal(task.state,'running');assert.equal(task.matched,true);assert.equal(logs.filter(message=>message.includes('injected task')).length,1,'the paired spliced event must not advance the marker match a second time');
  await store.close();const persisted=JSON.parse(await readFile(store.tasksPath,'utf8')).tasks.filter(record=>record.taskId===sent.taskId);
  assert.equal(persisted.length,1,'the paired follow events must correspond to one persisted task record');
 }finally{
  channel.close();bridge.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await store.close();
 }
});
