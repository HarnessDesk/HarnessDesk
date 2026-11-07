import { test } from 'node:test'
import assert from 'node:assert/strict'
import { proofEnvironment, measureProofEnvironment } from './ios-proof-environment.mjs'
test('native proof records measured Xcode and target runtime and picks the host architecture', () => {
  const result=proofEnvironment({devices:{'runtime-fixture':[{udid:'owned'}],'runtime-other':[{udid:'other'}]}},{runtimes:[{identifier:'runtime-fixture',name:'iOS fixture version'}]},'owned','Xcode 28.2\nBuild version 28B123\n','x64')
  assert.equal(result.runtime,'iOS fixture version')
  assert.equal(result.xcode,'Xcode 28.2\nBuild version 28B123')
  assert.match(result.helper,/darwin-x64\/hd-ios-control$/)
})

test('proof environment probes the selected Xcode and runtime inventory', async () => {
  const calls=[]
  const result=await measureProofEnvironment({devices:{devices:{runtime:[{udid:'owned'}]}},udid:'owned',arch:'arm64',run:async(bin,args)=>{
    calls.push([bin,...args])
    return {stdout:bin==='xcodebuild'?'Xcode 27.9\nBuild version fixture':JSON.stringify({runtimes:[{identifier:'runtime',name:'iOS measured'}]})}
  }})
  assert.equal(result.runtime,'iOS measured')
  assert.equal(result.xcode,'Xcode 27.9\nBuild version fixture')
  assert.deepEqual(calls,[['xcodebuild','-version'],['xcrun','simctl','list','runtimes','-j']])
})
