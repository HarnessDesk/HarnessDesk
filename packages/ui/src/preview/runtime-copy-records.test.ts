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

it('records the runtime picker while preserving seated Agent roles', () => {
  const composer = interfaceRecord.split('## The composer')[1]!.split('\n## ')[0]!.replace(/\s+/g, ' ')
  expect(composer).toContain('**The runtime chip**')
  expect(composer).toContain('switches which runtime starts it.')
  expect(composer).toContain('A conversation seated as an Agent names the Agent here, and the seat it took, even on a desk with one runtime.')
  expect(composer).toContain('whichever runtime this pane talks to')
  expect(composer).toContain('When a runtime enables a model setting itself')
  expect(composer).not.toMatch(/The agent chip|which agent starts|whichever agent this pane talks to|When an agent enables a model setting/)
})

it('records Storage cached previews as runtime reads', () => {
  const storage = interfaceRecord.split('**Clear cached previews**')[1]!.split('\n\n')[0]!.replace(/\s+/g, ' ')
  expect(storage).toContain('previews are read again from the runtime next time.')
  expect(storage).toContain('Live and full conversation bodies remain.')
  expect(storage).not.toContain('from the agent')
})
