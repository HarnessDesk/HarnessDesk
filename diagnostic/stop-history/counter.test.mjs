import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { recordInterrupt, interruptCount } from './counter.mjs'
test('private fake-only interrupt receipt detects a simulated counter call', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hd2065-counter-toy-'))
  try { const file = join(dir,'counter'); writeFileSync(file,''); assert.equal(interruptCount(file),0); recordInterrupt(file); assert.equal(interruptCount(file),1); assert.equal(readFileSync(file,'utf8'),'I'); writeFileSync(file,'?'); assert.throws(() => interruptCount(file)) }
  finally { rmSync(dir,{ recursive: true, force: true }) }
})

test('instrumented fake process counts a simulated request for a nonexistent fake turn', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hd2065-fake-counter-'))
  try {
    const file=join(dir,'counter'); writeFileSync(file,'')
    const fake=fileURLToPath(new URL('./fake-codex-1545.mjs',import.meta.url))
    const child=spawnSync(process.execPath,[fake],{input:JSON.stringify({id:1,method:'turn/interrupt',params:{threadId:'synthetic-absent',turnId:'synthetic-absent'}})+'\n',env:{HOME:dir,TMPDIR:dir,PATH:'/usr/bin:/bin',HD_2065_INTERRUPT_RECEIPT:file},encoding:'utf8',timeout:5000})
    assert.equal(child.status,0); assert.equal(interruptCount(file),1)
  } finally {rmSync(dir,{recursive:true,force:true})}
})
