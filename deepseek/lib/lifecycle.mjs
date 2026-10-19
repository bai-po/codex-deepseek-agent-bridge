import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';

const copy=x=>structuredClone(x), now=()=>new Date().toISOString();
function fail(code,message){throw Object.assign(new Error(message),{code,status:code.includes('not-found')?404:409});}
function text(x,name,optional=false){if(typeof x!=='string'||!x.trim()){if(optional)return '';fail('request/invalid',`${name} 不能为空`);}if(x.length>20000)fail('request/invalid',`${name} 过长`);return x.trim();}
const publicAgent=a=>{const {keyHash,...safe}=a;return copy(safe)};
const keyHash=k=>createHash('sha256').update(k).digest('hex');
const fingerprint=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');

/** One atomic, serialized command owner. No method edits host conversations. */
export function createLifecycle({file,deliver,lookupLegacy,readReceipt,validateAgent}){
  let data,tail=Promise.resolve(),generation=0;
  async function save(){await mkdir(dirname(file),{recursive:true});const tmp=`${file}.${randomUUID()}.tmp`;await writeFile(tmp,JSON.stringify(data,null,2)+'\n','utf8');await rename(tmp,file);generation++;}
  async function init(){try{data=JSON.parse(await readFile(file,'utf8'));if(data.version!==1||!data.agents||!data.tasks||!data.requests)throw Error('Unsupported lifecycle state');}catch(e){if(e.code!=='ENOENT')throw e;data={version:1,agents:{},tasks:{},requests:{}};await save();}}
  function agent(id){const key=text(id,'agentId'),a=Object.hasOwn(data.agents,key)?data.agents[key]:undefined;if(!a)fail('agent/not-found','agentId 未注册；请先register并保存首次返回的agentKey');return a;}
  function authenticate(a,key){if(typeof key!=='string'||typeof a.keyHash!=='string'||!/^[0-9a-f]{64}$/.test(a.keyHash)||!timingSafeEqual(Buffer.from(keyHash(key),'hex'),Buffer.from(a.keyHash,'hex')))fail('agent/unauthorized','缺少或错误agentKey');return a;}
  function task(args,ownerOnly=false,allowDeleted=false){const a=agent(args.actorId),t=data.tasks[text(args.taskId,'taskId')];if(!t)fail('task/not-found','任务不存在');if(ownerOnly?t.ownerId!==a.id:![t.ownerId,t.recipientId].includes(a.id))fail('task/owner','任务归属不匹配');if(t.deleted&&!allowDeleted)fail('task/deleted','条目已删除，请先restore');return t;}
  function revision(t,args){if(!Number.isInteger(args.expectedRevision)||args.expectedRevision!==t.revision)fail('task/revision-conflict','expectedRevision 与当前修订不一致');}
  function touch(t){t.updatedAt=now();}
  function create(args){const a=agent(args.actorId),b=agent(text(args.recipientId,'recipientId'));if(a.side===b.side)fail('task/recipient','recipient必须属于另一端');const content=text(args.content,'content');const t={id:'AB-'+randomUUID(),ownerId:a.id,recipientId:b.id,title:text(args.title,'title',true)||'桥接任务',content,revision:1,deliveryRevision:1,state:'draft',deleted:false,createdAt:now(),updatedAt:now(),history:[],events:[],confirmations:{},completion:null,receipt:null};data.tasks[t.id]=t;return t;}
  async function event(t,{type='send',targetId=t.recipientId,replyRequired=true}={}){
    const deliveryRevision=t.deliveryRevision??t.revision;
    const id=`${t.id}:r${type==='closed'?t.revision:deliveryRevision}:${type}`;
    const existing=t.events.find(e=>e.id===id);
    if(existing&&existing.phase!=='failed'){if(existing.phase==='accepted')return existing.receipt;fail('delivery/uncertain','该投递结果不确定，拒绝自动重发；请核对对方记录');}
    const attempts=existing?[...(existing.attempts??[]),{phase:existing.phase,error:existing.error,at:existing.at}]:[];
    if(existing)t.events.splice(t.events.indexOf(existing),1);
    const e={id,type,attempts,revision:type==='closed'?t.revision:deliveryRevision,replyRequired,phase:'inflight',at:now()};t.events.push(e);touch(t);await save();
    const header=`[Agent Bridge ${t.id} revision=${t.revision} event=${id} replyRequired=${replyRequired}]`;
    const body=type==='closed'?`${header}\n本任务已验收并完成双方确认，现已闭环，后续无需回复。本通知不要求回执。`:
      `${header}\n${type==='correction'?'更正修订：以本修订替代此前任务内容。\n':''}发送方 ${t.ownerId}；接收方 ${t.recipientId}\n${t.title}\n${t.content}\n请使用桥接任务编号处理本任务；验收前勿提前闭环。`;
    try{const receipt=await deliver({target:publicAgent(agent(targetId)),owner:publicAgent(agent(t.ownerId)),task:copy(t),eventId:id,content:body,replyRequired});e.phase='accepted';e.receipt=copy(receipt);await save();return receipt;}
    catch(error){e.phase=error.definitive===true?'failed':'uncertain';e.error={code:error.code??'delivery/error',message:error.message};touch(t);await save();throw error;}
  }
  async function send(t,type='send'){if(t.state==='closed')fail('task/closed','闭环任务需先reopen');const revision=t.deliveryRevision??t.revision;const events=t.events.filter(e=>e.revision===revision&&e.type!=='closed');if(events.some(e=>['uncertain','inflight'].includes(e.phase)))fail('delivery/uncertain','投递结果不确定，不能自动重发');if(events.some(e=>e.phase==='accepted'))return t;if(!events.length&&t.state!=='draft'&&type!=='correction')fail('task/use-correct','已有投递记录或导入任务需用correct或reopen，不能重新send');const failed=events.find(e=>e.phase==='failed');const receipt=await event(t,{type:failed?.type??type});t.receipt=copy(receipt);t.state=receipt.state==='done'?'delivered':'queued';touch(t);await save();return t;}
  async function close(t,actorId){if(t.state==='closed')return t;if(t.completion?.revision!==t.revision||t.confirmations[t.ownerId]?.revision!==t.revision||t.confirmations[t.recipientId]?.revision!==t.revision)fail('task/acceptance','验收证据和双方confirmation尚未完成');await event(t,{type:'closed',targetId:actorId===t.ownerId?t.recipientId:t.ownerId,replyRequired:false});t.state='closed';t.closedAt=now();touch(t);await save();return t;}
  async function run(kind,args){if(!data)fail('state/uninitialized','请先初始化');const action=text(args.action,'action');
    if(kind==='agent'){
      if(action==='list')return {agents:Object.values(data.agents).map(publicAgent)};
      if(action==='get')return publicAgent(agent(args.agentId));
      if(action!=='register')fail('request/invalid','未知agent action');
      if(!['codex','deepseek'].includes(args.side))fail('request/invalid','side必须为codex或deepseek');
      const sid=text(args.sessionId,'sessionId');if(validateAgent)await validateAgent({...args,sessionId:sid});const found=Object.values(data.agents).find(a=>a.side===args.side&&a.sessionId===sid);
      if(found){if(args.agentId&&args.agentId!==found.id)fail('agent/conflict','真实会话已绑定编号');if(args.alias){authenticate(found,args.agentKey);found.alias=text(args.alias,'alias');await save();}return publicAgent(found);}
      const prefix=args.side==='codex'?'CX-':'DS-';const id=args.agentId?text(args.agentId,'agentId'):prefix+randomBytes(5).toString('hex').toUpperCase();
      if(!id.startsWith(prefix)||!/^([A-Z]{2})-[A-Za-z0-9_-]{3,40}$/.test(id))fail('agent/conflict','编号前缀或格式无效');if(data.agents[id])fail('agent/conflict','编号已占用');
      const agentKey=randomBytes(32).toString('hex');const a={id,keyHash:keyHash(agentKey),side:args.side,sessionId:sid,alias:text(args.alias,'alias',true)||id,createdAt:now()};data.agents[id]=a;await save();return {...publicAgent(a),agentKey};
    }
    if(kind!=='task')fail('request/invalid','未知command');const actor=authenticate(agent(args.actorId),args.agentKey);if(args.side&&args.side!==actor.side)fail('task/owner','当前端与agent编号归属不匹配');
    if(action==='list')return {tasks:Object.values(data.tasks).filter(t=>[t.ownerId,t.recipientId].includes(actor.id)&&(args.includeDeleted===true||!t.deleted)).map(copy)};
    if(action==='create'){const t=create(args);await save();return copy(t);}
    if(action==='send'&&!args.taskId){text(args.recipientId,'recipientId 接收方');const req=text(args.requestId,'requestId');const key=actor.id+':'+req,hash=fingerprint({recipientId:args.recipientId,title:args.title??'',content:args.content});const old=data.requests[key];if(old){if(old.hash!==hash)fail('request/conflict','幂等requestId对应不同请求');const t=data.tasks[old.taskId];if(t.events.some(e=>e.phase==='accepted'))return copy(t);if(t.events.length&&t.events.every(e=>e.phase==='failed'))return copy(await send(t));fail('delivery/uncertain','此前请求已登记，结果不确定，请查询taskId');}const t=create(args);data.requests[key]={hash,taskId:t.id};await save();await send(t);return copy(t);}
    if(action==='import'){if(!lookupLegacy)fail('legacy/unsupported','没有可用旧记录来源');const legacyId=text(args.legacyTaskId,'legacyTaskId');const dir=text(args.legacyDirection,'legacyDirection');if(!['codex-to-deepseek','deepseek-to-codex'].includes(dir))fail('legacy/invalid','legacyDirection无效');if((dir==='codex-to-deepseek')!==(actor.side==='codex'))fail('legacy/owner','方向与当前agent不匹配');const existing=Object.values(data.tasks).find(t=>t.legacyTaskId===legacyId&&t.legacyDirection===dir);if(existing){if(existing.ownerId!==actor.id)fail('task/owner','旧记录已由其他agent登记');return copy(existing);}const legacy=await lookupLegacy({legacyTaskId:legacyId,legacyDirection:dir});if(!legacy)fail('legacy/not-found','找不到该旧任务');const t=create({...args,title:legacy.title??'旧桥接任务',content:legacy.content??legacy.summary??''});t.state='imported';t.legacyTaskId=legacyId;t.legacyDirection=dir;t.receipt=copy(legacy.receipt??{state:legacy.state??'unknown'});await save();return copy(t);}
    const readOnly=['get','refresh'].includes(action),ownerOnly=['edit','delete','restore','send','correct','complete','reopen'].includes(action);const t=task(args,ownerOnly,['get','restore'].includes(action));
    if(action==='get')return copy(t);
    if(action==='refresh'){if(readReceipt&&t.receipt){const fresh=await readReceipt({task:copy(t),receipt:copy(t.receipt)});if(fresh)t.receipt=copy(fresh);touch(t);await save();}return copy(t);}
    let correctionRequest;
    if(action==='correct'){
      const key=actor.id+':correct:'+t.id+':'+text(args.requestId,'requestId');
      const hash=fingerprint({taskId:t.id,content:args.content,title:args.title??'',reason:args.reason});
      const old=data.requests[key];
      if(old){
        if(old.hash!==hash)fail('request/conflict','更正requestId对应不同请求');
        const prior=t.events.find(e=>e.type==='correction'&&e.revision===old.revision);
        if(prior?.phase==='accepted')return copy(t);
        if(prior?.phase==='failed'&&(t.deliveryRevision??t.revision)===old.revision)return copy(await send(t,'correction'));
        fail('delivery/uncertain','此前更正已登记，结果不确定，请核对任务事件，不能盲重发');
      }
      correctionRequest={key,hash};
    }
    if(!readOnly)revision(t,args);
    if(action==='edit'){if(t.state==='closed')fail('task/closed','请先reopen');if(t.state!=='draft'&&args.content!==undefined)fail('task/use-correct','已发送内容请用correct更正，不能假编辑');if(args.content!==undefined)t.content=text(args.content,'content');if(args.title!==undefined)t.title=text(args.title,'title');t.history.push({revision:t.revision,kind:'edit',at:now()});t.revision++;if(t.state==='draft')t.deliveryRevision=t.revision;t.confirmations={};t.completion=null;}
    else if(action==='delete'){t.deleted=true;t.revision++;t.deletedAt=now();}
    else if(action==='restore'){t.deleted=false;t.revision++;delete t.deletedAt;}
    else if(action==='send')return copy(await send(t));
    else if(action==='correct'){if(t.state==='draft')fail('task/invalid','草稿请直接edit');if(t.state==='closed')fail('task/closed','请先reopen');text(args.reason,'reason');const content=text(args.content,'content');t.history.push({revision:t.revision,content:t.content,title:t.title,kind:'correction',reason:args.reason,at:now()});t.content=content;if(args.title)t.title=text(args.title,'title');t.revision++;t.deliveryRevision=t.revision;t.confirmations={};t.completion=null;data.requests[correctionRequest.key]={hash:correctionRequest.hash,taskId:t.id,revision:t.revision};await save();return copy(await send(t,'correction'));}
    else if(action==='complete'){if(!['queued','delivered','imported','needs_changes','awaiting_acceptance'].includes(t.state))fail('task/invalid','尚未投递或当前状态不可提交验收');t.completion={revision:t.revision,evidence:text(args.evidence,'evidence 证据'),actorId:actor.id,at:now()};t.confirmations={};t.state='awaiting_acceptance';}
    else if(action==='confirm'){if(t.state==='closed')return copy(t);if(t.state!=='awaiting_acceptance'||!t.completion)fail('task/acceptance','需先提交验收证据');if(!['accepted','rejected'].includes(args.verdict))fail('task/invalid','verdict无效');const evidence=text(args.evidence,'evidence 证据');if(args.verdict==='rejected'){t.state='needs_changes';t.confirmations={};t.rejection={actorId:actor.id,evidence,at:now()};}else {t.confirmations[actor.id]={revision:t.revision,evidence,at:now()};await save();if(t.confirmations[t.ownerId]&&t.confirmations[t.recipientId])return copy(await close(t,actor.id));}}
    else if(action==='close')return copy(await close(t,actor.id));
    else if(action==='reopen'){text(args.reason,'reason');t.history.push({revision:t.revision,kind:'reopen',reason:args.reason,at:now()});t.revision++;t.deliveryRevision=t.revision;t.state='draft';t.confirmations={};t.completion=null;delete t.closedAt;}
    else fail('request/invalid','未知任务action');touch(t);await save();return copy(t);
  }
  return {init,command(kind,args={}){const work=tail.then(async()=>{const before=data?copy(data):undefined,at=generation;try{return await run(kind,args)}catch(e){if(generation===at)data=before;throw e;}});tail=work.catch(()=>{});return work;}};
}


