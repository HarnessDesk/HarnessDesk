import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import * as verifier from '../../../script/verify-ios-artifact.mjs'

function fixture(t) {
  const scratch=fileURLToPath(new URL('../../../output/ios-input/',import.meta.url))
  mkdirSync(scratch,{recursive:true})
  const root=mkdtempSync(join(scratch,'smoke-unique-')),app=join(root,'HarnessDesk.app')
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const add=path=>{const file=join(app,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,'synthetic unsigned file');return file}
  const helper=add('Contents/Resources/native/ios/hd-ios-control')
  return {app,helper,add}
}
test('smoke uniqueness accepts the single unsigned resource and refuses missing or extra helpers', t=>{
  const {app,helper,add}=fixture(t)
  assert.equal(typeof verifier.verifyIosHelperUniqueness,'function','the unsigned smoke check is shared with release verification')
  assert.equal(verifier.verifyIosHelperUniqueness(app),helper)
  for(const path of [
    'Contents/Resources/app.asar.unpacked/node_modules/@harnessdesk/cordis-host/native/ios-control/.build/out/Products/Debug/hd-ios-control',
    'Contents/Resources/app.asar.unpacked/node_modules/@harnessdesk/cordis-host/native/ios-control/.build/out/Products/Release/hd-ios-control.dSYM/Contents/Resources/DWARF/hd-ios-control',
  ]) {
    const extra=add(path)
    assert.throws(()=>verifier.verifyIosHelperUniqueness(app),/only hd-ios-control|extra helpers/)
    rmSync(extra)
  }
  rmSync(helper)
  assert.throws(()=>verifier.verifyIosHelperUniqueness(app),/only hd-ios-control|extra helpers/)
  add('Contents/Resources/app.asar.unpacked/node_modules/@harnessdesk/cordis-host/native/ios-control/.build/out/Products/Release/hd-ios-control')
  assert.throws(()=>verifier.verifyIosHelperUniqueness(app),/only hd-ios-control|extra helpers/)
})
test('smoke CLI refuses duplicate helpers before executing a bundle binary', t=>{
  const {app,add}=fixture(t)
  add('Contents/MacOS/HarnessDesk')
  add('Contents/Resources/ui/index.html')
  add('Contents/Resources/app.asar.unpacked/node_modules/@harnessdesk/cordis-host/native/ios-control/.build/out/Products/Release/hd-ios-control')
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./smoke-packaged.mjs',import.meta.url)),app],{encoding:'utf8',timeout:5000})
  assert.equal(result.status,1)
  assert.match(result.stderr,/only hd-ios-control|extra helpers/)
  assert.doesNotMatch(result.stderr,/signing|TeamIdentifier/)
})
test('smoke CLI refuses an app without its interface before executing a bundle binary', t=>{
  const {app,add}=fixture(t)
  add('Contents/MacOS/HarnessDesk')
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./smoke-packaged.mjs',import.meta.url)),app],{encoding:'utf8',timeout:5000})
  assert.equal(result.status,1)
  assert.match(result.stderr,/Contents\/Resources\/ui\/index\.html is missing/)
  assert.doesNotMatch(result.stdout,/iOS input helper/)
})
