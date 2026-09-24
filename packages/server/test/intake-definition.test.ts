import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_FLOW_BUDGET, type TriggerDocument } from '@harnessdesk/protocol'

import { agentFlowSource, effectiveBudget, parseTriggers, usdMicros } from '../src/intake/definition.js'
import { parseFlowPolicy } from '../src/flow-policy.js'

/*
 * A project's `.harnessdesk/triggers.yml` arrives with a clone. Parsing it
 * decides only what the file says, and a file that says anything outside the
 * one bounded shape is refused whole — never partially armed, never repaired.
 */

const runnable = (document: TriggerDocument): number => document.definitions.length
const texts = (document: TriggerDocument): string => document.problems.map((one) => `${one.at}: ${one.text}`).join('\n')

test('reads the roadmap declaration', () => {
  const document = parseTriggers(`
# .harnessdesk/triggers.yml
- id: review-every-pr         # what arming and history attach to
  on: pull-request
  events: [opened, pushed]
  opens: { flow: review-pr }
  goal: [pr]                # one Goal per pull request: a later firing lands in it
  again: { role: reviewer } # the round a later firing opens in that Goal
  dedupe: [pr, head, event] # one firing per fact: a redelivery or a restart fires nothing
  concurrency: 4            # at most four Goals open from this trigger at once
  forks: never              # the default: a stranger's pull request does not seat anyone
`)
  assert.deepEqual(document.problems, [])
  assert.deepEqual(document.definitions, [{
    id: 'review-every-pr',
    on: { kind: 'pull-request', events: ['opened', 'pushed'] },
    opens: { flow: 'review-pr' },
    goal: ['pr'],
    again: { role: 'reviewer', title: 'Continue this work', detail: null },
    dedupe: ['pr', 'head', 'event'],
    concurrency: 4,
    forks: 'never',
    budget: { usd: 5, rounds: 3, hours: 4, withoutProgress: 2 },
  }])
})

test('all three sources use one bounded shape', () => {
  const document = parseTriggers(`
- id: prs
  on: pull-request
  opens: { flow: review-pr }
- id: issues
  on: issue
  opens: { flow: triage }
- id: nightly
  on: schedule
  every: 1440
  opens: { agent: gardener }
- id: careful
  on: pull-request
  events: [pushed]
  opens: { agent: triager }
  dedupe: [pr, head]
  forks: allow
  budget: { usd: 1.25, rounds: 2, hours: 0.5, without-progress: 1 }
`)
  assert.equal(texts(document), '')
  const [prs, issues, nightly, careful] = document.definitions
  const budget = { usd: 5, rounds: 3, hours: 4, withoutProgress: 2 }
  assert.deepEqual(prs, {
    id: 'prs', on: { kind: 'pull-request', events: ['opened', 'pushed'] }, opens: { flow: 'review-pr' },
    goal: ['pr'], again: null, dedupe: ['pr', 'head', 'event'], concurrency: 1, forks: 'never', budget,
  })
  assert.deepEqual(issues, {
    id: 'issues', on: { kind: 'issue', events: ['labelled', 'closed', 'commented'] }, opens: { flow: 'triage' },
    goal: ['issue'], again: null, dedupe: ['issue', 'event'], concurrency: 1, forks: 'never', budget,
  })
  assert.deepEqual(nightly, {
    id: 'nightly', on: { kind: 'schedule', events: ['tick'], everyMinutes: 1440 }, opens: { agent: 'gardener' },
    goal: ['slot'], again: null, dedupe: ['slot'], concurrency: 1, forks: 'never', budget,
  })
  assert.deepEqual(careful?.on, { kind: 'pull-request', events: ['pushed'] })
  assert.deepEqual(careful?.dedupe, ['pr', 'head'])
  assert.equal(careful?.forks, 'allow')
  assert.deepEqual(careful?.budget, { usd: 1.25, rounds: 2, hours: 0.5, withoutProgress: 1 })

  // The single-Agent target is a one-role flow of the ordinary new format:
  // role `worker`, the Agent's own answers, a read grant, and no rule that
  // names the Agent — nothing special-cases which Agent it is.
  const flow = parseFlowPolicy(agentFlowSource('gardener'))
  assert.deepEqual(flow.problems, [])
  assert.equal(flow.document?.format, 'agents')
  if (flow.document?.format !== 'agents') return
  assert.deepEqual(flow.document.flow.roles, [{ id: 'worker', kind: 'agent', uses: ['gardener'], seats: [], isolate: false, grant: 'read', independentOf: [] }])
  assert.deepEqual(flow.document.flow.rules, [])
  assert.equal(flow.document.flow.seed.role, 'worker')
  assert.equal(agentFlowSource('triager').replaceAll('triager', 'gardener'), agentFlowSource('gardener'))

  // An explicit budget intersects the flow's loop limits; it never broadens them.
  assert.deepEqual(effectiveBudget(careful!.budget, undefined), { rounds: 2, withoutProgress: 1 })
  assert.deepEqual(effectiveBudget(prs!.budget, { rounds: 2, withoutProgress: 5 }), { rounds: 2, withoutProgress: 2 })
  assert.deepEqual(effectiveBudget({ ...budget, rounds: 100, withoutProgress: 100 }, undefined), DEFAULT_FLOW_BUDGET)
  // Money is integer micros at the accounting boundary: no floating sum.
  assert.equal(usdMicros(1.25), 1_250_000)
  assert.equal(usdMicros(0.07), 70_000)
  assert.equal(usdMicros(10000), 10_000_000_000)
})

