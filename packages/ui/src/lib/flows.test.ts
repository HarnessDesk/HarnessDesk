import { describe, expect, test } from 'vitest'

import type { FlowPolicy } from '@harnessdesk/protocol'

import { evidenceGuardWords, evidenceGuardsWords, messagingWords, raceRoleId, seatSpecOf, substituteAgentRole } from './flows'

describe('evidenceGuardWords', () => {
  test('names each guard kind as a sentence, never the wire shape', () => {
    expect(evidenceGuardWords({ check: 'verify' })).toBe('A passing “verify” check at the selected revision')
    expect(evidenceGuardWords({ ci: 'green' })).toBe('CI green at the selected revision')
    expect(evidenceGuardWords({ review: 'picked' })).toBe('A recorded review of “picked” at the selected revision')
    expect(evidenceGuardWords({ pr: 'open' })).toBe('The pull request open')
    expect(evidenceGuardWords({ pr: 'merged' })).toBe('The pull request merged')
    expect(evidenceGuardWords({ diff: true })).toBe('A committed change in the step’s checkout')
  })

  test('joins several guards into one sentence', () => {
    expect(evidenceGuardsWords([{ check: 'verify' }, { ci: 'green' }])).toBe(
      'A passing “verify” check at the selected revision, and CI green at the selected revision',
    )
  })
})

describe('messagingWords', () => {
  test('discloses the channel policy in words, not the wire value', () => {
    expect(messagingWords('members')).toBe('Members may message each other')
    expect(messagingWords('board-only')).toBe('Board-only: members do not message each other')
  })
})

describe('seatSpecOf', () => {
  test('the compact runtime=model/effort+ grammar', () => {
    expect(seatSpecOf({ runtime: 'codex' })).toBe('codex')
    expect(seatSpecOf({ runtime: 'codex', model: 'gpt-5.3-codex' })).toBe('codex=gpt-5.3-codex')
    expect(seatSpecOf({ runtime: 'codex', model: 'gpt-5.3-codex', effort: 'xhigh' })).toBe('codex=gpt-5.3-codex/xhigh')
    expect(seatSpecOf({ runtime: 'claude-code', thinking: true })).toBe('claude-code+')
  })
})

const flow = (layout: unknown): FlowPolicy => ({
  version: 2,
  name: 'Comparison',
  inputs: [],
  roles: [],
  rules: [],
  seed: { role: 'competitor', title: 'Go' },
  messaging: 'board-only',
  wait: 240,
  ...(layout === undefined ? {} : { layout }),
})

describe('raceRoleId', () => {
  test('reads the ordinary layout marker, never an execution type', () => {
    expect(raceRoleId(flow({ race: 'competitor' }))).toBe('competitor')
  })
  test('null when the file carries no marker, or an invalid one', () => {
    expect(raceRoleId(flow(undefined))).toBeNull()
    expect(raceRoleId(flow({ race: '' }))).toBeNull()
    expect(raceRoleId(flow({ race: 3 }))).toBeNull()
    expect(raceRoleId(flow(null))).toBeNull()
  })
})

const COMPARISON = [
  'version: 2',
  'name: "Comparison"',
  'roles:',
  '  competitor:',
  '    kind: agent',
  '    uses: [implementer]',
  '    isolate: true',
  '    grant: edit',
  '    independentOf: []',
  '  check:',
  '    kind: check',
  '    run: "pnpm verify"',
  '    timeout: 1800',
  'seed: { role: competitor, title: "Go" }',
  'rules: []',
  'messaging: board-only',
  'wait: 240',
  'layout: {"race":"competitor"}',
  '',
].join('\n')

describe('substituteAgentRole', () => {
  test('replaces uses and inserts an explicit two-seat list, leaving the rest of the file untouched', () => {
    const next = substituteAgentRole(COMPARISON, 'competitor', 'implementer', [
      { runtime: 'codex', model: 'gpt-5.3-codex' },
      { runtime: 'claude-code' },
    ])
    expect(next).not.toBeNull()
    const lines = next!.split('\n')
    expect(lines).toContain('    uses: ["implementer"]')
    expect(lines).toContain('    seats: ["codex=gpt-5.3-codex", "claude-code"]')
    // Nothing else in the file moved.
    expect(next).toContain('    kind: check')
    expect(next).toContain('    run: "pnpm verify"')
    expect(next).toContain('layout: {"race":"competitor"}')
  })

  test('a pre-existing count or seats line on the role is replaced, not left to disagree with the new width', () => {
    const withCount = COMPARISON.replace('    independentOf: []', '    independentOf: []\n    count: 3')
    const next = substituteAgentRole(withCount, 'competitor', 'implementer', [
      { runtime: 'codex' },
      { runtime: 'codex', effort: 'high' },
    ])
    expect(next).not.toBeNull()
    expect(next).not.toMatch(/count:/)
    expect(next).toContain('    seats: ["codex", "codex/high"]')
  })

  test('null when the named role is not a block of its own', () => {
    expect(substituteAgentRole(COMPARISON, 'no-such-role', 'implementer', [{ runtime: 'codex' }, { runtime: 'codex' }])).toBeNull()
  })

  test('null when the role has no uses: line to replace', () => {
    const broken = COMPARISON.replace('    uses: [implementer]', '    seats: []')
    expect(substituteAgentRole(broken, 'competitor', 'implementer', [{ runtime: 'codex' }, { runtime: 'codex' }])).toBeNull()
  })

  test('a value containing YAML-significant characters is quoted safely, never splices raw text', () => {
    const next = substituteAgentRole(COMPARISON, 'competitor', 'implementer', [
      { runtime: 'codex', model: 'weird: [value]' },
      { runtime: 'codex' },
    ])
    expect(next).toContain('    seats: ["codex=weird: [value]", "codex"]')
  })
})
