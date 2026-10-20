import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const packageDir=process.env.DSH_TOOLS_PACKAGE_DIR;
test('all seven plugin tool schemas pass the installed DSH host assertion', {skip:packageDir ? false : 'DSH_TOOLS_PACKAGE_DIR must point to the installed @deepseek-ai/dsh-tools package'}, async()=>{
  const hostPackage=JSON.parse(await readFile(join(packageDir,'package.json'),'utf8'));
  assert.equal(hostPackage.version,'0.1.5-rc.2','this compatibility check targets the installed host version');
  const hostEntry=pathToFileURL(join(packageDir,'lib','index.js')).href;
  const stubs={
    '@deepseek-ai/cordis':'export class Service {}',
    '@deepseek-ai/schemastery':"const chain=new Proxy(function(){},{get:(_t,p)=>p==='default'?chain:(()=>chain),apply:()=>chain,construct:()=>chain}); const z=new Proxy({}, {get:()=>((..._args)=>chain)}); export default z;",
    '@deepseek-ai/dsh-scope':'export class AnonymousEntries{}; export class NamedEntries{}; export class ScopedLayers{}; export function scopeOf(){return null}; export function scopeTarget(){return null};',
    '@deepseek-ai/dsh-llm':'export class HarnessError extends Error{}; export function createUserMessage(){return {}};',
    '@deepseek-ai/dsh-util-values':'export function assertNever(){throw new Error("unreachable")}; export function deepFreeze(value){return value}; export function isJsonValue(){return true}; export function snapshotJsonValue(value){return value};',
    '@deepseek-ai/dsh-brand':'export function brandString(value){return value};'
  };
  const hook=registerHooks({
    resolve(specifier,context,nextResolve){
      if(specifier==='@deepseek-ai/dsh-tools') return {url:hostEntry,shortCircuit:true};
      if(stubs[specifier]) return {url:'data:text/javascript,'+encodeURIComponent(stubs[specifier]),shortCircuit:true};
      return nextResolve(specifier,context);
    }
  });
  try {
    const dsh=await import(hostEntry);
    assert.equal(typeof dsh.assertSupportedJsonSchema,'function');
    assert.equal(typeof dsh.assertObjectJsonSchema,'function');
    assert.equal(typeof dsh.parameterSchemaSpecToJsonSchema,'function');
    assert.throws(
      ()=>dsh.assertSupportedJsonSchema({type:'object',properties:{reply:{type:['string','null']}}}),
      /single type string.*type arrays are not supported/i,
      'control: the actual installed host rejects type arrays'
    );

    const {registerTools}=await import('../deepseek/lib/tools.mjs');
    const {registerLifecycleTools}=await import('../deepseek/lib/lifecycle-tools.mjs');
    const definitions=[];
    const ctx={tools:{register(definition){
      const parameters=definition.parameters;
      const inputSchema=parameters?.type==='object'
        ? parameters
        : dsh.parameterSchemaSpecToJsonSchema(parameters);
      dsh.assertObjectJsonSchema(inputSchema);
      if(definition.output?.schema) dsh.assertSupportedJsonSchema(definition.output.schema);
      definitions.push({name:definition.name,inputSchema,outputSchema:definition.output?.schema});
      return ()=>{};
    }}};
    const bridge={lifecycle:{command:async()=>({}),isTransportClosed:()=>false}};
    const codexRef={client:{send:async()=>({}),status:async()=>({}),threads:async()=>({})},error:null};
    registerTools(ctx,{bridge,codexRef,store:{dir:resolve('work/dsh-host-compat')},workspaceRoot:process.cwd()});
    registerLifecycleTools(ctx,bridge);

    assert.deepEqual(definitions.map(item=>item.name).sort(),[
      'bridge_agent','bridge_manual','bridge_task',
      'bridge_status','codex_result','codex_task','codex_threads'
    ].sort());
    for(const definition of definitions){
      dsh.assertObjectJsonSchema(definition.inputSchema);
      if(definition.outputSchema) dsh.assertSupportedJsonSchema(definition.outputSchema);
    }
    const peer=JSON.parse(await readFile(new URL('../deepseek/package.json',import.meta.url),'utf8'));
    const declared=peer.peerDependencies?.['@deepseek-ai/dsh-tools']?.split(/\s*\|\|\s*/u)??[];
    assert.ok(declared.includes(hostPackage.version),'peerDependencies must include tested host '+hostPackage.version);
  } finally {
    hook.deregister();
  }
});
