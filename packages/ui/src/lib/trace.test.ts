import { describe, expect, it } from 'vitest'

import { traceOf } from './trace'

const session = (items: unknown[], status: 'inProgress' | 'completed' | 'failed' | 'interrupted' = 'inProgress') =>
  ({ status: { type: 'active' }, turns: [{ id: 't', status, items }] }) as never

describe('traceOf', () => {
  it('reads the latest step of a running turn', () => {
    expect(traceOf(session([{ type: 'reasoning', summary: [] }]), false)).toBe('thinking')
    expect(traceOf(session([{ type: 'plan', text: 'x' }]), false)).toBe('planning')
    expect(traceOf(session([{ type: 'toolCall', tool: 'TodoWrite', args: {} }]), false)).toBe('planning')
    expect(traceOf(session([{ type: 'toolCall', tool: 'Write', args: { file_path: '/a', content: '' } }]), false)).toBe('editing')
    expect(traceOf(session([{ type: 'command', command: 'pnpm test', status: 'inProgress' }]), false)).toBe('testing')
    expect(traceOf(session([{ type: 'toolCall', tool: 'Bash', args: { command: 'ls' } }]), false)).toBe('running')
    expect(
      traceOf(session([{ type: 'fileChange', changes: [] }, { type: 'assistantMessage', text: 'now testing' }]), false),
    ).toBe('editing')
  })

  it('puts the user first', () => {
    expect(traceOf(session([{ type: 'plan', text: 'x' }]), true)).toBe('waiting')
    expect(traceOf(session([{ type: 'assistantMessage', text: 'Which one?' }], 'completed'), false)).toBe('waiting')
  })

  it('names how a turn ended', () => {
    expect(traceOf(session([{ type: 'assistantMessage', text: 'Done.' }], 'completed'), false)).toBe('done')
    expect(traceOf(session([], 'failed'), false)).toBe('failed')
    expect(traceOf(session([], 'interrupted'), false)).toBe('stopped')
    expect(traceOf({ status: { type: 'idle' }, turns: [] } as never, false)).toBe('idle')
  })
})
