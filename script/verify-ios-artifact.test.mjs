import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyIosArtifact } from './verify-ios-artifact.mjs'
const signed='TeamIdentifier=DEMO123\nflags=0x10000(runtime)\n'
test('artifact verifier rejects architecture, signature and framework-load failures', () => {
  for (const broken of ['arch','signature','team','runtime','probe']) {
    assert.throws(()=>verifyIosArtifact('/synthetic/HarnessDesk.app','arm64',{helpers:()=>['/synthetic/HarnessDesk.app/Contents/Resources/native/ios/hd-ios-control'],run:(bin,args)=>{
      if(bin==='lipo') return broken==='arch'?'x86_64':'arm64'
      if(bin==='codesign' && args.includes('--verify') && broken==='signature') throw Error('invalid signature')
      if(bin==='codesign') return broken==='team' && args.at(-1).endsWith('hd-ios-control')?signed.replace('DEMO123','OTHER'):broken==='runtime'?signed.replace('(runtime)',''):signed
      return JSON.stringify({protocolVersion:1,frameworks:broken==='probe'?'unavailable':'available'})
    }}))
  }
})
test('artifact verifier executes the actual signed helper probe', () => {
  const calls=[]
  verifyIosArtifact('/synthetic/HarnessDesk.app','arm64',{helpers:()=>['/synthetic/HarnessDesk.app/Contents/Resources/native/ios/hd-ios-control'],run:(bin,args)=>{calls.push([bin,...args]);return bin==='lipo'?'arm64':bin==='codesign'?signed:JSON.stringify({protocolVersion:1,frameworks:'available'})}})
  assert.ok(calls.some(c=>c[0].endsWith('/Contents/Resources/native/ios/hd-ios-control') && c[1]==='--probe'))
})
test('artifact verifier rejects any second helper anywhere in the bundle', () => {
  const helper='/synthetic/HarnessDesk.app/Contents/Resources/native/ios/hd-ios-control'
  assert.throws(()=>verifyIosArtifact('/synthetic/HarnessDesk.app','arm64',{helpers:()=>[helper,'/synthetic/HarnessDesk.app/Contents/Resources/app.asar.unpacked/node_modules/@harnessdesk/cordis-host/dist/native/darwin-x64/hd-ios-control'],run:(bin)=>bin==='lipo'?'arm64':bin==='codesign'?signed:JSON.stringify({protocolVersion:1,frameworks:'available'})}),/only|duplicate|extra/i)
})
