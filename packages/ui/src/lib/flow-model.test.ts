import { describe, expect, it } from 'vitest'

import type { CeilingLevel, Flow, FlowAgentRole, FlowPolicy, FlowPolicyRole, FlowPolicyRule, SeatCeiling } from '@harnessdesk/protocol'

import { ceilingsOfRun, flowModel, stepName } from './flow-model'

/**
 * What a drawing of a Flow says in words: a step's name and its one earned
 * line, and what a rule's edge says above it. The geometry is `flow-layout`'s;
 * this is only the reading of the document, so the drawing, the list under it
 * and the narrow view all read it the same way.
 */

const agent = (id: string, grant: CeilingLevel = 'read', over: Partial<FlowAgentRole> = {}): FlowAgentRole => ({
  id, kind: 'agent', uses: [`${id}-agent`], seats: [], isolate: false, grant, independentOf: [], ...over,
})
const check = (id: string, run: string): FlowPolicyRole => ({ id, kind: 'check', check: { run, timeout: 300, exits: { 0: 'pass' }, otherwise: 'fail' } })
const person = (id: string, outcomes: readonly string[]): FlowPolicyRole => ({ id, kind: 'person', outcomes })
const ran = (level: CeilingLevel, hold: SeatCeiling['hold']): SeatCeiling => ({ level, hold })
const rule = (id: string, on: string, to: string, when?: FlowPolicyRule['when']): FlowPolicyRule => ({
  id, on, ...(when ? { when } : {}), then: { role: to, title: `Open ${to}` },
})
const policy = (roles: readonly FlowPolicyRole[], rules: readonly FlowPolicyRule[] = [], over: Partial<FlowPolicy> = {}): FlowPolicy => ({
  version: 2, name: 'Write, review, fix', inputs: [], roles, rules, seed: { role: roles[0]!.id, title: 'Go' }, messaging: 'board-only', wait: 240, ...over,
})

describe('a step', () => {
  it('is named in a word and carries one earned line, by what it is', () => {
    const model = flowModel(policy([agent('write', 'edit'), check('verify', 'pnpm verify'), person('referee', ['merged', 'dropped'])]))
    expect(model.steps.map((step) => [step.id, step.kind, step.name, step.line])).toEqual([
      ['write', 'agent', 'Write', 'Edit'],
      ['verify', 'check', 'Verify', 'pnpm verify'],
      ['referee', 'person', 'Referee', 'merged · dropped'],
    ])
  })

  it('makes a word of the id, whatever separates it', () => {
    expect(stepName('write')).toBe('Write')
    expect(stepName('test_review')).toBe('Test review')
    expect(stepName('back-to-build')).toBe('Back to build')
    expect(stepName('  ')).toBe('')
  })

  it('says a grant in the words the rest of the app says a ceiling in', () => {
    const model = flowModel(policy((['read', 'edit', 'publish', 'merge'] as const).map((level) => agent(level, level))))
    expect(model.steps.map((step) => step.line)).toEqual(['Read', 'Edit', 'Publish', 'Merge'])
  })

  it('says what its seats ran under, and whether the runtime held it or only asked, once a Run has seated it', () => {
    const model = flowModel(policy([agent('write', 'edit'), agent('review', 'read'), check('verify', 'pnpm verify')]), {
      ceilings: new Map([['write', ran('edit', 'asked')], ['review', ran('read', 'held')], ['verify', ran('read', 'held')]]),
    })
    expect(model.steps.map((step) => step.line)).toEqual(['Edit · asked', 'Read · held', 'pnpm verify'])
  })

  it('says the level its seats ran at when that is below the grant the Flow asks for', () => {
    // A seat runs at the narrower of its Agent's ceiling and the grant: the
    // grant followed by *held* would say the runtime enforced what it never did.
    const model = flowModel(policy([agent('write', 'edit')]), { ceilings: new Map([['write', ran('read', 'held')]]) })
    expect(model.steps[0]!.line).toBe('Read · held')
  })

  it('does not guess when it does not know', () => {
    expect(flowModel(policy([agent('write', 'edit')])).steps[0]!.line).toBe('Edit')
  })

  it('says what is missing rather than leaving the line empty', () => {
    const model = flowModel(policy([check('verify', ''), person('referee', [])]))
    expect(model.steps.map((step) => step.line)).toEqual(['No command yet', 'No answers yet'])
  })

  it('opens as many seats at once as the round is wide', () => {
    const model = flowModel(policy([
      agent('one'),
      agent('counted', 'read', { count: 3 }),
      agent('listed', 'read', { uses: ['code-reviewer', 'security-reviewer'] }),
      agent('seated', 'read', { seats: [{ runtime: 'alpha' }, { runtime: 'beta' }, { runtime: 'gamma' }, { runtime: 'delta' }] }),
      check('verify', 'true'),
    ]))
    expect(model.steps.map((step) => step.count)).toEqual([1, 3, 2, 4, 1])
  })

  it('names the Agents it uses for the list, not for the card', () => {
    const model = flowModel(policy([agent('review', 'read', { uses: ['code-reviewer', 'security-reviewer'] }), check('verify', 'true')]))
    expect(model.steps.map((step) => step.agents)).toEqual([['code-reviewer', 'security-reviewer'], []])
  })
})

