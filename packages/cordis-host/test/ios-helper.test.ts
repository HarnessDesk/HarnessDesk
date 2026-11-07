import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { IosHelper } from '../src/ios-helper.js'
const target = '11111111-1111-1111-1111-111111111111'
test('helper rejects malformed and version-mismatched replies', async () => {
  for (const reply of ['not JSON', '{"id":"1","protocolVersion":2,"result":{}}']) {
    const helper = new IosHelper({ executable: process.execPath, args: ['-e', `process.stdin.once('data',()=>process.stdout.write(${JSON.stringify(reply+'\n')}))`] })
    await assert.rejects(helper.request(target, { kind: 'key', key: 'return', count: 1 }), /protocol|reply/i)
    helper.dispose()
  }
})
test('timeout terminates only the helper child it owns', async () => {
  const helper = new IosHelper({ executable: process.execPath, args: ['-e', 'process.stdin.resume()'], timeoutMs: 30 })
  await assert.rejects(helper.request(target, { kind: 'text', text: 'synthetic' }), /time/i)
  helper.dispose()
})
function fakeChild() {
  return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true, exitCode: null, signalCode: null }) as unknown as ChildProcessWithoutNullStreams
}
function reply(child: ChildProcessWithoutNullStreams, id: string, transport: string) { child.stdout.emit('data', Buffer.from(JSON.stringify({ id, protocolVersion: 1, result: { transport } })+'\n')) }
test('a late reply from a stopped helper cannot settle its replacement', async () => {
  const old = fakeChild(), next = fakeChild()
  let spawns=0
  const helper = new IosHelper({ executable: process.execPath, spawn: (()=>++spawns===1?old:next) as unknown as typeof spawn, timeoutMs: 1000 } as never)
  const controller = new AbortController()
  const first=helper.request(target,{kind:'key',key:'return',count:1},undefined,controller.signal)
  await new Promise<void>(resolve=>old.stdin.once('data',()=>resolve()))
  controller.abort(); await assert.rejects(first,/ended/)
  const replacement=helper.request(target,{kind:'key',key:'delete',count:1})
  await new Promise<void>(resolve=>next.stdin.once('data',()=>resolve()))
  reply(old,'2','stale')
  reply(next,'2','replacement')
  assert.equal((await replacement)['transport'],'replacement')
  helper.dispose()
})
test('a helper exiting after a reply rejects the queued request without unhandled stream errors', async () => {
  const child=fakeChild()
  const helper=new IosHelper({executable:process.execPath,spawn:(()=>child) as unknown as typeof spawn} as never)
  let count=0
  child.stdin.on('data',()=>{
    if(++count===1) reply(child,'1','first')
    else queueMicrotask(()=>{ child.emit('exit',1); child.stdin.emit('error',Error('EPIPE')); child.stdout.emit('error',Error('closed')) })
  })
  try {
    assert.equal((await helper.request(target,{kind:'key',key:'return',count:1}))['transport'],'first')
    assert.ok(child.stdin.listenerCount('error')>0, 'stdin errors have an owned handler')
    assert.ok(child.stdout.listenerCount('error')>0, 'stdout errors have an owned handler')
    await assert.rejects(helper.request(target,{kind:'key',key:'return',count:1}),/stopped|closed/)
  } finally { helper.dispose() }
})
test('cancellation gives the owned helper time to flush releases before SIGKILL', async () => {
  let child: ChildProcessWithoutNullStreams | undefined
  const helper=new IosHelper({executable:process.execPath,spawn:((...args: Parameters<typeof spawn>)=>{child=spawn(...args) as ChildProcessWithoutNullStreams;return child}) as unknown as typeof spawn,args:['-e',"setInterval(()=>{},1000);process.on('SIGTERM',()=>setTimeout(()=>{console.log('released');process.exit(0)},600));process.stdin.once('data',()=>console.log(JSON.stringify({id:'1',protocolVersion:1,result:{}})))"]} as never)
  await helper.request(target,{kind:'key',key:'return',count:1})
  let released=false
  child!.stdout.on('data',d=>{if(String(d).includes('released'))released=true})
  const stopped=new Promise(resolve=>child!.once('exit',resolve))
  helper.dispose(); await stopped
  assert.equal(released,true)
})
test('only measured geometry crosses native stdio, never screenshot bytes', async () => {
  const helper = new IosHelper({ executable: process.execPath, args: ['-e', "process.stdin.on('data',d=>{const q=JSON.parse(d);console.log(JSON.stringify({id:q.id,protocolVersion:1,result:{keys:Object.keys(q.geometry).sort()}}))})"] })
  try {
    const result=await helper.request(target,{kind:'tap',x:0,y:0},{width:1,height:1,rotation:0,url:'private-image-bytes'} as never)
    assert.deepEqual(result['keys'],['height','rotation','width'])
  } finally { helper.dispose() }
})
test('queued devices receive their timeout only when native dispatch starts', async () => {
  const source="const r=require('node:readline').createInterface({input:process.stdin});let tail=Promise.resolve();r.on('line',line=>{const q=JSON.parse(line);tail=tail.then(()=>new Promise(resolve=>setTimeout(()=>{console.log(JSON.stringify({id:q.id,protocolVersion:1,result:{ok:true}}));resolve()},900)))})"
  const helper=new IosHelper({executable:process.execPath,args:['-e',source],timeoutMs:1500})
  try { assert.equal((await Promise.all([1,2,3].map(()=>helper.request(target,{kind:'key',key:'return',count:1})))).length,3) }
  finally {helper.dispose()}
})

test('maximum text receives a work-scaled deadline rather than timing out at the base budget', async () => {
  const helper=new IosHelper({executable:process.execPath,args:['-e',"process.stdin.once('data',d=>{const q=JSON.parse(d);setTimeout(()=>console.log(JSON.stringify({id:q.id,protocolVersion:1,result:{length:q.action.text.length}})),180)})"],timeoutMs:100})
  try { assert.equal((await helper.request(target,{kind:'text',text:'A'.repeat(16384)}))['length'],16384) }
  finally {helper.dispose()}
})

test('a crash after the first reply rejects already queued input without replaying it in a replacement', async () => {
  let spawns=0
  const helper=new IosHelper({executable:process.execPath,spawn:(()=>{
    spawns++
    const child=fakeChild()
    child.stdin.on('data',d=>{const q=JSON.parse(String(d));reply(child,q.id,'reply');child.emit('exit',0)})
    return child
  }) as unknown as typeof spawn})
  const first=helper.request(target,{kind:'key',key:'return',count:1})
  const queued=helper.request(target,{kind:'key',key:'delete',count:1})
  const refused=assert.rejects(queued,/stopped/)
  await first; await refused
  assert.equal(spawns,1)
  helper.dispose()
})
