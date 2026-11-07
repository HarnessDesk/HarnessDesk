import { test } from 'node:test'
import assert from 'node:assert/strict'
import { testIosControl } from './test-ios-control.mjs'
test('Swift gate skips Linux and unavailable or older Xcode with a reason', () => {
  for (const [platform, version] of [['linux',''],['darwin','Xcode 26.4'],['darwin','']]) {
    const messages=[],calls=[]
    testIosControl({platform,log:m=>messages.push(m),run:(bin,args)=>{calls.push([bin,...args]);return {status:version?0:1,stdout:version}}})
    assert.match(messages.join(' '),/skip.*macOS|skip.*Xcode 27/i)
    assert.equal(calls.some(c=>c[0]==='swift'),false)
  }
})
test('Swift gate runs the native suite on Xcode 27 and propagates failure', () => {
  for(const status of [0,1]) {
    const calls=[]
    const run=(bin,args)=>{calls.push([bin,...args]);return {status:bin==='swift'?status:0,stdout:bin==='xcodebuild'?'Xcode 27.1\nBuild version 27A9275':''}}
    if(status)assert.throws(()=>testIosControl({platform:'darwin',run,log:()=>{}}),/Swift/)
    else testIosControl({platform:'darwin',run,log:()=>{}})
    assert.deepEqual(calls.at(-1),['swift','test','--package-path','packages/cordis-host/native/ios-control'])
  }
})
