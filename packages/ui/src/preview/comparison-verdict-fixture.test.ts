import { expect, it } from 'vitest'
import { comparisonVerdictStore } from './comparison-verdict-fixture'
import { withRealNames } from '../../site-demo/real-names'

it('a method the comparison fixture does not answer goes to the preview store once, never back to itself', async () => {
  const store = comparisonVerdictStore('picked')
  const outcome = await store.transport.request('lead/inbox/read' as never, {} as never).then(value => ({ value }), error => ({ error: String(error) }))
  expect(String((outcome as { error?: string }).error ?? '')).not.toMatch(/call stack/i)
  expect(await store.transport.request('git/refs' as never, {} as never)).toMatchObject({ branch: 'main' })
})

it('the real-names wrap over the fixture answers an unhandled method without overflowing', async () => {
  const store = withRealNames(comparisonVerdictStore('picked'))
  const outcome = await store.transport.request('lead/inbox/read' as never, {} as never).then(value => ({ value }), error => ({ error: String(error) }))
  expect(String((outcome as { error?: string }).error ?? '')).not.toMatch(/call stack/i)
})
