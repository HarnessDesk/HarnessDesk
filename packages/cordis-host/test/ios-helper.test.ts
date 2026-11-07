import test from 'node:test'
import assert from 'node:assert/strict'
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
test('a late reply from a stopped helper cannot settle its replacement', async () => {
  const helper = new IosHelper({ executable: process.execPath, args: ['-e', "process.stdin.on('data',d=>{const q=JSON.parse(d);setTimeout(()=>console.log(JSON.stringify({id:q.id,protocolVersion:1,result:{transport:'dtuhid'}})),200)})"], timeoutMs: 40 })
  await assert.rejects(helper.request(target, {kind:'key',key:'return',count:1}), /time/i)
  await assert.rejects(helper.request(target, {kind:'key',key:'delete',count:1}), /time/i)
  helper.dispose()
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
