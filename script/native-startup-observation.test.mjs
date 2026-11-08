import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const markerText = 'HarnessDesk isolated native UI-system rig\n'
function fixture(kind) {
  const root = mkdtempSync(join(tmpdir(), 'hd-native-observation-test-'))
  for (const dir of ['e2e/ui-system', 'script/lib', 'script/shots']) mkdirSync(join(root, dir), { recursive: true })
  copyFileSync(join(source, 'e2e/ui-system/native-smoke.mjs'), join(root, 'e2e/ui-system/native-smoke.mjs'))
  const helper = join(source, 'script/lib/native-startup-log.mjs')
  if (existsSync(helper)) copyFileSync(helper, join(root, 'script/lib/native-startup-log.mjs'))
  writeFileSync(join(root, 'script/lib/desk.mjs'), "export class Cdp {}\nexport const closeDesk=()=>{},launchDesk=()=>{},sleep=()=>{},STORE='',waitForSnapshot=()=>{}\n")
  writeFileSync(join(root, 'script/shots/audit.mjs'), "export const COLLECT={},textReasons=()=>[],USER={}\n")
  writeFileSync(join(root, 'script/lib/temporary-directory.mjs'), "import {rmSync} from 'node:fs';export function removeTemporaryDirectory(p){if(process.env.SYNTH_CASE==='cleanup-error')throw new Error('synthetic cleanup failure');rmSync(p,{recursive:true,force:true});return true}\n")
  writeFileSync(join(root, 'script/shots/seed.mjs'), "import {mkdirSync,writeFileSync} from 'node:fs';mkdirSync(process.env.HD_SHOTS_HOME,{recursive:true});writeFileSync('rig-home.txt',process.env.HD_SHOTS_HOME)\n")
  writeFileSync(join(root, 'script/shots/shoot.mjs'), `import {writeFileSync,symlinkSync,mkdirSync} from 'node:fs';import {join} from 'node:path';import {recordNativeStartupExit} from '../lib/native-startup-log.mjs';const h=process.env.HD_SHOTS_HOME,k=process.env.SYNTH_CASE;if(k==='symlink'||k==='exit-symlink'){writeFileSync('decoy.txt','private decoy must not be copied');symlinkSync(join(process.cwd(),'decoy.txt'),join(h,k==='symlink'?'app.log':'startup-exit.json'))}if(k==='capture-error'){mkdirSync('decoy-dir');symlinkSync(join(process.cwd(),'decoy-dir'),join(process.cwd(),'output/native-ui-system/startup-diagnostics'))}if(k!=='missing'&&k!=='symlink')writeFileSync(join(h,'app.log'),k==='large'?'A'.repeat(70000)+'SYNTHETIC-END':'synthetic startup refusal\\n');const error=Object.assign(new Error('synthetic'),{exitCode:k==='signal'?null:17,signalCode:k==='signal'?'SIGTERM':null});recordNativeStartupExit(h,k==='cleanup-error'?new AggregateError([error,new Error('synthetic secondary')]):error);process.stderr.write('synthetic shoot failure\\n');process.exit(17)\n`)

  const child = spawnSync(process.execPath, [join(root, 'e2e/ui-system/native-smoke.mjs')], { cwd: root, encoding: 'utf8', timeout: 15000, env: { ...process.env, SYNTH_CASE: kind } })
  const home = readFileSync(join(root, 'rig-home.txt'), 'utf8'), rig = dirname(home)
  const output = join(root, 'output/native-ui-system/startup-diagnostics')
  return { root, rig, child, output, clean() {
    if (existsSync(rig)) { assert.equal(readFileSync(join(rig, '.harnessdesk-ui-system-rig'), 'utf8'), markerText); rmSync(rig, { recursive: true, force: true }) }
    rmSync(root, { recursive: true, force: true })
  } }
}
for (const [kind, status] of [['refusal', 'saved'], ['missing', 'missing'], ['large', 'saved'], ['symlink', 'refused'], ['signal', 'saved'], ['exit-symlink', 'saved']]) test(`preserves ${kind} startup observation and original failure`, () => {
  const f = fixture(kind)
  try {
    assert.notEqual(f.child.status, 0); assert.match(f.child.stderr, /synthetic shoot failure/)
    assert.equal(existsSync(f.rig), false, 'the exact marked rig must be cleaned')
    const receipt = JSON.parse(readFileSync(join(f.output, 'capture.json'), 'utf8'))
    assert.equal(receipt.status, status)
    assert.deepEqual(receipt.exit, kind === 'exit-symlink' ? { status: 'refused' } : { status: 'observed', exitCode: kind === 'signal' ? null : 17, signalCode: kind === 'signal' ? 'SIGTERM' : null })
    const tail = join(f.output, 'app-log-tail.log')
    if (['refusal', 'signal', 'exit-symlink'].includes(kind)) assert.equal(readFileSync(tail, 'utf8'), 'synthetic startup refusal\n')
    else if (kind === 'large') { const data = readFileSync(tail); assert.equal(data.length, 65536); assert(data.toString().endsWith('SYNTHETIC-END')) }
    else assert.equal(existsSync(tail), false)
  } finally { f.clean() }
})
test('a cleanup error retains the startup failure and diagnostic evidence', () => {
  const f = fixture('cleanup-error')
  try {
    assert.notEqual(f.child.status, 0); assert.match(f.child.stderr, /synthetic shoot failure/); assert.match(f.child.stderr, /synthetic cleanup failure/); assert.match(f.child.stderr, /Command failed/)
    const receipt = JSON.parse(readFileSync(join(f.output, 'capture.json'), 'utf8'))
    assert.equal(receipt.status, 'saved')
    assert.deepEqual(receipt.exit, { status: 'observed', exitCode: 17, signalCode: null })
    assert.equal(readFileSync(join(f.output, 'app-log-tail.log'), 'utf8'), 'synthetic startup refusal\n')
  } finally { f.clean() }
})

test('an unsafe diagnostic output cannot hide the original startup failure', () => {
  const f = fixture('capture-error')
  try {
    assert.notEqual(f.child.status, 0); assert.match(f.child.stderr, /synthetic shoot failure/); assert.match(f.child.stderr, /Command failed/)
    assert.match(f.child.stderr, /native startup log observation unavailable/)
    assert.equal(existsSync(join(f.root, 'decoy-dir', 'capture.json')), false)
    assert.equal(existsSync(f.rig), false)
  } finally { f.clean() }
})
