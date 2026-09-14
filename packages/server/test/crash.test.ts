import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { CRASH_FILE_LIMIT, forgetCrashCount, recordCrash } from '../src/crash.js'

/**
 * A crash reporter with no bound is a disk-filling device: measured
 * 2026-09-13, a broken stdout looped the shell's `uncaughtException` handler
 * and this wrote 267,665 files and 1.0 GB in six minutes.
 */
test('two crashes in the same millisecond are two files, not one', () => {
  // The control the cap test needs: without this, a tight loop writes one
  // file over and over and any cap looks like it is working.
  const home = mkdtempSync(join(tmpdir(), 'hd-crash-'))
  const was = process.env['HARNESSDESK_HOME']
  process.env['HARNESSDESK_HOME'] = home
  forgetCrashCount()
  try {
    for (let i = 0; i < 20; i += 1) recordCrash('uncaughtException', new Error('same millisecond'))
    assert.equal(readdirSync(join(home, 'logs', 'crashes')).length, 20)
  } finally {
    if (was === undefined) delete process.env['HARNESSDESK_HOME']
    else process.env['HARNESSDESK_HOME'] = was
    rmSync(home, { recursive: true, force: true })
  }
})

test('a crash loop cannot write more than the limit', () => {
  const home = mkdtempSync(join(tmpdir(), 'hd-crash-'))
  const was = process.env['HARNESSDESK_HOME']
  process.env['HARNESSDESK_HOME'] = home
  forgetCrashCount()
  try {
    for (let i = 0; i < CRASH_FILE_LIMIT * 3; i += 1) {
      recordCrash('uncaughtException', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    }
    const files = readdirSync(join(home, 'logs', 'crashes'))
    // The control: it really did write, and it really did stop.
    assert.equal(files.length, CRASH_FILE_LIMIT, 'the cap is what stopped it, and it wrote up to it')
    assert.ok(
      files.length <= CRASH_FILE_LIMIT,
      `${files.length} crash files were written for a limit of ${CRASH_FILE_LIMIT}`,
    )
  } finally {
    if (was === undefined) delete process.env['HARNESSDESK_HOME']
    else process.env['HARNESSDESK_HOME'] = was
    rmSync(home, { recursive: true, force: true })
  }
})
