import { describe, expect, it } from 'vitest'

import type { Turn } from '@harnessdesk/protocol'

import { delegatedIn, summariseTurn } from './turn-summary'

const turn = (items: unknown[], status: Turn['status'] = 'completed'): Turn =>
  ({ id: 't1', status, items }) as unknown as Turn

describe('summariseTurn', () => {
  it('reads files, commands, tests and failures off the items', () => {
    const summary = summariseTurn(
      turn([
        { id: 'f', type: 'fileChange', status: 'completed', changes: [{ path: '/w/src/a.ts', kind: { type: 'update' }, diff: '' }] },
        { id: 'w', type: 'toolCall', tool: 'Write /w/src/b.ts', source: { kind: 'builtin' }, status: 'completed', args: { file_path: '/w/src/b.ts', content: 'x' } },
        { id: 'c1', type: 'command', command: 'pnpm test', cwd: '/w', origin: 'agent', status: 'completed', actions: [], exitCode: 1 },
        { id: 'c2', type: 'command', command: 'ls', cwd: '/w', origin: 'agent', status: 'completed', actions: [], exitCode: 0 },
        { id: 'b', type: 'toolCall', tool: 'Bash', source: { kind: 'builtin' }, status: 'completed', args: { command: 'npx vitest run' } },
        { id: 'r', type: 'toolCall', tool: 'Read', source: { kind: 'builtin' }, status: 'failed', args: {}, error: 'nope' },
        { id: 'a', type: 'assistantMessage', text: 'Done. Shall I also update the docs?' },
      ]),
      '/w',
    )!
    expect(summary.files).toEqual(['src/a.ts', 'src/b.ts'])
    expect(summary.commands).toBe(3)
    expect(summary.tests).toEqual({ ran: 2, failed: 1 })
    expect(summary.failures).toEqual(['pnpm test', 'Read'])
    expect(summary.question).toBe(true)
  })

  /* The shape a signed-in Claude Code session actually sends, taken off the
     wire: ACP flattens every step to `toolCall`, and the bridge titles a shell
     step with the command itself in backticks. Read as a tool *name* — which
     is what `SHELL_TOOLS` does — none of this is a command, so a turn that ran
     three reported none, ran no tests, and named its one failure `\`cd`. */
  it('reads a shell step an ACP agent titled with the command itself', () => {
    const bash = (id: string, command: string, extra: Record<string, unknown> = {}) => ({
      id,
      type: 'toolCall',
      tool: `\`${command}\``,
      source: { kind: 'builtin' },
      status: 'completed',
      args: { command, description: 'why' },
      ...extra,
    })
    const summary = summariseTurn(
      turn([
        bash('b1', 'pnpm test'),
        bash('b2', 'git status --short'),
        bash('b3', "awk '/x/,/y/' missing.css", { status: 'failed', error: 'exit 2' }),
        { id: 'e', type: 'toolCall', tool: 'Edit src/a.ts', source: { kind: 'builtin' }, status: 'completed', args: { file_path: '/w/src/a.ts', old_string: 'a', content: 'b' } },
      ]),
      '/w',
    )!
    expect(summary.commands).toBe(3)
    expect(summary.tests).toEqual({ ran: 1, failed: 0 })
    // The command line, not the first word of a backticked title.
    expect(summary.failures).toEqual(["awk '/x/,/y/' missing.css"])
    expect(summary.files).toEqual(['src/a.ts'])
  })

  it('says nothing for a turn that was only talk', () => {
    expect(summariseTurn(turn([{ id: 'a', type: 'assistantMessage', text: 'Hello.' }]), '/w')).toBeNull()
  })

  it('waits for the turn to finish', () => {
    expect(summariseTurn(turn([{ id: 'c', type: 'command', command: 'ls', cwd: '/w', origin: 'agent', status: 'inProgress', actions: [] }], 'inProgress'), '/w')).toBeNull()
  })
})

describe('delegatedIn', () => {
  const sub = (id: string, totalTokens: number, outputExact?: boolean) => ({
    id,
    type: 'subagent',
    action: 'spawn',
    status: 'completed',
    members: [],
    usage: {
      totalTokens,
      inputTokens: totalTokens,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      ...(outputExact === undefined ? {} : { outputExact }),
    },
  })

  it('sums only this turn, so a turn that delegated nothing says nothing', () => {
    // The bug this replaces used the session-cumulative figure, so a turn
    // that handed off nothing still reported the previous turn's delegation
    // beside its own tokens — and, given a long enough session, a delegated
    // total larger than the turn it was printed next to.
    expect(delegatedIn(turn([sub('a', 11), sub('b', 14)]))).toEqual({ tokens: 25, exact: true })
    expect(delegatedIn(turn([{ id: 'm', type: 'assistantMessage', text: 'no delegation here' }]))).toBeNull()
  })

  it('is a floor when any child of the turn was still streaming', () => {
    expect(delegatedIn(turn([sub('a', 900, false)]))?.exact).toBe(false)
    // One inexact child is enough: the sum cannot be tighter than its parts.
    expect(delegatedIn(turn([sub('a', 10), sub('b', 900, false)]))).toEqual({ tokens: 910, exact: false })
  })

  it('says nothing for a runtime that does not attribute delegated spend', () => {
    // No usage at all is different from zero: a sub-agent shown as having
    // cost nothing is a claim, and usually a false one.
    expect(delegatedIn(turn([{ id: 'a', type: 'subagent', action: 'spawn', status: 'completed', members: [] }]))).toBeNull()
  })
})
