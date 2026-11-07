import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { validateIosAction } from '../src/ios-validation.js'
import { IosHelper } from '../src/ios-helper.js'
import { IosEngine } from '../src/ios-engine.js'
import { iosService, PNG } from './fixtures/ios.js'
const target='11111111-1111-1111-1111-111111111111'
test('permission refusal never reaches the input engine', async () => {
  let calls=0
  const service=iosService({input:{request:async()=>{calls++;return {}}}}, true)
  await assert.rejects(service.interact({kind:'tap',x:0,y:0},target),/ios permission denied/)
  assert.equal(calls,0)
})
test('two callers cannot interleave input and resulting frames', async () => {
  const events:string[]=[]
  const engine=new IosEngine({run:async(_bin,args)=> {
    if(args[1]==='list') return {stdout:JSON.stringify({devices:{iOS:[{udid:target,name:'Fixture',state:'Booted'}]}}),stderr:''}
    if(args[1]==='io' && args[3]==='screenshot') { events.push('frame'); writeFileSync(args[4]!,PNG) }
    return {stdout:'',stderr:''}
  },input:{request:async()=>{events.push('input');await new Promise(r=>setTimeout(r,20));return {}}}})
  await Promise.all([engine.interact({kind:'tap',x:0,y:0},target),engine.interact({kind:'tap',x:0,y:0},target)])
  assert.deepEqual(events,['frame','input','frame','frame','input','frame'])
})
test('invalid actions and stale frame IDs are refused before input', async () => {
  let calls=0
  const engine=new IosEngine({run:async(_bin,args)=> {
    if(args[1]==='list') return {stdout:JSON.stringify({devices:{iOS:[{udid:target,state:'Booted'}]}}),stderr:''}
    if(args[1]==='io' && args[3]==='screenshot') writeFileSync(args[4]!,PNG)
    return {stdout:'',stderr:''}
  },input:{request:async()=>{calls++;return {}}}})
  for(const action of [{kind:'tap',x:NaN,y:0},{kind:'tap',x:1,y:0},{kind:'tap',x:0,y:0,frameId:'stale'},{kind:'drag',path:[{x:0,y:0,tMs:1},{x:0,y:0,tMs:2}]}]) await assert.rejects(engine.interact(action as never,target))
  assert.equal(calls,0)
})
test('an expired invocation cannot deliver queued input', async () => {
  const { withIosInputSignal }=await import('../src/ios-invocation.js')
  let delivered=0
  const engine=new IosEngine({run:async(_bin,args)=>{
    if(args[1]==='list')return {stdout:JSON.stringify({devices:{iOS:[{udid:target,state:'Booted'}]}}),stderr:''}
    if(args[1]==='io' && args[3]==='screenshot')writeFileSync(args[4]!,PNG)
    return {stdout:'',stderr:''}
  },input:{request:async()=>{delivered++;await new Promise(r=>setTimeout(r,40));return {}}}})
  const first=engine.interact({kind:'tap',x:0,y:0},target)
  const controller=new AbortController()
  const expired=withIosInputSignal(controller.signal,()=>engine.interact({kind:'tap',x:0,y:0},target))
  controller.abort()
  await assert.rejects(expired,/abort/i)
  await first
  assert.equal(delivered,1)
})

test('another caller capturing frames preserves a frame until geometry or rotation changes', async () => {
  let rotation='Portrait', width=1, calls=0
  const engine=new IosEngine({run:async(_bin,args)=>{
    if(args[1]==='list')return {stdout:JSON.stringify({devices:{iOS:[{udid:target,state:'Booted'}]}}),stderr:''}
    if(args[3]==='enumerate')return {stdout:`Screen Type: Integrated\nUI Orientation: ${rotation}\n`,stderr:''}
    if(args[3]==='screenshot') {const png=Buffer.from(PNG);png.writeUInt32BE(width,16);writeFileSync(args[4]!,png)}
    return {stdout:'',stderr:''}
  },input:{request:async()=>{calls++;return {}}}})
  const callerA=await engine.frame(target)
  const callerB=await engine.frame(target)
  await engine.interact({kind:'tap',x:0,y:0,frameId:callerA.frameId},target)
  await engine.interact({kind:'tap',x:0,y:0,frameId:callerB.frameId},target)
  rotation='Portrait Upside Down'
  await assert.rejects(engine.interact({kind:'tap',x:0,y:0,frameId:callerA.frameId},target),/stale/)
  rotation='Portrait'; width=2
  await assert.rejects(engine.interact({kind:'tap',x:0,y:0,frameId:callerB.frameId},target),/stale/)
  assert.equal(calls,2)
})
test('text length boundary stays bounded', async () => {
  validateIosAction({kind:'text',text:'A'.repeat(16384)},{width:1,height:1})
  assert.throws(()=>validateIosAction({kind:'text',text:'A'.repeat(16385)},{width:1,height:1}),/16384/)
})

