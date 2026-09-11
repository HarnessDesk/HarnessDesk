import assert from 'node:assert/strict'
import { test } from 'node:test'

import { detectFramework, extractFailures } from '../src/tests.js'

/**
 * The test-runner's two pure cores: framework detection by artifact, and
 * pulling failing file:lines out of whatever a runner printed.
 */

const fakeFs = (files: Record<string, string>) => ({
  exists: (path: string) => Promise.resolve(path in files),
  read: (path: string) => Promise.resolve(files[path] ?? ''),
})

test('detects each framework by its own artifacts, not by guessing', async () => {
  const vitest = await detectFramework(...Object.values(fakeFs({ 'package.json': '{"devDependencies":{"vitest":"1"}}' })) as [never, never])
  assert.equal(vitest?.name, 'vitest')

  const pytest = await detectFramework(...Object.values(fakeFs({ 'pytest.ini': '[pytest]' })) as [never, never])
  assert.equal(pytest?.name, 'pytest')

  const go = await detectFramework(...Object.values(fakeFs({ 'go.mod': 'module x' })) as [never, never])
  assert.equal(go?.name, 'go test')

  const swift = await detectFramework(...Object.values(fakeFs({ 'Package.swift': '// swift-tools' })) as [never, never])
  assert.equal(swift?.name, 'swift test')

  const nothing = await detectFramework(...Object.values(fakeFs({ 'README.md': 'hi' })) as [never, never])
  assert.equal(nothing, null)
})

test('a filter is applied in each framework’s own dialect', async () => {
  const go = await detectFramework(...Object.values(fakeFs({ 'go.mod': 'module x' })) as [never, never])
  assert.deepEqual(go?.filter?.('TestFoo'), ['-run', 'TestFoo'])
  const pytest = await detectFramework(...Object.values(fakeFs({ 'pytest.ini': '' })) as [never, never])
  assert.deepEqual(pytest?.filter?.('test_foo'), ['-k', 'test_foo'])
})

test('failing file:lines are pulled from mixed reporter output, node_modules skipped', () => {
  const output = [
    'FAIL src/thing.test.ts > it works',
    '  at src/thing.ts:42:10',
    '  at node_modules/vitest/dist/x.js:9:1',
    'AssertionError',
  ].join('\n')
  const failures = extractFailures(output)
  assert.ok(failures.some((f) => f === 'src/thing.ts:42'))
  assert.ok(!failures.some((f) => f.includes('node_modules')))
})

test('a failure line keeps its description whole, digits and all', () => {
  // #55: a digit anywhere in the description put the keyword where the file goes.
  assert.deepEqual(extractFailures('FAIL src/auth.test.ts (15ms)'), ['src/auth.test.ts (15ms)'])
  assert.deepEqual(extractFailures('not ok 3 - adds 2 and 2'), ['3 - adds 2 and 2'])
  // And a stack's file and line is still a file and a line.
  assert.deepEqual(extractFailures('    at check (src/auth.ts:42:7)'), ['src/auth.ts:42'])
})

test('every failure keyword keeps its description whole, and a line without digits is read the same', () => {
  // Round 1 of #164: only FAIL and not ok were pinned.
  assert.deepEqual(extractFailures('FAILED tests/test_auth.py::test_login - AssertionError: 2 != 3'), [
    'tests/test_auth.py::test_login - AssertionError: 2 != 3',
  ])
  assert.deepEqual(extractFailures('  ✗ adds 2 and 2 (4ms)'), ['adds 2 and 2 (4ms)'])
  assert.deepEqual(extractFailures('✖ the retry waits 250ms'), ['the retry waits 250ms'])
  assert.deepEqual(extractFailures('FAIL src/auth.test.ts'), ['src/auth.test.ts'])
})

test('failure lines are read through colour, cut at 160 characters, and stop at 20 (#174)', () => {
  // A runner that forces colour wraps the keyword in escape codes.
  const esc = String.fromCharCode(27)
  assert.deepEqual(extractFailures(`${esc}[31mFAIL${esc}[39m src/auth.test.ts`), ['src/auth.test.ts'])
  // A keyword with only whitespace after it names nothing.
  assert.deepEqual(extractFailures('FAIL    '), [])
  // Each entry is cut at 160 characters, and there are at most 20.
  assert.equal(extractFailures(`FAIL ${'x'.repeat(300)}`)[0]?.length, 160)
  assert.equal(extractFailures(Array.from({ length: 30 }, (_, n) => `FAIL test ${n}`).join('\n')).length, 20)
  // A line both patterns read gives both: its file and line, and its description.
  assert.deepEqual(extractFailures('FAIL src/auth.test.ts:42 (15ms)'), ['src/auth.test.ts:42', 'src/auth.test.ts:42 (15ms)'])
})

test('a failure line keeps its place through the escapes runners write around it (review of #221, round 1)', () => {
  const ESC = String.fromCharCode(27)
  // The cursor hidden before the colour, and a file written as an OSC 8 link, as vitest and jest write one.
  assert.deepEqual(extractFailures(`${ESC}[?25l${ESC}[31m FAIL ${ESC}[39m src/auth.test.ts`), ['src/auth.test.ts'])
  assert.deepEqual(extractFailures(`FAIL ${ESC}]8;;file:///w/src/auth.test.ts${ESC}\\src/auth.test.ts:42${ESC}]8;;${ESC}\\`), ['src/auth.test.ts:42'])
})

test('a failure line keeps its place through the charset escape `tput sgr0` resets with (review of #221, round 2)', () => {
  // ncurses writes ESC ( B before its SGR reset, and the `(B` it left held the keyword off the start of its line.
  assert.deepEqual(extractFailures('\x1b(B\x1b[mFAIL\x1b(B\x1b[m auth > signs in'), ['auth > signs in'])
  assert.deepEqual(extractFailures('\x1b(0qqq\x1b(B'), [], 'a line-drawing switch and back is no failure')
})