describe('a step of the older format', () => {
  const legacy: Flow = {
    name: 'Fix and review',
    inputs: [],
    roles: [
      { id: 'fixer', kind: 'agent', count: 1, permission: 'read', seats: [{ runtime: 'alpha' }], outcomes: ['published'] },
      { id: 'reviewer', kind: 'agent', count: 3, permission: 'publish', seats: [{ runtime: 'beta' }], outcomes: ['approve', 'request-changes'] },
      { id: 'gate', kind: 'check', count: 1, permission: 'read', seats: [], check: { run: 'true', timeout: 60, exits: {}, otherwise: 'fail' }, outcomes: ['pass'] },
      { id: 'referee', kind: 'person', count: 1, permission: 'read', seats: [], outcomes: ['merged', 'dropped'] },
    ],
    rules: [{ id: 'review-it', on: 'fixer', then: { role: 'reviewer', title: 'Review' } }],
    seed: { role: 'fixer', title: 'Go' },
    wait: 240,
    layout: { fixer: { x: 40, y: 40 } },
  }

  it('reads a permission as the ceiling it always meant, and a count as its width', () => {
    const model = flowModel(legacy)
    expect(model.steps.map((step) => [step.kind, step.line, step.count])).toEqual([
      ['agent', 'Edit', 1],
      ['agent', 'Publish', 3],
      ['check', 'true', 1],
      ['person', 'merged · dropped', 1],
    ])
  })

  it('leaves its own layout alone: a canvas of an older generation kept other things there', () => {
    expect(flowModel(legacy).positions).toEqual({})
  })
})

describe('a rule', () => {
  const roles = [agent('write'), check('verify', 'pnpm verify'), agent('review'), agent('fix'), person('you', ['done'])]
  const rules = (...list: FlowPolicyRule[]) => flowModel(policy(roles, list)).rules

  it('has no word when nothing guards it', () => {
    expect(rules(rule('a', 'write', 'verify'))[0]!.word).toBeNull()
  })

  it('is told by the outcome that takes it', () => {
    const [every, any, many] = rules(
      rule('a', 'review', 'you', { every: ['approve'] }),
      rule('b', 'review', 'fix', { any: ['request-changes'] }),
      rule('c', 'review', 'you', { every: ['approve', 'comment'] }),
    )
    expect([every!.word, any!.word, many!.word]).toEqual(['approve', 'request-changes', 'approve / comment'])
  })

  it('is told by what the desk saw when no outcome guards it', () => {
    const [pr, ci, passed, review, diff, both] = rules(
      rule('a', 'verify', 'you', { evidence: [{ pr: 'open' }] }),
      rule('b', 'verify', 'you', { evidence: [{ ci: 'green' }] }),
      rule('c', 'verify', 'you', { evidence: [{ check: 'pnpm verify' }] }),
      rule('d', 'verify', 'you', { evidence: [{ review: 'picked' }] }),
      rule('e', 'verify', 'you', { evidence: [{ diff: true }] }),
      rule('f', 'verify', 'you', { evidence: [{ pr: 'open' }, { ci: 'green' }] }),
    )
    expect([pr, ci, passed, review, diff, both].map((one) => one!.word)).toEqual([
      'pull request open', 'CI green', 'pnpm verify passed', 'review picked', 'has a diff', 'pull request open + CI green',
    ])
  })

  it('keeps the outcome as the word when evidence guards it too', () => {
    expect(rules(rule('a', 'verify', 'you', { every: ['passed'], evidence: [{ pr: 'open' }] }))[0]!.word).toBe('passed')
  })

  it('says the whole of its guard in a sentence', () => {
    const [none, every, any, both, evidence] = rules(
      rule('a', 'write', 'verify'),
      rule('b', 'review', 'you', { every: ['approve'] }),
      rule('c', 'review', 'fix', { any: ['request-changes', 'comment'] }),
      rule('d', 'review', 'you', { every: ['approve'], any: ['approve'] }),
      rule('e', 'verify', 'you', { every: ['passed'], evidence: [{ pr: 'open' }, { check: 'pnpm verify' }] }),
    )
    expect(none!.when).toBe('Whatever the outcome')
    expect(every!.when).toBe('When every answer says approve')
    expect(any!.when).toBe('When any answer says request-changes or comment')
    expect(both!.when).toBe('When every answer says approve and any answer says approve')
    expect(evidence!.when).toBe('When every answer says passed, the pull request is open and pnpm verify has passed')
  })

  it('is read in the order its file wrote it, between the steps it names', () => {
    const list = rules(rule('first', 'write', 'verify'), rule('second', 'verify', 'review'))
    expect(list.map((one) => [one.id, one.on, one.to])).toEqual([['first', 'write', 'verify'], ['second', 'verify', 'review']])
  })
})

