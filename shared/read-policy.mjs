// Peer-authored content is delivered as a message, never pulled during open work.
const clone = value => structuredClone(value);
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, clone(value[key])]));

export function hasVerifiedClosure(task) {
  if (task?.state !== 'closed' || !task.closedAt || !task.completion) return false;
  const revision = task.completion.revision;
  if (!Number.isInteger(revision) || revision < 1) return false;
  if (task.confirmations?.[task.ownerId]?.revision !== revision || task.confirmations?.[task.recipientId]?.revision !== revision) return false;
  return task.events?.some(event => event.type === 'closed' && event.revision === revision && event.phase === 'accepted' && event.replyRequired === false) === true;
}

function receiptView(value) {
  if (!value) return null;
  return pick(value, ['state','transportTaskId','side','replyRequired']);
}

export function taskView(task, actorId) {
  if (hasVerifiedClosure(task)) return {...clone(task), readPolicy:'closed-archive', archiveAvailable:true};
  const own = task.ownerId === actorId;
  const result = {
    ...pick(task, ['id','ownerId','recipientId','revision','deliveryRevision','state','deleted','createdAt','updatedAt','deletedAt','closedAt','legacyTaskId','legacyDirection']),
    readPolicy:'push-only-until-closed', archiveAvailable:false, contentAvailable:own,
    nextAction:'等待对方主动投递消息；不要轮询正文或改读对方会话、日志、报告文件。',
    ...(own ? pick(task,['title','content','history']) : {history:(task.history ?? []).map(item => pick(item,['revision','kind','at']))}),
    events:(task.events ?? []).map(event => ({...pick(event,['id','type','revision','phase','replyRequired','at']),receipt:receiptView(event.receipt),...(event.error ? {error:pick(event.error,['code'])} : {})})),
    receipt:receiptView(task.receipt),
    completion:task.completion ? pick(task.completion, task.completion.actorId === actorId ? ['revision','actorId','at','evidence'] : ['revision','actorId','at']) : null,
    confirmations:Object.fromEntries(Object.entries(task.confirmations ?? {}).map(([id,record]) => [id,pick(record,id === actorId ? ['revision','at','evidence'] : ['revision','at'])])),
    ...(task.rejection ? {rejection:pick(task.rejection,task.rejection.actorId === actorId ? ['actorId','at','evidence'] : ['actorId','at'])} : {}),
  };
  return result;
}

export function taskResultView(value, actorId) {
  if (Array.isArray(value?.tasks)) return {tasks:value.tasks.map(task => taskView(task,actorId))};
  if (typeof value?.id === 'string' && value.state) return taskView(value,actorId);
  return {readPolicy:'push-only-until-closed',archiveAvailable:false,...pick(value,['state'])};
}

export function legacyResultView(task, archiveAllowed = false) {
  const meta = pick(task,['taskId','threadId','delivery','state','sessionId','cwd','title','summary','status','createdAt','updatedAt','turnSeq','matched','waitedMs']);
  return {
    ...meta,
    reply:archiveAllowed ? clone(task.reply ?? null) : null,
    turnEnd:archiveAllowed ? clone(task.turnEnd ?? null) : (task.turnEnd ? pick(task.turnEnd,['at']) : null),
    ...(task.error ? {error:archiveAllowed ? clone(task.error) : pick(task.error,['code'])} : {}),
    archiveAvailable:archiveAllowed,
    readPolicy:archiveAllowed ? 'closed-archive' : 'push-only-until-closed',
    ...(archiveAllowed ? {} : {nextAction:'等待 DeepSeek 使用 codex_task 向指定 Codex 聊天主动发送回报；禁止轮询正文或读取对方会话/报告文件。'}),
  };
}
