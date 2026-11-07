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
