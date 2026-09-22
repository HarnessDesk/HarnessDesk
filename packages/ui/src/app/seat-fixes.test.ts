import { describe, expect, it } from 'vitest'

import type { SeatFix } from '@harnessdesk/protocol'

import { routeFor } from './seat-fixes'

/**
 * A fix on the refusal sheet is a destination. A runtime's trouble is fixed
 * where runtimes live — its page, its sign-in, its usage — and only a seat the
 * Agent asks for is fixed on the Agent's own page, in the Agents window.
 * Nothing about a runtime opens the roster.
 */
describe('where a fix goes', () => {
  it('sends a ceiling this Mac refused to hold to Settings › Permissions at Ceilings', () => {
    expect(routeFor({ kind: 'ceilings' }, 'code-reviewer')).toEqual({ kind: 'settings', section: 'permissions', focus: 'ceilings' })
  })
  it('sends every runtime’s trouble to the runtime, never to the roster', () => {
    const fixes: SeatFix[] = [
      { kind: 'signIn', runtime: 'cursor' },
      { kind: 'usage', runtime: 'cursor' },
      { kind: 'add', runtime: 'codex' },
      { kind: 'install', runtime: 'codex' },
      { kind: 'runtime', runtime: 'claude-code' },
    ]
    expect(fixes.map((fix) => routeFor(fix, 'code-reviewer'))).toEqual([
      { kind: 'signIn', runtime: 'cursor' },
      { kind: 'usage', runtime: 'cursor' },
      { kind: 'settings', section: 'runtimes', focus: 'add' },
      { kind: 'settings', section: 'runtimes', focus: 'codex' },
      { kind: 'settings', section: 'runtimes', focus: 'claude-code' },
    ])
  })

  it('sends a seat the Agent asks for to the Agent’s own page in the Agents window, never Settings', () => {
    expect(routeFor({ kind: 'seats' }, 'code-reviewer')).toEqual({
      kind: 'agent',
      agent: 'code-reviewer',
      focus: 'seats',
    })
  })
})
