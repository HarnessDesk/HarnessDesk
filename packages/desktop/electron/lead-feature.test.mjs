import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('only the exact startup value 1 enables Lead', async () => {
  const feature = await import('./lead-feature.mjs').catch(() => ({}))
  assert.equal(typeof feature.leadEnabled, 'function', 'the desktop owns the startup flag parser')
  assert.equal(feature.leadEnabled({ HARNESSDESK_LEAD: '1' }), true)
  for (const value of [undefined, '', '0', 'true', 'false', ' 1', '1 ', '01', '1\n', 'on', 'yes', '2']) {
    assert.equal(feature.leadEnabled(value === undefined ? {} : { HARNESSDESK_LEAD: value }), false, JSON.stringify(value))
  }
})

test('the desktop passes the parsed startup switch to the host', async () => {
  const source = await readFile(new URL('./main.mjs', import.meta.url), 'utf8')
  assert.ok(/import\s*\{\s*leadEnabled\s*\}\s*from ['"]\.\/lead-feature\.mjs['"]/.test(source), 'main imports the desktop flag parser')
  assert.ok(/createDefaultHost\(\{\s*leadEnabled: leadEnabled\(process\.env\)/.test(source), 'main passes the parsed startup flag')
})
