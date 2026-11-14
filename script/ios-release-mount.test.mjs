import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withIosReleaseMount, withIosReleaseMountAsync } from './ios-release-mount.mjs'
test('failed detach leaves the mount intact and reports the original failure', () => {
  const calls=[]
  assert.throws(()=>withIosReleaseMount('/artifact.dmg','/owned/mount',()=>{throw Error('bad probe')},{run:(bin,args)=>{calls.push(args[0]);if(args[0]==='detach')throw Error('busy')},remove:()=>{calls.push('remove')},warn:()=>{}}),/bad probe/)
  assert.deepEqual(calls,['attach','detach','detach'])
})
test('release cleanup retries detach and removes only the successfully detached empty mount', () => {
  const calls=[];let attempts=0
  withIosReleaseMount('/artifact.dmg','/owned/mount',()=>calls.push('probe'),{run:(bin,args)=>{calls.push(args[0]);if(args[0]==='detach'&&++attempts===1)throw Error('busy')},remove:()=>calls.push('remove'),warn:()=>{}})
  assert.deepEqual(calls,['attach','probe','detach','detach','remove'])
})
test('the async form waits for the inspection before it detaches, and retries a busy detach', async () => {
  const calls=[];let attempts=0
  const result=await withIosReleaseMountAsync('/artifact.dmg','/owned/mount',async()=>{await new Promise(r=>setTimeout(r,5));calls.push('smoke');return 7},{run:(bin,args)=>{calls.push(args[0]);if(args[0]==='detach'&&++attempts===1)throw Error('busy')},remove:()=>calls.push('remove'),warn:()=>{},retryMs:1})
  assert.equal(result,7)
  assert.deepEqual(calls,['attach','smoke','detach','detach','remove'])
})
