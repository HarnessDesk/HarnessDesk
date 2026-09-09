import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { ExtensionKernel } from '@harnessdesk/cordis-host'
import { runtimeId, type ContributionId, type ScopeQuery, type SessionId, type ToolResult } from '@harnessdesk/protocol'

import { checkpointPlugin, guardrailsPlugin, testsPlugin } from '../src/index.js'
import { PerSession, scopeKey } from '../src/session-state.js'

/**
 * Plugin state belongs to a conversation, not to the process.
 *
 * The kernel is one instance for the whole application, so a plugin that keeps
 * its state in a bare closure variable shares that state with every other
 * conversation open at the same time. `todo.ts` has always kept its lists in a
 * `Map` keyed by scope; these are the plugins that did not.
 *
 * Every test here drives two scopes through one kernel, because one scope can
 * never show the defect.
 */

const run = promisify(execFile)
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))

const A: ScopeQuery = { runtime: runtimeId('codex'), sessionId: 'session-a' as SessionId }
const B: ScopeQuery = { runtime: runtimeId('codex'), sessionId: 'session-b' as SessionId }

const toolNamed = (kernel: ExtensionKernel, name: string): ContributionId => {
  const found = kernel.list('tool').find((entry) => entry.name === name)
  assert.ok(found, `no tool named ${name}`)
  return found.id
}
const text = (result: ToolResult): string =>
  result.ok && result.content[0]?.type === 'text' ? result.content[0].text : `!${result.ok ? '' : result.error}`

// ------------------------------------------------------------------ guardrails

test('a repeat is counted against the conversation that made it', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(guardrailsPlugin)
  await settle()

  const call = (scope: ScopeQuery) =>
    kernel.runHooks({ event: 'preToolUse', toolName: 'x', arguments: {}, scope })

  // Two in A, then one in B. Shared, B's call is the third and trips the
  // threshold; per conversation it is B's first and cannot.
  //
  // The obvious test — three in A, then one in B — cannot see this at all:
  // the rule fires on `seen === repeatThreshold` exactly, so a shared fourth
  // call is silently allowed and the test passes with the defect present.
  await call(A)
  await call(A)
  assert.equal((await call(B)).decision, 'allow', "B's first call is not a loop")
  assert.equal((await call(A)).decision, 'ask', 'and A really is on its third')
})

test('a turn beginning in one conversation does not clear another′s counters', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(guardrailsPlugin)
  await settle()

  const call = (scope: ScopeQuery) =>
    kernel.runHooks({ event: 'preToolUse', toolName: 'x', arguments: {}, scope })

  await call(A)
  await call(A)
  await kernel.runHooks({ event: 'preTurn', scope: B })
  assert.equal((await call(A)).decision, 'ask', 'A is still on its third identical call')
})

// ---------------------------------------------------------------------- tests

test('the last test run is the one this conversation started', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-tests-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  // A workspace the detector recognises, whose suite fails fast and cheaply.
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'x', devDependencies: { vitest: '1' }, scripts: { test: 'exit 1' } }),
    'utf8',
  )

  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  kernel.setWorkspace({ root: dir, branch: null })
  await kernel.load(testsPlugin)
  await settle()

  const ran = await kernel.invokeTool(toolNamed(kernel, 'run_tests'), {}, A)
  assert.match(text(ran), /^(PASS|FAIL) — /, 'A really did run the suite')

  // `resolveContext` skips chip-gated providers, so asking it proves nothing —
  // it returns [] whether or not the report leaked. Resolve the chip itself.
  const chip = kernel.list('context').find((entry) => entry.label === 'Last test run')
  assert.ok(chip, 'the Last test run chip is registered')

  const inA = await kernel.resolveOne(chip.id, undefined, A)
  assert.match(inA?.text ?? '', /Test run from/, 'A can see its own run')

  await assert.rejects(
    () => kernel.resolveOne(chip.id, undefined, B),
    /No test run recorded yet/,
    'B ran nothing, so it has no last run — it must not be handed A\'s',
  )
})

// ----------------------------------------------------------------- checkpoint

