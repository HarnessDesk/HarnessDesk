import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalBytes } from './profile-scalars.mjs'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

test('canonical size counts sorted versioned UTF-8 without returning a body', () => {
  assert.equal(canonicalBytes([{z:'é',a:{z:1,a:'🙂'}}]), Buffer.byteLength('v1:[{"a":{"a":"🙂","z":1},"z":"é"}]'))
  assert.equal(canonicalBytes([]), 5)
})

test('canonical source is exactly the reviewed implementation', () => {
  const source = readFileSync(new URL('../../packages/protocol/src/canonical-transcript.ts', import.meta.url))
  assert.equal(createHash('sha256').update(source).digest('hex'), '67037c20924ec2f68178911374b8a5a5afa44da74e03f236f18b9cb8d427ea56')
})

test('checkpoint keeps eligibility unknown while separating known and protected bodies', async () => {
  const { summarize } = await import('./profile-scalars.mjs')
  const sessions = new Map([['w',{itemsLoaded:true,turns:[]}],['v',{itemsLoaded:true,turns:[]}],['d',{itemsLoaded:true,turns:[]}],['p',{itemsLoaded:true,turns:[]}]])
  const result=summarize(sessions,['w'],['v','d','p'],canonicalBytes)
  assert.deepEqual(result,{knownWorkloadLoaded:1,knownWorkloadBytes:5,protectedSentinels:3,protectedBytes:15,protectedBytesByKind:{visible:5,draft:5,pending:5}})
  sessions.set('p',{itemsLoaded:false,turns:[]})
  assert.throws(()=>summarize(sessions,['w'],['v','d','p'],canonicalBytes),/sentinel/)
})