describe('a hand layout', () => {
  it('is read from layout.positions of the current format, defensively', () => {
    const model = flowModel(policy([agent('write'), agent('review')], [], {
      layout: { positions: { write: { x: 40, y: 40 }, review: { x: 300, y: 40 }, ghost: { x: 1, y: 1 }, '__proto__': { x: 1, y: 1 } } },
    }))
    expect(model.positions).toEqual({ write: { x: 40, y: 40 }, review: { x: 300, y: 40 } })
    expect(model.invalidPositions).toBe(true)
  })

  it('is empty, and not wrong, when the file carries none', () => {
    const model = flowModel(policy([agent('write')]))
    expect(model.positions).toEqual({})
    expect(model.invalidPositions).toBe(false)
  })
})

it('names the Flow and its first step', () => {
  const model = flowModel(policy([agent('write'), check('verify', 'true')], [], { seed: { role: 'verify', title: 'Go' } }))
  expect(model.name).toBe('Write, review, fix')
  expect(model.seed).toBe('verify')
})

describe('what a Run ran under', () => {
  const round = (n: number, role: string, seats: readonly string[]) => ({ n, role, seats })
  const seat = (id: string, ceiling: SeatCeiling | null) => ({ id, ceiling })

  it('is read from the seats a step opened, by the role that opened them', () => {
    const ceilings = ceilingsOfRun(
      [round(1, 'write', ['a']), round(2, 'review', ['b', 'c'])],
      [seat('a', ran('edit', 'asked')), seat('b', ran('read', 'held')), seat('c', ran('read', 'held'))],
    )
    expect([...ceilings]).toEqual([['write', ran('edit', 'asked')], ['review', ran('read', 'held')]])
  })

  it('says asked when any seat of a step was only asked, however many held', () => {
    const ceilings = ceilingsOfRun(
      [round(1, 'review', ['a', 'b']), round(2, 'review', ['c'])],
      [seat('a', ran('read', 'held')), seat('b', ran('read', 'asked')), seat('c', ran('read', 'held'))],
    )
    expect(ceilings.get('review')).toEqual(ran('read', 'asked'))
  })

  it('says the narrowest level among a step’s seats, whichever order they came in', () => {
    const seats = [seat('a', ran('publish', 'held')), seat('b', ran('read', 'held')), seat('c', ran('edit', 'asked'))]
    expect(ceilingsOfRun([round(1, 'review', ['a', 'b'])], seats).get('review')).toEqual(ran('read', 'held'))
    expect(ceilingsOfRun([round(1, 'review', ['b', 'a'])], seats).get('review')).toEqual(ran('read', 'held'))
    expect(ceilingsOfRun([round(1, 'review', ['a']), round(2, 'review', ['c'])], seats).get('review')).toEqual(ran('edit', 'asked'))
  })

  it('stays quiet about a step no seat ran, a seat this window does not know, and a seat from before ceilings were recorded', () => {
    const ceilings = ceilingsOfRun([round(1, 'write', ['gone']), round(2, 'review', ['old']), round(3, 'fix', [])], [seat('old', null)])
    expect(ceilings.size).toBe(0)
    expect(flowModel(policy([agent('write', 'edit')]), { ceilings }).steps[0]!.line).toBe('Edit')
  })

  it('stays quiet about a whole step when any one of its seats has no record, however many do', () => {
    const ceilings = ceilingsOfRun(
      [round(1, 'review', ['b', 'c']), round(2, 'review', ['gone']), round(3, 'write', ['a'])],
      [seat('a', ran('edit', 'held')), seat('b', ran('read', 'held')), seat('c', ran('read', 'held'))],
    )
    expect([...ceilings.keys()]).toEqual(['write'])
    expect(flowModel(policy([agent('review', 'read')]), { ceilings }).steps[0]!.line).toBe('Read')
  })
})
