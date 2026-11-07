import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ExtensionKernel, type IosCapability } from '@harnessdesk/cordis-host'
import { SupervisedExtensionHost } from '../src/index.js'
import { answerIosCall } from '../src/ios.js'
const FIXTURES=fileURLToPath(new URL('./fixtures',import.meta.url))
test('installed simulator calls require the parent invocation and manifest permission',async()=> {
  const scratch=fileURLToPath(new URL('../../../../output/ios-input/',import.meta.url)); await mkdir(scratch,{recursive:true})
  for(const granted of [true,false]) {
    let calls=0
    const dir=await mkdtemp(join(scratch,'plugin-'))
    const store=join(dir,'plugins'),plugin=join(store,'iosish')
    await cp(join(FIXTURES,'plugin-ios'),plugin,{recursive:true})
    if(!granted) { const path=join(plugin,'harnessdesk.plugin.json');const manifest=JSON.parse(await readFile(path,'utf8'));manifest.permissions.ios=false;await writeFile(path,JSON.stringify(manifest)) }
    const engine={interact:async()=> {calls++;return {udid:'11111111-1111-1111-1111-111111111111',frameId:'receipt',width:1,height:1,mimeType:'image/png',url:'data:image/png;base64,'}},devices:async()=>{calls++;return []}} as unknown as IosCapability
    const host=new SupervisedExtensionHost(new ExtensionKernel(),{env:{HARNESSDESK_PLUGINS:store},iosEngine:engine})
    try {
      await host.loadInstalledPlugins()
      const honest=host.list('tool').find(x=>x.name==='ios_honest')!
      const result=await host.invokeTool(honest.id,{},{})
      assert.equal(result.ok,granted,JSON.stringify(result))
      assert.equal(calls,granted?1:0)
      if(granted) {
        const manifestPath=join(plugin,'harnessdesk.plugin.json')
        const manifest=JSON.parse(await readFile(manifestPath,'utf8'));manifest.permissions.ios=false
        await writeFile(manifestPath,JSON.stringify(manifest))
        const revoked=await host.invokeTool(honest.id,{},{})
        assert.equal(revoked.ok,false,'The parent must consult the installed manifest, not the child snapshot.')
        assert.equal(calls,1)
      }
      const forged=host.list('tool').find(x=>x.name==='ios_forged')!
      await host.invokeTool(forged.id,{},{})
      assert.equal(calls,granted?1:0,'A forged request must not reach the engine.')
    } finally {await host.dispose();await rm(dir,{recursive:true,force:true})}
  }
})
test('IPC rejects helper paths and arbitrary commands',async()=> {
  const engine={} as IosCapability
  await assert.rejects(answerIosCall(engine,{method:'spawn',args:['/bin/sh']} as never),/Unknown/)
  await assert.rejects(answerIosCall(engine,{method:'boot',args:['booted']} as never),/UUID/)
})
test('optional targets and iOS access survive commands, hooks and context entrypoints',async()=> {
  const scratch=fileURLToPath(new URL('../../../../output/ios-input/',import.meta.url));await mkdir(scratch,{recursive:true})
  const dir=await mkdtemp(join(scratch,'entrypoints-')), store=join(dir,'plugins')
  await cp(join(FIXTURES,'plugin-ios'),join(store,'iosish'),{recursive:true})
  let calls=0
  const frame={udid:'11111111-1111-1111-1111-111111111111',frameId:'fixture',width:1,height:1,mimeType:'image/png',url:'data:image/png;base64,'}
  const engine={devices:async()=>{calls++;return []},frame:async(udid?:string)=>{assert.equal(udid,undefined);calls++;return frame},interact:async(_action:unknown,udid?:string)=>{assert.equal(udid,undefined);calls++;return frame}} as unknown as IosCapability
  const host=new SupervisedExtensionHost(new ExtensionKernel(),{env:{HARNESSDESK_PLUGINS:store},iosEngine:engine})
  try {
    await host.loadInstalledPlugins()
    assert.equal(await host.runCommand('ios_command','',{}),true)
    assert.equal((await host.resolveContext({})).length,1)
    const provider=host.list('context')[0]!
    assert.ok(await host.resolveOne(provider.id,undefined,{}))
    assert.equal((await host.runHooks({event:'preTurn',scope:{}})).decision,'allow')
    const tool=host.list('tool').find(t=>t.name==='ios_implicit')!
    const result=await host.invokeTool(tool.id,{},{})
    assert.equal(result.ok,true,JSON.stringify(result))
    assert.equal(calls,6)
  } finally {await host.dispose();await rm(dir,{recursive:true,force:true})}
})
test('installed maximum-length text outlives both generic IPC deadlines', {timeout:45000}, async()=> {
  const scratch=fileURLToPath(new URL('../../../../output/ios-input/',import.meta.url));await mkdir(scratch,{recursive:true})
  const dir=await mkdtemp(join(scratch,'text-deadline-')),store=join(dir,'plugins'),plugin=join(store,'iosish')
  await cp(join(FIXTURES,'plugin-ios'),plugin,{recursive:true})
  const source=join(plugin,'index.js')
  await writeFile(source,(await readFile(source,'utf8')).replace('apply(ctx) {',`apply(ctx) {
    ctx.tools.register({name:'ios_text_boundary',description:'Synthetic bounded text.',inputSchema:{type:'object',properties:{}},execute:async()=>JSON.stringify(await ctx.ios.interact({kind:'text',text:'A'.repeat(16384)}))})`))
  let completed=false, finish=()=>{}, timer:ReturnType<typeof setTimeout>|undefined
  const engine={interact:async(action:{kind:string;text:string})=>{
    assert.equal(action.kind,'text');assert.equal(action.text.length,16384)
    await new Promise<void>(resolve=>{finish=resolve;timer=setTimeout(resolve,31000)})
    completed=true
    return {udid:'11111111-1111-1111-1111-111111111111',frameId:'text',width:1,height:1,mimeType:'image/png',url:'data:image/png;base64,'}
  }} as unknown as IosCapability
  const host=new SupervisedExtensionHost(new ExtensionKernel(),{env:{HARNESSDESK_PLUGINS:store},iosEngine:engine,invokeTimeoutMs:1000})
  try {
    await host.loadInstalledPlugins()
    const result=await host.invokeTool(host.list('tool').find(t=>t.name==='ios_text_boundary')!.id,{},{})
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(completed,true)
  } finally {clearTimeout(timer);finish();await host.dispose();await rm(dir,{recursive:true,force:true})}
})
test('only bounded validated input can extend the installed operation deadline', async()=> {
  const {iosInteractionTimeoutMs}=await import('@harnessdesk/cordis-host')
  const maximum=iosInteractionTimeoutMs({kind:'text',text:'A'.repeat(16384)})
  assert.ok(maximum>30000 && maximum<900000)
  assert.throws(()=>iosInteractionTimeoutMs({kind:'text',text:'A'.repeat(16385)}),/16384/)
  assert.throws(()=>iosInteractionTimeoutMs({kind:'longPress',x:0,y:0,durationMs:10001}),/duration/)
})
