import { expect, it } from 'vitest'
import { previewUsage } from './sidebar-fixture'
import interfaceRecord from '../../../../docs/interface.md?raw'

it('describes both cached usage sources without calling runtimes agents', () => {
  const cached = previewUsage.filter(report => report.source.kind === 'file')
  expect(cached).toHaveLength(2)
  expect(cached.map(report => report.source.label)).toEqual(['from its own cache', 'from its own cache'])
})

it('records the signed-out runtime empty conversation in the interface contract', () => {
  expect(interfaceRecord.match(/^A signed-out .*$/m)?.[0]).toBe('A signed-out runtime’s empty conversation offers one normal Sign in button.')
})
