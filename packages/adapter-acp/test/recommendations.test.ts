import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AcpRuntime } from '../src/index.js'

test('ACP reports stable native model and effort recommendations after a draft pick', async t => {
  const runtime = new AcpRuntime({ id: 'fake', name: 'Demo runtime', command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))] })
  t.after(() => runtime.dispose())
  await runtime.start()
  const options = await runtime.defaultSessionOptions('/tmp/acp-recommendations')
  const model = options.find(option => option.category === 'model')!
  assert.equal(model.recommendedValue, 'small')
  const picked = await runtime.defaultSessionOptions('/tmp/acp-recommendations', { model: 'large' })
  assert.equal(picked.find(option => option.category === 'model')?.recommendedValue, 'small')
  assert.equal(picked.find(option => option.id === 'auto_approve')?.recommendedValue, false)
})

import { recommendAcpOptions } from '../src/recommendations.js'
import type { ConfigOption } from '@harnessdesk/protocol'

test('ACP recommends workspace editing and native default effort without widening disabled controls', () => {
  const select = (id: string, category: ConfigOption['category'], currentValue: string, values: string[]): ConfigOption => ({
    id, category, label: id, type: 'select', currentValue, choices: values.map(value => ({ value, label: value })),
  })
  const options = recommendAcpOptions([
    select('mode', 'mode', 'bypassPermissions', ['bypassPermissions', 'acceptEdits']),
    select('sandbox', '_permissions', 'disabled', ['enabled', 'disabled']),
    select('effort', 'thought_level', 'xhigh', ['default', 'medium', 'xhigh']),
    { ...select('locked', 'thought_level', 'xhigh', ['medium', 'xhigh']), disabled: 'Managed' },
  ], null)
  assert.deepEqual(options.map(option => option.recommendedValue), ['acceptEdits', 'enabled', 'default', undefined])
  assert.equal(options[0]?.currentValue, 'bypassPermissions', 'live values stay intact')
})
