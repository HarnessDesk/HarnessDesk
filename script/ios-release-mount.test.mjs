import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withIosReleaseMount } from './ios-release-mount.mjs'
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
