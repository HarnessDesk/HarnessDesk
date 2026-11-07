import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
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
    if(args[1]==='io') { events.push('frame'); writeFileSync(args[4]!,PNG) }
    return {stdout:'',stderr:''}
  },input:{request:async()=>{events.push('input');await new Promise(r=>setTimeout(r,20));return {}}}})
  await Promise.all([engine.interact({kind:'tap',x:0,y:0},target),engine.interact({kind:'tap',x:0,y:0},target)])
  assert.deepEqual(events,['frame','input','frame','frame','input','frame'])
})
test('invalid actions and stale frame IDs are refused before input', async () => {
  let calls=0
  const engine=new IosEngine({run:async(_bin,args)=> {
    if(args[1]==='list') return {stdout:JSON.stringify({devices:{iOS:[{udid:target,state:'Booted'}]}}),stderr:''}
    if(args[1]==='io') writeFileSync(args[4]!,PNG)
    return {stdout:'',stderr:''}
  },input:{request:async()=>{calls++;return {}}}})
  for(const action of [{kind:'tap',x:NaN,y:0},{kind:'tap',x:1,y:0},{kind:'tap',x:0,y:0,frameId:'stale'},{kind:'drag',path:[{x:0,y:0,tMs:1},{x:0,y:0,tMs:2}]}]) await assert.rejects(engine.interact(action as never,target))
  assert.equal(calls,0)
})