test('only a tap falls back to the measured Simulator window when no native helper was built', async () => {
  const calls: [string, readonly string[]][]=[]
  const engine=new IosEngine({helperPath:'/missing/native/helper', exists:(path: string)=>path==='/opt/homebrew/bin/cliclick',run:async(bin,args)=>{
    calls.push([bin,args])
    if(args[1]==='list')return {stdout:JSON.stringify({devices:{iOS:[{udid:target,state:'Booted'}]}}),stderr:''}
    if(args[3]==='screenshot')writeFileSync(args[4]!,PNG)
    return {stdout:bin==='osascript'?'100, 200, 400, 828':'',stderr:''}
  }} as ConstructorParameters<typeof IosEngine>[0])
  await engine.interact({kind:'tap',x:0,y:0},target)
  assert.ok(calls.some(([bin,args])=>bin==='/opt/homebrew/bin/cliclick'&&args[0]==='c:100,228'))
  calls.length=0
  await assert.rejects(engine.interact({kind:'key',key:'return',count:1},target),/Xcode/)
  assert.equal(calls.some(([bin])=>bin==='osascript'||bin.includes('cliclick')),false)
})
test('legacy tapping still refuses more than one booted simulator', async () => {
  const calls:string[]=[]
  const engine=new IosEngine({helperPath:'/missing/native/helper',exists:()=>true,run:async(bin,args)=>{
    calls.push(bin)
    if(args[1]==='list')return {stdout:JSON.stringify({devices:{iOS:[{udid:target,state:'Booted'},{udid:'22222222-2222-2222-2222-222222222222',state:'Booted'}]}}),stderr:''}
    if(args[3]==='screenshot')writeFileSync(args[4]!,PNG)
    return {stdout:'',stderr:''}
  }} as ConstructorParameters<typeof IosEngine>[0])
  await assert.rejects(engine.interact({kind:'tap',x:0,y:0},target),/More than one/)
  assert.equal(calls.includes('osascript'),false)
})

test('a helper crash cancels input already queued at the engine boundary', async () => {
  const helper=new IosHelper({executable:process.execPath,args:['-e',"process.stdin.once('data',d=>{const q=JSON.parse(d);console.log(JSON.stringify({id:q.id,protocolVersion:1,result:{}}));setImmediate(()=>process.exit(0))})"]})
  let captures=0
  const engine=new IosEngine({input:helper,run:async(_bin,args)=>{
    if(args[1]==='list')return {stdout:JSON.stringify({devices:{iOS:[{udid:target,state:'Booted'}]}}),stderr:''}
    if(args[3]==='screenshot'){ if(++captures===2)await new Promise(r=>setTimeout(r,100));writeFileSync(args[4]!,PNG) }
    return {stdout:'',stderr:''}
  }})
  try {
    const results=await Promise.allSettled([engine.interact({kind:'key',key:'return',count:1},target),engine.interact({kind:'key',key:'delete',count:1},target)])
    assert.equal(results[0]!.status,'fulfilled')
    assert.equal(results[1]!.status,'rejected')
    if(results[1]!.status==='rejected')assert.match(String(results[1]!.reason),/stopped/)
  } finally {engine.dispose()}
})
test('legacy window measurement cannot click after invocation expiry', async () => {
  const {withIosInputSignal}=await import('../src/ios-invocation.js')
  const controller=new AbortController();let clicks=0
  const engine=new IosEngine({helperPath:'/missing/native/helper',exists:()=>true,run:async(bin,args)=>{
    if(args[1]==='list')return {stdout:JSON.stringify({devices:{iOS:[{udid:target,state:'Booted'}]}}),stderr:''}
    if(args[3]==='screenshot')writeFileSync(args[4]!,PNG)
    if(bin==='osascript') {controller.abort();return {stdout:'100, 200, 400, 828',stderr:''}}
    if(bin.includes('cliclick'))clicks++
    return {stdout:'',stderr:''}
  }})
  await assert.rejects(withIosInputSignal(controller.signal,()=>engine.interact({kind:'tap',x:0,y:0},target)),/abort/i)
  assert.equal(clicks,0)
})
test('a failed capture observing rotation revokes old frames even after returning to the original orientation', async () => {
  const rotations=['Portrait','Portrait','Landscape Right','Portrait'];let reads=0,inputs=0
  const engine=new IosEngine({run:async(_bin,args)=>{
    if(args[1]==='list')return {stdout:JSON.stringify({devices:{iOS:[{udid:target,state:'Booted'}]}}),stderr:''}
    if(args[3]==='enumerate')return {stdout:`Screen Type: Integrated\nUI Orientation: ${rotations[reads++]??'Portrait'}\n`,stderr:''}
    if(args[3]==='screenshot')writeFileSync(args[4]!,PNG)
    return {stdout:'',stderr:''}
  },input:{request:async()=>{inputs++;return {}}}})
  const first=await engine.frame(target)
  await assert.rejects(engine.frame(target),/orientation/)
  await assert.rejects(engine.interact({kind:'tap',x:0,y:0,frameId:first.frameId},target),/stale/)
  assert.equal(inputs,0)
})
