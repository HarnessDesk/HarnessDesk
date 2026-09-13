import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  checkRawPathComparisons,
  checkUnvalidatedDeletions,
  checkDuplicateHelperPins,
  auditFile,
} from './check-half-applied-fixes.mjs'

test('detects raw path comparison in a file defining/using samePath (historical PR #327 defect)', () => {
  const unpatchedWorktreeCode = `
import { samePath } from './worktree.js'

export const putBack = async (entry, target) => {
  const back = entry.path === target
  return back
}
`
  const issues = checkRawPathComparisons(unpatchedWorktreeCode, 'packages/server/src/worktree.ts')
  assert.equal(issues.length, 1)
  assert.equal(issues[0].rule, 'path-comparison-bypass')
  assert.match(issues[0].text, /entry\.path === target/)
})

test('passes when samePath is used instead of raw equality', () => {
  const patchedWorktreeCode = `
import { samePath } from './worktree.js'

export const putBack = async (entry, target) => {
  const back = samePath(entry.path, target)
  return back
}
`
  const issues = checkRawPathComparisons(patchedWorktreeCode, 'packages/server/src/worktree.ts')
  assert.equal(issues.length, 0)
})

test('detects unvalidated deletion under tmpdir in file defining CHAT_ID / chatPath (historical PR #329 defect with identifier flow)', () => {
  const unpatchedBridgeCode = `
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { CHAT_ID, chatPath } from './store.js'

function deleteSession(chatId) {
  const path = chatPath(chatId)
  const scratchDir = join(tmpdir(), 'harnessdesk-cursor-acp', chatId)
  rmSync(scratchDir, { recursive: true, force: true })
}
`
  const issues = checkUnvalidatedDeletions(unpatchedBridgeCode, 'packages/cursor-acp/src/bridge.ts')
  assert.equal(issues.length, 1)
  assert.equal(issues[0].rule, 'unvalidated-deletion')
  assert.match(issues[0].text, /scratchDir/)
})

test('detects unvalidated direct tmpdir expression deletion in file defining CHAT_ID / chatPath', () => {
  const unpatchedBridgeCode = `
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { CHAT_ID, chatPath } from './store.js'

function deleteSession(chatId) {
  const path = chatPath(chatId)
  rmSync(join(tmpdir(), 'harnessdesk-cursor-acp', chatId), { recursive: true, force: true })
}
`
  const issues = checkUnvalidatedDeletions(unpatchedBridgeCode, 'packages/cursor-acp/src/bridge.ts')
  assert.equal(issues.length, 1)
  assert.equal(issues[0].rule, 'unvalidated-deletion')
  assert.match(issues[0].text, /join\(tmpdir\(\)/)
})

test('is not bypassed by unrelated startsWith check elsewhere in the file (P2 defect)', () => {
  const bypassSnippet = `
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { CHAT_ID, chatPath } from './store.js'

const root = '/tmp/foo'
if (something.startsWith(root + '/')) {
  // unrelated guard
}

function deleteSession(chatId) {
  const scratchDir = join(tmpdir(), 'harnessdesk-cursor-acp', chatId)
  rmSync(scratchDir, { recursive: true, force: true })
}
`
  const issues = checkUnvalidatedDeletions(bypassSnippet, 'packages/cursor-acp/src/bridge.ts')
  assert.equal(issues.length, 1)
  assert.equal(issues[0].rule, 'unvalidated-deletion')
  assert.match(issues[0].text, /scratchDir/)
})

test('passes when containment check is present before deletion', () => {
  const patchedBridgeCode = `
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { rmSync } from 'node:fs'
import { CHAT_ID, chatPath } from './store.js'

function deleteSession(chatId) {
  const path = chatPath(chatId)
  const root = resolve(tmpdir(), 'harnessdesk-cursor-acp')
  const scratchDir = resolve(root, chatId)
  if (scratchDir.startsWith(root + '/') || scratchDir.startsWith(root + '\\\\')) {
    rmSync(scratchDir, { recursive: true, force: true })
  }
}
`
  const issues = checkUnvalidatedDeletions(patchedBridgeCode, 'packages/cursor-acp/src/bridge.ts')
  assert.equal(issues.length, 0)
})

test('detects duplicate unpinned isDirectory definitions across host and adapter (historical PR #319 defect)', () => {
  const unpinnedHostCode = `
export const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
`
  const issues = checkDuplicateHelperPins(unpinnedHostCode, 'packages/server/src/host.ts')
  assert.equal(issues.length, 1)
  assert.equal(issues[0].rule, 'unpinned-duplicate-helper')
})

test('passes when duplicate helper has reference pin comment', () => {
  const pinnedHostCode = `
/**
 * Whether a path is still a directory an agent could be started in.
 *
 * Kept identical in semantics to \`isDirectory\` in
 * \`packages/adapter-acp/src/runtime.ts\` so the listing-sourced fact and the
 * refusal-sourced fact cannot drift.
 */
export const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
`
  const issues = checkDuplicateHelperPins(pinnedHostCode, 'packages/server/src/host.ts')
  assert.equal(issues.length, 0)
})

test('detects historical defect from PR #327 when putBack uses raw equality', () => {
  const code = `
import { samePath } from './worktree.js'

export const putBack = async (entry, target) => {
  const back = entry.path === target
  return back
}
`
  const issues = auditFile('packages/server/src/worktree.ts', code)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].rule, 'path-comparison-bypass')
})

test('detects historical defect from PR #329 directly on historical bridge.ts parent commit', () => {
  const code = `
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { CHAT_ID, chatPath } from './store.js'

function deleteSession(chatId) {
  const path = chatPath(chatId)
  const scratchDir = join(tmpdir(), 'harnessdesk-cursor-acp', chatId)
  rmSync(scratchDir, { recursive: true, force: true })
}
`
  const issues = auditFile('packages/cursor-acp/src/bridge.ts', code)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].rule, 'unvalidated-deletion')
  assert.equal(issues[0].text, 'scratchDir')
})

test('detects historical defect from PR #319 when isDirectory is missing counterpart pin comment', () => {
  const code = `
export const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
`
  const issues = auditFile('packages/server/src/host.ts', code)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].rule, 'unpinned-duplicate-helper')
})