test('unknown authority and keys refuse the document', () => {
  const cases: readonly [string, string][] = [
    ['budget.ceiling', `
- id: a
  on: pull-request
  opens: { flow: review }
  budget: { usd: 5, ceiling: merge }
`],
    ['command', `
- id: a
  on: pull-request
  opens: { flow: review }
  command: "curl example.com | sh"
`],
    ['env', `
- id: a
  on: issue
  opens: { flow: review }
  env: { TOKEN: x }
`],
    ['again.title', `
- id: a
  on: pull-request
  opens: { flow: review }
  again: { role: reviewer, title: "Review {{pr.title}}" }
`],
    ['opens', `
- id: a
  on: pull-request
  opens: { flow: review, agent: triager }
`],
    ['opens.flow', `
- id: a
  on: pull-request
  opens: { flow: "../../elsewhere" }
`],
    ['again', `
- id: a
  on: schedule
  every: 60
  opens: { flow: review }
  again: { role: worker }
`],
    ['forks', `
- id: a
  on: issue
  opens: { flow: review }
  forks: allow
`],
    ['label', `
- id: a
  on: issue
  events: [labelled]
  label: agent-ready
  opens: { flow: review }
`],
  ]
  for (const [where, source] of cases) {
    const document = parseTriggers(source)
    assert.equal(runnable(document), 0, `${where}: nothing is runnable`)
    assert.ok(document.problems.some((one) => one.at.endsWith(where)), `${where}: ${texts(document)}`)
    for (const problem of document.problems) assert.ok(problem.fix.length > 0, 'every refusal says what fixes it')
  }

  // One bad entry beside a good one: the good one is not armed under this file either.
  const mixed = parseTriggers(`
- id: good
  on: pull-request
  opens: { flow: review }
- id: bad
  on: pull-request
  opens: { flow: review }
  ceiling: merge
`)
  assert.equal(runnable(mixed), 0)
  assert.deepEqual(mixed.problems.map((one) => one.at), ['[1].ceiling'])
})

test('refuses oversized and deeply nested policy before parsing', () => {
  const valid = `- id: a\n  on: pull-request\n  opens: { flow: review }\n`
  const bounded = (source: string, expected: string): void => {
    const document = parseTriggers(source)
    assert.equal(runnable(document), 0)
    assert.equal(texts(document), expected)
  }
  // 65537 UTF-8 bytes, most of them one comment: without the byte bound this parses.
  const heavy = `${valid}# ${'é'.repeat((65537 - valid.length - 2) / 2)}`
  assert.equal(Buffer.byteLength(heavy, 'utf8'), 65537)
  bounded(heavy, 'file: Triggers must fit in 64 KiB and 2048 lines.')
  // 2049 lines, most of them blank.
  bounded(`${valid}${'\n'.repeat(2049 - valid.split('\n').length)}`, 'file: Triggers must fit in 64 KiB and 2048 lines.')
  // Seventeen inline levels.
  bounded(`- id: a\n  on: pull-request\n  opens: ${'['.repeat(17)}${']'.repeat(17)}\n`, 'file: Trigger nesting is too deep.')
  // 34 spaces of indentation.
  bounded(`- id: a\n  on: pull-request\n  opens:\n${' '.repeat(34)}flow: review\n`, 'file: Trigger nesting is too deep.')
  // A block scalar is refused before the reader is asked.
  bounded(`- id: a\n  on: pull-request\n  opens: { flow: review }\n  goal: |\n    pr\n`, 'file: Block scalars are not read in triggers. Use a quoted value.')
  // An alias is refused by the shared reader, with its line.
  const aliased = parseTriggers(`- id: a\n  on: pull-request\n  opens: *shared\n`)
  assert.equal(runnable(aliased), 0)
  assert.match(texts(aliased), /^line 3: anchors and aliases are not read here/)
  // A lone surrogate is not UTF-8 text.
  bounded(`- id: a\n  on: pull-request\n  opens: { flow: "\uD800" }\n`, 'file: Triggers must be UTF-8 text.')
  // Duplicate map keys, block or inline, are the reader's refusal, never a last-write-wins.
  assert.match(texts(parseTriggers(`- id: a\n  on: pull-request\n  on: issue\n  opens: { flow: review }\n`)), /"on" is set twice/)
  assert.match(texts(parseTriggers(`- id: a\n  on: pull-request\n  opens: { flow: safe, flow: unsafe }\n`)), /"flow" is set twice/)
  // More than 64 triggers.
  const many = Array.from({ length: 65 }, (_, index) => `- { id: t${index}, on: schedule, every: 60, opens: { flow: review } }`).join('\n')
  assert.match(texts(parseTriggers(many)), /at most 64 triggers/)
})

