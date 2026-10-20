import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';

const hook=registerHooks({resolve(specifier,context,nextResolve){
  if(specifier==='@deepseek-ai/dsh-tools') return {url:'data:text/javascript,export const parameterSchemaSpecToJsonSchema=x=>x;',shortCircuit:true};
  return nextResolve(specifier,context);
}});

test('a codex tool registration failure keeps lifecycle tools available and appears in health',async t=>{
  const {apply}=await import('../deepseek/index.js');
  const work=resolve('work/dsh-registration-errors');
  await mkdir(work,{recursive:true});
  const stateDir=await mkdtemp(join(work,'run-'));
  const registered=[];
  const warnings=[];
  let routeHandler;
  let cleanup;
  t.after(async()=>{
    hook.deregister();
    cleanup?.();
    await rm(stateDir,{recursive:true,force:true});
  });

  const ctx={
    effect(fn){cleanup=fn();return ()=>{};},
    logger:{info(){},warn(value){warnings.push(String(value));}},
    tools:{register(definition){
      if(definition.name==='codex_task') throw new Error('host schema unsupported');
      registered.push(definition.name);
      return ()=>{};
    }},
    webServer:{getOrigin(){return undefined;},register(route){routeHandler=route.handler;return ()=>{};}},
    sessionController:{list:async()=>({items:[]})},
  };
  apply(ctx,{stateDir,prefix:'/agent-bridge',workspaceRoot:process.cwd()});

  assert.ok(['bridge_agent','bridge_task','bridge_manual'].every(name=>registered.includes(name)),
    'bridge lifecycle tools should register even when Codex tool registration fails');
  assert.ok(warnings.some(value=>value.includes('codex tool registration failed')),
    'the failed group should produce an explicit warning');

  let token;
  for(let attempt=0;attempt<100;attempt++){
    try{token=(await readFile(join(stateDir,'token'),'utf8')).trim();break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.ok(token,'bridge init should write its token');
  assert.equal(typeof routeHandler,'function');
  const response={writableEnded:false,writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body;this.writableEnded=true;}};
  await routeHandler({method:'GET',url:'/agent-bridge/health',headers:{host:'example.invalid',authorization:`Bearer ${token}`}},response);
  assert.equal(response.status,200);
  const health=JSON.parse(response.body).value;
  assert.deepEqual(health.toolRegistrationErrors,{codexTools:'host schema unsupported',lifecycleTools:null});
  let initialized=false;
  for(let attempt=0;attempt<100;attempt++){
    try{await readFile(join(stateDir,'lifecycle.json'),'utf8');initialized=true;break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.ok(initialized,'bridge initialization should finish before fixture cleanup');
});
