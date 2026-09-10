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
