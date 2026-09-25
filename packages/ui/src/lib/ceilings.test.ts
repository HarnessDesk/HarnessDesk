import { describe, expect, it } from 'vitest'

import type { AgentDefinition, FlowRun, RuntimeInfo } from '@harnessdesk/protocol'

import { ceilingTitle, ceilingTone, flagWords, flowSeatCeiling, runtimeHolds, seatCeilingOf, updateChoices } from './ceilings'

const definition = (over: Partial<AgentDefinition>): AgentDefinition => ({
  id: 'reviewer',
  name: 'Reviewer',
  description: null,
  ceiling: 'read',
  ceilingFrom: 'ceiling',
  answers: [],
  produces: [],
  skills: [],
  mcp: [],
  prefer: [],
  brief: 'Read.',
  ...over,
})

describe('ceilings in words and tones', () => {
  it('draws asked in the warning tone and held in the neutral one — never a colour alone', () => {
    expect(ceilingTone({ level: 'read', hold: 'asked' })).toBe('warning')
    expect(ceilingTone({ level: 'read', hold: 'held' })).toBe('neutral')
  })

  it('says what a ceiling means, and how it holds or why it is only asked', () => {
    expect(ceilingTitle({ level: 'read', hold: 'held' }, 'Read-only sandbox; anything past it asks you')).toBe(
      'Changes nothing: it reads, searches and reports. Held: Read-only sandbox; anything past it asks you.',
    )
    expect(ceilingTitle({ level: 'edit', hold: 'asked' })).toBe(
      "May change files and commit in its own checkout, and never push. Asked, not held: its runtime has no control that holds it, so the seat is only told. The desk's own tools still refuse anything above it.",
    )
    expect(ceilingTitle({ level: 'edit', hold: 'asked' }, 'Sandbox reads back as Full access, not Workspace')).toMatch(
      /^May change files .* Asked, not held: Sandbox reads back as Full access, not Workspace\. The desk's own tools/,
    )
  })

  it("reads a flow role's permission with the meaning it had, and only ever asked", () => {
    expect(flowSeatCeiling('read')).toEqual({ level: 'edit', hold: 'asked' })
    expect(flowSeatCeiling('merge')).toEqual({ level: 'merge', hold: 'asked' })
  })

  it('says which ceilings a runtime holds, and how, from what it declares', () => {
    const codexLike = {
      ceilings: {
        read: { settings: [], how: 'Read-only sandbox' },
        edit: { settings: [], how: 'Workspace sandbox' },
      },
    } as unknown as RuntimeInfo
    expect(runtimeHolds(codexLike)).toEqual([
      { level: 'read', held: true, how: 'Read-only sandbox' },
      { level: 'edit', held: true, how: 'Workspace sandbox' },
      { level: 'publish', held: false, how: null },
      { level: 'merge', held: false, how: null },
    ])
    expect(runtimeHolds({} as RuntimeInfo).every((one) => !one.held)).toBe(true)
  })

  it('flags an Agent on the old key or with no ceiling, and offers the two lines Update… can write', () => {
    expect(flagWords(definition({ ceiling: 'edit', ceilingFrom: 'permission' }))).toBe(
      'Written with permission, so it reads as edit.',
    )
    expect(flagWords(definition({ ceilingFrom: 'none' }))).toBe('No ceiling written, so it runs as read.')
    expect(flagWords(definition({}))).toBeNull()
    expect(updateChoices(definition({ ceiling: 'edit', ceilingFrom: 'permission' })).map((one) => [one.level, one.label])).toEqual([
      ['edit', 'Keep Edit'],
      ['read', 'Narrow to Read'],
    ])
    expect(updateChoices(definition({ ceiling: 'publish', ceilingFrom: 'permission' })).map((one) => one.level)).toEqual([
      'publish',
      'read',
    ])
    expect(updateChoices(definition({ ceilingFrom: 'none' })).map((one) => [one.level, one.label])).toEqual([
      ['read', 'Keep Read'],
      ['edit', 'Allow Edit'],
    ])
  })
})

describe("a seat's ceiling, wherever the seat is drawn", () => {
  const run = (state: FlowRun['state']): FlowRun =>
    ({
      id: 'r1',
      flow: { name: 'Fix it', roles: [] },
      state,
      vars: {},
      seats: [{ key: 'k', role: 'fixer', runtime: 'codex', sessionId: 's-flow', seat: 'Codex', spec: { runtime: 'codex' }, permission: 'publish', cwd: '/w' }],
      rounds: [],
      record: [],
      startedAt: 1,
    }) as unknown as FlowRun

  it("is the host's for an Agent's seat, with its words; a flow role's while the run holds it; and nothing for a plain conversation", () => {
    expect(seatCeilingOf({ cwd: '/w', model: 'm', ceiling: { level: 'read', hold: 'held' }, ceilingNote: 'Read-only sandbox' }, [], 'codex', 's1')).toEqual({
      ceiling: { level: 'read', hold: 'held' },
      note: 'Read-only sandbox',
    })
    expect(seatCeilingOf(undefined, [run('running')], 'codex', 's-flow')).toEqual({ ceiling: { level: 'publish', hold: 'asked' }, note: null })
    expect(seatCeilingOf(undefined, [run('settled')], 'codex', 's-flow')).toBeNull()
    expect(seatCeilingOf({ cwd: '/w', model: 'm' }, [run('running')], 'codex', 'someone-else')).toBeNull()
  })
})