test('checkpoints are listed to the conversation that took them', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-ckpt-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await run('git', ['init', '-q'], { cwd: dir })
  await run('git', ['config', 'user.email', 't@example.com'], { cwd: dir })
  await run('git', ['config', 'user.name', 'T'], { cwd: dir })
  await writeFile(join(dir, 'a.txt'), 'one', 'utf8')
  await run('git', ['add', '-A'], { cwd: dir })
  await run('git', ['commit', '-qm', 'first'], { cwd: dir })

  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  kernel.setWorkspace({ root: dir, branch: null })
  await kernel.load(checkpointPlugin)
  await settle()

  const taken = await kernel.invokeTool(toolNamed(kernel, 'create_checkpoint'), { note: 'in A' }, A)
  assert.match(text(taken), /Checkpoint [0-9a-f]{7}/, 'A took a checkpoint')

  const listedInB = text(await kernel.invokeTool(toolNamed(kernel, 'list_checkpoints'), {}, B))
  assert.match(
    listedInB,
    /No checkpoints have been taken/,
    'the tool says "taken during this session"; B took none',
  )
})

// ------------------------------------------------------------ the lid itself

test('the map has a lid, and reset does not lift it', () => {
  // `reset` overwrote in place, and `Map.set` on an existing key neither moves
  // it in iteration order nor runs any cap. guardrails calls reset on every
  // preTurn *before* any get, so that path grew without bound.
  const held = new PerSession(() => ({ n: 0 }), 10)
  for (let i = 0; i < 40; i += 1) {
    held.reset({ runtime: runtimeId('codex'), sessionId: `s-${i}` as SessionId })
  }
  assert.equal(held.size, 10, 'reset must evict like get does')
})

test('the least recently used conversation is the one dropped', () => {
  const held = new PerSession(() => ({ n: 0 }), 3)
  const at = (id: string): ScopeQuery => ({ runtime: runtimeId('codex'), sessionId: id as SessionId })
  held.get(at('a')).n = 1
  held.get(at('b')).n = 2
  held.get(at('c')).n = 3
  held.get(at('a')).n = 9 // touching `a` makes `b` the coldest
  held.get(at('d'))
  assert.equal(held.get(at('a')).n, 9, 'a was used most recently and survived')
  assert.equal(held.get(at('b')).n, 0, 'b was coldest and was dropped')
})

test('a scope with no session is one entry, not a new one each time', () => {
  assert.equal(scopeKey(undefined), scopeKey({}))
  const held = new PerSession(() => ({ n: 0 }))
  held.get(undefined).n = 5
  assert.equal(held.get({}).n, 5, 'an unresolvable caller shares the old single-slot behaviour')
})

// -------------------------------------------- the automatic checkpoint path

test('the automatic pre-write checkpoint is taken per conversation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-auto-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await run('git', ['init', '-q'], { cwd: dir })
  await run('git', ['config', 'user.email', 't@example.com'], { cwd: dir })
  await run('git', ['config', 'user.name', 'T'], { cwd: dir })
  await writeFile(join(dir, 'a.txt'), 'one', 'utf8')
  await run('git', ['add', '-A'], { cwd: dir })
  await run('git', ['commit', '-qm', 'first'], { cwd: dir })

  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  kernel.setWorkspace({ root: dir, branch: null })
  await kernel.load(checkpointPlugin)
  await settle()

  // A writes: it gets an automatic checkpoint and is marked as having one.
  await kernel.runHooks({ event: 'preToolUse', toolName: 'write_file', arguments: {}, scope: A })
  // B begins a turn. Shared, this cleared A's `takenThisTurn`.
  await kernel.runHooks({ event: 'preTurn', scope: B })
  // A writes again in the same turn — it must not take a second checkpoint.
  await kernel.runHooks({ event: 'preToolUse', toolName: 'write_file', arguments: {}, scope: A })

  const listed = text(await kernel.invokeTool(toolNamed(kernel, 'list_checkpoints'), {}, A))
  assert.equal(listed.split('\n').length, 1, `one checkpoint for one turn, got:\n${listed}`)
  assert.match(text(await kernel.invokeTool(toolNamed(kernel, 'list_checkpoints'), {}, B)), /No checkpoints/)
})