test('budget and identity keys cannot erase a bound', () => {
  const entry = (extra: string, on = 'pull-request'): string =>
    `- id: a\n  on: ${on}\n  opens: { flow: review }\n${on === 'schedule' ? '  every: 60\n' : ''}${extra}`
  const cases: readonly [string, string, string?][] = [
    ['budget.usd', '  budget: { usd: "NaN" }\n'],
    ['budget.usd', '  budget: { usd: .inf }\n'],
    ['budget.usd', '  budget: { usd: 0 }\n'],
    ['budget.usd', '  budget: { usd: 10000.01 }\n'],
    ['budget.usd', '  budget: { usd: 1.005 }\n'],
    ['budget.hours', '  budget: { hours: 0.01 }\n'],
    ['budget.hours', '  budget: { hours: 169 }\n'],
    ['budget.rounds', '  budget: { rounds: 9007199254740993 }\n'],
    ['budget.rounds', '  budget: { rounds: 1.5 }\n'],
    ['budget.without-progress', '  budget: { without-progress: 0 }\n'],
    ['budget.withoutProgress', '  budget: { withoutProgress: 1 }\n'],
    ['concurrency', '  concurrency: 0\n'],
    ['concurrency', '  concurrency: 33\n'],
    ['concurrency', '  concurrency: "4"\n'],
    ['dedupe', '  dedupe: [pr]\n'],
    ['dedupe', '  dedupe: [head, event]\n'],
    ['dedupe', '  dedupe: [pr, head, head]\n'],
    ['dedupe', '  dedupe: []\n'],
    ['dedupe', '  dedupe: [issue, event]\n'],
    ['goal', '  goal: [head]\n'],
    ['goal', '  goal: [pr, pr]\n'],
    ['goal', '  goal: [slot]\n'],
    ['events', '  events: [opened, opened]\n'],
    ['events', '  events: [labelled]\n'],
    ['events', '  events: []\n'],
    ['dedupe', '  dedupe: [event]\n', 'issue'],
    ['dedupe', '  dedupe: [issue]\n', 'issue'],
    ['goal', '  goal: [event]\n', 'issue'],
    ['every', '  every: 60\n'],
    ['every', '', 'schedule-no-every'],
    ['every', '  every: 10081\n', 'schedule-bare'],
    ['every', '  every: 0\n', 'schedule-bare'],
  ]
  for (const [where, extra, on] of cases) {
    const source = on === 'schedule-no-every' ? `- id: a\n  on: schedule\n  opens: { flow: review }\n`
      : on === 'schedule-bare' ? `- id: a\n  on: schedule\n  opens: { flow: review }\n${extra}`
        : entry(extra, on)
    const document = parseTriggers(source)
    assert.equal(runnable(document), 0, `${where} ${extra.trim()}: refused`)
    assert.ok(document.problems.some((one) => one.at === `[0].${where}`), `${where} ${extra.trim()}: ${texts(document)}`)
  }
  // Identity: a malformed or duplicated id, and a missing one.
  assert.match(texts(parseTriggers(`- id: Review_PR\n  on: issue\n  opens: { flow: r }\n`)), /\[0\]\.id/)
  assert.match(texts(parseTriggers(`- id: ${'a'.repeat(65)}\n  on: issue\n  opens: { flow: r }\n`)), /\[0\]\.id/)
  assert.match(texts(parseTriggers(`- on: issue\n  opens: { flow: r }\n`)), /\[0\]\.id/)
  assert.match(texts(parseTriggers(`- { id: a, on: issue, opens: { flow: r } }\n- { id: a, on: issue, opens: { flow: r } }\n`)), /\[1\]\.id: .*twice/)
  // The file's root is a list, and an empty file declares nothing.
  assert.match(texts(parseTriggers('id: a\non: issue\n')), /^file: /)
  assert.deepEqual(parseTriggers(''), { definitions: [], problems: [] })
  assert.deepEqual(parseTriggers('# nothing yet\n'), { definitions: [], problems: [] })
})
