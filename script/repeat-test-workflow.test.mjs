import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workflow = readFileSync(new URL('../.github/workflows/repeat-test.yml', import.meta.url), 'utf8')
const allowlist = workflow.match(/re\.fullmatch\(r'([^']+)', source\)/)?.[1]
assert.ok(allowlist, 'repeat-test workflow has a full-match path allowlist')
const allowedPath = new RegExp(`^(?:${allowlist})$`)

test('repeat-test uploads only failed or cancelled logs for three days', () => {
  const uploads = [...workflow.matchAll(/      - uses: actions\/upload-artifact@\S+\n([\s\S]*?)(?=^      -|$(?![\s\S]))/gm)]
  assert.equal(uploads.length, 1)
  const upload = uploads[0][1]
  assert.match(upload, /^        if: failure\(\) \|\| cancelled\(\)$/m)
  assert.match(upload, /^          name: repeat-test-logs$/m)
  assert.match(upload, /^          path: output\/repeat-test\/$/m)
  assert.match(upload, /^          retention-days: 3$/m)
})

test('repeat-test accepts Node package and gate test paths', () => {
  for (const path of [
    'packages/server/test/provenance-observer.test.ts',
    'packages/server/test/nested/intake.test.ts',
    'packages/cordis-host/dist/test/installer.test.js',
    'script/gates.test.mjs',
  ]) {
    assert.match(path, allowedPath)
  }
})

test('repeat-test accepts desktop Electron and script tests from source', () => {
  for (const path of [
    'packages/desktop/electron/waiters.test.mjs',
    'packages/desktop/electron/waiters.unit.test.mjs',
    'packages/desktop/script/smoke.test.mjs',
  ]) {
    assert.match(path, allowedPath)
  }
})

test('repeat-test accepts browser specs and repeats them against one shared server', () => {
  assert.match('e2e/ui-system/focus-ring.spec.ts', allowedPath)
  assert.match(workflow, /pnpm exec playwright install --with-deps chromium/)
  assert.match(workflow, /'--repeat-each=' \+ str\(runs\)/)
  assert.match(workflow, /'--workers=' \+ str\(copies\)/)
  assert.match(workflow, /'--retries=0'/)
})

test('repeat-test refuses absolute, traversing, and unlisted paths', () => {
  for (const path of [
    '/tmp/outside.test.mjs',
    'C:/tmp/outside.test.mjs',
    'packages/server/test/../../outside.test.ts',
    'packages/desktop/electron/../script/smoke.test.mjs',
    'packages/desktop/electron/../../../../tmp/outside.test.mjs',
    'packages/desktop/preload.test.mjs',
    'packages/desktop/electron/nested/waiters.test.mjs',
    'packages/desktop/electron/waiters.test.js',
    'e2e/ui-system/../outside.spec.ts',
    'e2e/ui-system/focus-ring.spec.ts;echo unsafe',
    'e2e/ui-system/nested/focus-ring.spec.ts',
    'e2e/ui-system/focus-ring.test.ts',
  ]) {
    assert.doesNotMatch(path, allowedPath)
  }
})
