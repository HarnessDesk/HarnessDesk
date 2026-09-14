import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import type { Flow, FlowRole } from '@harnessdesk/protocol'

import {
  dryRun,
  GIT_RULES,
  orderVars,
  parseFlow,
  parseSeat,
  renderFlowTemplate,
  renderOrder,
  ruleFor,
  waitFor,
  seatAt,
  slotsIn,
  validateFlow,
  ORDER_SLOTS,
  BUILT_IN_SLOTS,
  cardVars,
} from '../src/flow.js'

/**
 * The flow, as data.
 *
 * Every function under test is pure — no seat, no request, no board, no clock
 * — which is what makes `dry run` worth trusting: the same `ruleFor` that
 * decides a live round produces the simulation, so the author is shown what
 * will happen rather than a second implementation that agrees for now.
 */

/** This file runs from `dist/test`, so find the checkout rather than count `..`. */
const checkout = (): string => {
  let root = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(root, 'pnpm-workspace.yaml'))) {
    const up = dirname(root)
    assert.notEqual(up, root, 'ran outside the checkout')
    root = up
  }
  return root
}

/** The flows this repository ships, read from where a person would find them. */
const shipped = (name: string): string =>
  readFileSync(join(checkout(), '.harnessdesk', 'flows', name), 'utf8')

const REVIEW = `
name: Fix and review
inputs:
  work: What to fix
roles:
  fixer:
    kind: agent
    seat: cursor=gpt-5.3-codex/xhigh
    permission: publish
    outcomes: [published, cannot]
  reviewer:
    kind: agent
    seat: cursor=gemini-3.8-flash/high
    count: 3
    permission: read
    outcomes: [approve, request-changes]
  referee:
    kind: person
    outcomes: [merged, dropped]
seed:
  role: fixer
  title: "{{work}}"
rules:
  - id: review-it
    on: fixer
    when: { every: published }
    then: { role: reviewer, title: "Review round {{round}} — {{n}} of {{count}}" }
  - id: fix-again
    on: reviewer
    when: { any: request-changes }
    then: { role: fixer, title: "Answer the reviews" }
  - id: hand-over
    on: reviewer
    when: { every: approve }
    then: { role: referee, title: "Merge it" }
`

const read = (source: string) => {
  const { flow, problems } = parseFlow(source)
  assert.ok(flow, `the flow did not parse: ${problems.map((one) => one.text).join('; ')}`)
  return flow
}

const errors = (source: string): string[] => {
  const { flow, problems } = parseFlow(source)
  return [...problems, ...(flow ? validateFlow(flow) : [])]
    .filter((one) => one.level === 'error')
    .map((one) => `${one.at}: ${one.text}`)
}

test('the flow this repository ships reads, and says what a person meant', () => {
  const flow = read(shipped('fix-and-review.yml'))
  assert.equal(flow.name, 'Fix and review')
  assert.deepEqual(
    flow.roles.map((role) => [role.id, role.kind, role.count, role.permission]),
    [
      ['fixer', 'agent', 1, 'publish'],
      ['reviewer', 'agent', 3, 'read'],
      ['referee', 'person', 1, 'read'],
    ],
  )
  assert.equal(seatAt(flow.roles[1]!, 2).model, 'gemini-3.8-flash')
  assert.equal(flow.rules.map((rule) => rule.id).join(','), 'review-it,fix-again,hand-to-the-person')
  assert.deepEqual(validateFlow(flow), [])
})

test('the race flow gives each card of one round its own seat', () => {
  const flow = read(shipped('race.yml'))
  const competitor = flow.roles.find((role) => role.id === 'competitor')!
  assert.equal(competitor.count, 2)
  assert.equal(competitor.isolate, true)
  assert.equal(seatAt(competitor, 0).model, 'gpt-5.3-codex')
  assert.equal(seatAt(competitor, 1).model, 'claude-4.6-opus')
  assert.equal(seatAt(competitor, 1).thinking, true)
  assert.deepEqual(validateFlow(flow), [])
})

test('a reserved layout key is carried and never read', () => {
  const flow = read(shipped('fix-and-review.yml'))
  // Carried, so a canvas that wrote it finds it again…
  assert.deepEqual((flow.layout as Record<string, unknown>)['fixer'], { x: 40, y: 40 })
  // …and invisible to everything that decides anything: the same flow with a
  // different layout dry-runs identically.
  const moved = read(shipped('fix-and-review.yml').replace('x: 40, y: 40', 'x: 900, y: 900'))
  const both = [flow, moved].map((one) => JSON.stringify(dryRun(one).trace))
  assert.equal(both[0], both[1])
})

test('the first matching rule fires, so the unhappy branch can be written first', () => {
  const flow = read(REVIEW)
  assert.equal(ruleFor(flow, 'reviewer', ['approve', 'approve', 'approve'])?.id, 'hand-over')
  assert.equal(ruleFor(flow, 'reviewer', ['approve', 'request-changes', 'approve'])?.id, 'fix-again')
  assert.equal(ruleFor(flow, 'reviewer', ['request-changes', 'request-changes', 'request-changes'])?.id, 'fix-again')
  assert.equal(ruleFor(flow, 'fixer', ['published'])?.id, 'review-it')
  // Nothing claims a fixer that gave up, which is how this loop ends early.
  assert.equal(ruleFor(flow, 'fixer', ['cannot']), null)
  // A round nobody has answered satisfies nothing.
  assert.equal(ruleFor(flow, 'reviewer', [null, 'approve', 'approve']), null)
})

test('dry run spends nothing, and says exactly what opening the flow would cost', () => {
  const report = dryRun(read(REVIEW))
  assert.equal(report.seatingTurns, 4)
  assert.deepEqual(
    report.seats.map((seat) => `${seat.role}#${seat.index} ${seat.seat} ${seat.permission}`),
    [
      'fixer#1 cursor=gpt-5.3-codex/xhigh publish',
      'reviewer#1 cursor=gemini-3.8-flash/high read',
      'reviewer#2 cursor=gemini-3.8-flash/high read',
      'reviewer#3 cursor=gemini-3.8-flash/high read',
    ],
  )
  // The person's step seats nobody and costs nothing.
  assert.ok(!report.seats.some((seat) => seat.role === 'referee'))
})

test('dry run walks both branches, against outcomes the author supplies', () => {
  const flow = read(REVIEW)
  const mixed = dryRun(flow, {
    answers: { fixer: ['published'], reviewer: ['approve,request-changes,approve', 'approve'] },
  })
  assert.deepEqual(
    mixed.trace.map((step) => `${step.role}(${step.outcomes.join('/')})->${step.next ?? 'end'}`),
    [
      'fixer(published)->reviewer',
      'reviewer(approve/request-changes/approve)->fixer',
      'fixer(published)->reviewer',
      'reviewer(approve/approve/approve)->referee',
      'referee(merged)->end',
    ],
  )
  assert.equal(mixed.settled, true)
  // The other branch, from the same flow: the fixer gives up and it is over.
  const early = dryRun(flow, { answers: { fixer: ['cannot'] } })
  assert.deepEqual(early.trace.map((step) => step.role), ['fixer'])
  assert.equal(early.settled, true)
})

test('dry run refuses a flow naming a role that does not exist', () => {
  const found = errors(REVIEW.replace('then: { role: referee, title: "Merge it" }', 'then: { role: nobody, title: "Merge it" }'))
  assert.ok(
    found.some((one) => /rules\[2\]\.then\.role: there is no role called "nobody"/.test(one)),
    found.join('\n'),
  )
  // And the seed's own role, which is the other way to name nothing.
  assert.ok(errors(REVIEW.replace('role: fixer\n  title', 'role: ghost\n  title')).some((one) => /seed\.role/.test(one)))
})

test('dry run refuses a loop with no exit, and names where it is stuck', () => {
  // A reviewer that can only ever say approve, and an approve that goes back
  // to the fixer: nothing either of them can answer ends the run.
  const stuck = `
name: Never ends
roles:
  fixer:
    kind: agent
    seat: cursor
    outcomes: [published]
  reviewer:
    kind: agent
    seat: cursor
    count: 3
    outcomes: [approve]
seed: { role: fixer, title: Fix }
rules:
  - { id: to-review, on: fixer, when: { every: published }, then: { role: reviewer, title: Review } }
  - { id: to-fix, on: reviewer, when: { every: approve }, then: { role: fixer, title: Fix again } }
`
  const found = errors(stuck)
  assert.ok(found.some((one) => /this loop has no way out/.test(one)), found.join('\n'))
  assert.ok(found.some((one) => /fixer/.test(one) && /reviewer/.test(one)), found.join('\n'))

  // The control: give the reviewer one answer no rule claims, and the same
  // flow is fine. So the check is about the exit and not about the shape.
  assert.deepEqual(errors(stuck.replace('outcomes: [approve]', 'outcomes: [approve, request-changes]')), [])
})

test('a rule an earlier rule already shadows can never fire, and is refused', () => {
  const shadowed = REVIEW.replace(
    '  - id: fix-again\n    on: reviewer\n    when: { any: request-changes }',
    '  - id: catch-all\n    on: reviewer\n    then: { role: fixer, title: Anything }\n  - id: fix-again\n    on: reviewer\n    when: { any: request-changes }',
  )
  const found = errors(shadowed)
  assert.ok(found.some((one) => /nothing reviewer can answer reaches this rule/.test(one)), found.join('\n'))
})

test('a rule branching on a word its role never answers is refused', () => {
  const found = errors(REVIEW.replace('{ any: request-changes }', '{ any: looks-fine }'))
  assert.ok(
    found.some((one) => /reviewer never answers "looks-fine"/.test(one)),
    found.join('\n'),
  )
})

test('a template slot nothing fills is refused, with what would have filled it', () => {
  const found = errors(REVIEW.replace('title: "{{work}}"', 'title: "{{issue}}"'))
  assert.ok(found.some((one) => /nothing fills \{\{issue\}\}/.test(one)), found.join('\n'))
  // A declared input and every built-in slot resolve.
  assert.deepEqual(errors(REVIEW), [])
})

test('a role that is the wrong kind for what it declares is refused', () => {
  assert.ok(errors(REVIEW.replace('  referee:\n    kind: person', '  referee:\n    kind: agent')).some((one) => /roles\.referee\.seat: an agent role needs a seat/.test(one)))
  assert.ok(
    errors(REVIEW.replace('    kind: person\n    outcomes', '    kind: person\n    seat: cursor\n    outcomes: [merged]\n    outcomes2')).length > 0,
  )
})

test('a check is a command, and its exit status is the outcome', () => {
  const flow = read(`
name: Gate it
roles:
  fixer: { kind: agent, seat: cursor, outcomes: [published, cannot] }
  tests:
    kind: check
    run: pnpm verify
    timeout: 1200
    exits: { 0: pass }
    otherwise: fail
seed: { role: fixer, title: Fix }
rules:
  - { id: gate, on: fixer, when: { every: published }, then: { role: tests, title: Run the gate } }
  - { id: back, on: tests, when: { any: fail }, then: { role: fixer, title: Make it pass } }
`)
  const tests = flow.roles.find((role) => role.id === 'tests')!
  assert.equal(tests.check?.run, 'pnpm verify')
  assert.equal(tests.check?.timeout, 1200)
  // The vocabulary comes from the exits when the role does not declare one.
  assert.deepEqual([...tests.outcomes].sort(), ['fail', 'pass'])
  assert.deepEqual(validateFlow(flow), [])
  // And the dry run prints the command, verbatim, before anything runs it.
  assert.deepEqual(dryRun(flow, { repo: '/work' }).commands, [
    { role: 'tests', run: 'pnpm verify', cwd: '/work' },
  ])
})

test('an agent role that may merge is flagged, and is not an error', () => {
  const { flow } = parseFlow(REVIEW.replace('  referee:\n    kind: person', '  referee:\n    kind: agent\n    seat: cursor\n    permission: merge'))
  const found = validateFlow(flow!)
  assert.equal(found.filter((one) => one.level === 'error').length, 0)
  assert.ok(found.some((one) => one.level === 'warning' && /unattended/.test(one.text)))
})

// ------------------------------------------------------------ standing orders

test('a read role is told not to push; a publish role is told exactly what it may push', () => {
  const flow = read(REVIEW)
  const where = { name: 'Codex', member: 'Codex', room: 'Fix room', repo: '/work/repo', runtime: 'cursor' }
  const fixer = renderOrder(orderVars(flow.roles[0]!, flow, where))
  const reviewer = renderOrder(orderVars(flow.roles[1]!, flow, where))

  assert.match(reviewer, /never push, never merge, never reset or force anything/)
  assert.doesNotMatch(reviewer, /You publish\./)

  assert.match(fixer, /You publish\./)
  assert.match(fixer, /push \*\*your own branch\*\*/)
  assert.match(fixer, /You may not merge anything/)
  assert.doesNotMatch(fixer, /never push, never merge/)

  // Both carry the outcomes their role declared, because the order is the one
  // place a seat is told what words decide what happens next.
  assert.match(fixer, /exactly one of published, cannot/)
  assert.match(reviewer, /exactly one of approve, request-changes/)
})

test('a slot inside a slot is expanded, and an unknown slot is left standing', () => {
  // The git rule is a paragraph that itself says {{repo}}: one pass of
  // String.replace never re-scans what it substituted, and a seat was handed a
  // literal {{repo}}.
  assert.ok(GIT_RULES.read.includes('{{repo}}'))
  const flow = read(REVIEW)
  const order = renderOrder(
    orderVars(flow.roles[1]!, flow, { name: 'Gemini', member: 'Gemini', room: 'Fix room', repo: '/work/repo', runtime: 'cursor' }),
  )
  assert.doesNotMatch(order, /\{\{repo\}\}/)
  assert.match(order, /Stay inside \/work\/repo\./)

  // And a slot with no value stays visible rather than becoming a gap, so a
  // seat reading "Take card {{card}}" knows the hand-out was wrong.
  assert.equal(renderFlowTemplate('Take card {{card}} in {{repo}}', { repo: '/work' }), 'Take card {{card}} in /work')
  // A value that names itself terminates rather than spinning.
  assert.equal(renderFlowTemplate('{{a}}', { a: '{{a}}' }), '{{a}}')
})

test('a permission is read off the role every time an order is rendered', () => {
  // The bug this guards: a seat re-armed after its turn died came back quietly
  // demoted, and then refused the card it was seated for. Nothing stores the
  // rendered text, so the second rendering is the first one again.
  const flow = read(REVIEW)
  const where = { name: 'Codex', member: 'Codex', room: 'Fix room', repo: '/work/repo', runtime: 'cursor' }
  const first = renderOrder(orderVars(flow.roles[0]!, flow, where))
  const again = renderOrder(orderVars(flow.roles[0]!, flow, where))
  assert.equal(first, again)
  assert.match(again, /You publish\./)
})

test('a seat is told a block its own agent will hold open', () => {
  // Measured, not guessed: Cursor's MCP client times a tool call out at 60
  // seconds, so every seat's first `await_work` in the first live run of this
  // came back `MCP error -32001: Request timed out` and each model then
  // invented its own block. The flow may ask for four minutes; what a Cursor
  // seat is told is fifty seconds.
  assert.equal(waitFor('cursor', 240), 50)
  assert.equal(waitFor('cursor', 20), 20)
  // An agent nobody has measured keeps the conservative figure rather than
  // the flow's own — a ceiling nobody has measured is one this cannot claim.
  assert.equal(waitFor('some-new-agent', 600), 50)

  const flow = read(REVIEW)
  const order = renderOrder(
    orderVars(flow.roles[1]!, flow, {
      name: 'Gemini',
      member: 'Gemini',
      room: 'Fix room',
      repo: '/work/repo',
      runtime: 'cursor',
    }),
  )
  assert.match(order, /block_ms: 50000/)
  assert.doesNotMatch(order, /\{\{blockMs\}\}/)
})

test('a model id with a slash in it is written as a map, not compactly', () => {
  // A whole family of agents has them: Cline's catalogue is
  // `deepseek/deepseek-v4-flash`, `zai/glm-5.3-flash`. The compact form
  // splits the effort off after a `/`, so it cannot express one — and the two
  // readings are genuinely ambiguous without the runtime's model list.
  const compact = parseSeat('cline=deepseek/deepseek-v4-flash')
  assert.notEqual(typeof compact, 'string')
  assert.equal((compact as { model?: string }).model, 'deepseek', 'the compact form reads it as a model and an effort')

  const flow = read(`
name: Cheap seats
roles:
  worker:
    kind: agent
    seat:
      runtime: cline
      model: deepseek/deepseek-v4-flash
    outcomes: [done]
seed: { role: worker, title: Do it }
`)
  assert.deepEqual(seatAt(flow.roles[0]!, 0), { runtime: 'cline', model: 'deepseek/deepseek-v4-flash' })
  assert.deepEqual(validateFlow(flow), [])
})

test('a list of seats may mix the two forms', () => {
  const flow = read(`
name: Mixed
roles:
  competitor:
    kind: agent
    count: 2
    seat:
      - cursor=gpt-5.3-codex/xhigh
      - { runtime: cline, model: zai/glm-5.3-flash }
    outcomes: [done]
seed: { role: competitor, title: "Attempt {{n}}" }
`)
  assert.equal(seatAt(flow.roles[0]!, 0).effort, 'xhigh')
  assert.equal(seatAt(flow.roles[0]!, 1).model, 'zai/glm-5.3-flash')
  assert.equal(seatAt(flow.roles[0]!, 1).effort, undefined)
})

test('card slots are refused in a role order, naming why', () => {
  const source = `
name: probe
inputs:
  codename:
    label: The hunter's name
    default: mantis
wait: 60
roles:
  hunter:
    kind: agent
    seat: cursor=gemini-3.8-flash/high
    count: 1
    permission: read
    outcomes: [done]
    order: |
      You are {{codename}}, on round {{round}}, card {{n}} of {{count}}, in run {{run}}.
seed:
  role: hunter
  title: "go"
`
  const errs = errors(source)
  assert.ok(
    errs.some(
      (e) =>
        e.includes('roles.hunter.order') &&
        e.includes(
          '{{round}} is the round a card belongs to, and an order is handed out before any round has run — it only means something on a card',
        ),
    ),
    `expected {{round}} error in order, got: ${errs.join('; ')}`,
  )
  assert.ok(
    errs.some(
      (e) =>
        e.includes('roles.hunter.order') &&
        e.includes(
          '{{n}} is the round a card belongs to, and an order is handed out before any round has run — it only means something on a card',
        ),
    ),
    `expected {{n}} error in order, got: ${errs.join('; ')}`,
  )
  assert.ok(
    errs.some(
      (e) =>
        e.includes('roles.hunter.order') &&
        e.includes(
          '{{count}} is the round a card belongs to, and an order is handed out before any round has run — it only means something on a card',
        ),
    ),
    `expected {{count}} error in order, got: ${errs.join('; ')}`,
  )
  // Declared input {{codename}} and built-in {{run}} are allowed in order
  assert.ok(!errs.some((e) => e.includes('{{codename}}')))
  assert.ok(!errs.some((e) => e.includes('{{run}}')))
})

test('a declared input and run id resolve in a role order', () => {
  const source = `
name: probe
inputs:
  codename:
    label: The hunter's name
    default: mantis
wait: 60
roles:
  hunter:
    kind: agent
    seat: cursor=gemini-3.8-flash/high
    count: 1
    permission: read
    outcomes: [done]
    order: |
      You are {{codename}} in run {{run}}.
seed:
  role: hunter
  title: "go"
`
  const flow = read(source)
  // With input default and run id passed in where
  const defaultOrder = renderOrder(
    orderVars(flow.roles[0]!, flow, {
      name: 'Gemini 1',
      member: 'Gemini 1',
      room: 'a room',
      repo: '/repo',
      runtime: 'cursor',
      run: 'flow-1234',
    }),
  )
  assert.match(defaultOrder, /You are mantis in run flow-1234\./)

  // With explicit vars overriding default
  const customOrder = renderOrder(
    orderVars(flow.roles[0]!, flow, {
      name: 'Gemini 1',
      member: 'Gemini 1',
      room: 'a room',
      repo: '/repo',
      runtime: 'cursor',
      run: 'flow-5678',
      vars: { codename: 'grasshopper' },
    }),
  )
  assert.match(customOrder, /You are grasshopper in run flow-5678\./)
})

test("every shipped flow's role order renders with no unresolved slots", () => {
  for (const name of ['fix-and-review.yml', 'race.yml']) {
    const flow = read(shipped(name))
    for (const role of flow.roles) {
      if (role.kind !== 'agent') continue
      const order = renderOrder(
        orderVars(role, flow, {
          name: 'Agent',
          member: 'Agent',
          room: 'Room',
          repo: '/repo',
          runtime: 'cursor',
          run: 'flow-test',
        }),
      )
      const remainingSlots = slotsIn(order)
      assert.deepEqual(
        remainingSlots,
        [],
        `flow ${name} role ${role.id} order has unresolved slots: ${remainingSlots.join(', ')}`,
      )
    }
  }
})

test('top-level rearm is parsed, defaulted, and validated against ceiling', () => {
  const valid = `
name: Rearm test
rearm: 10
roles:
  worker: { kind: agent, seat: cursor, outcomes: [done] }
seed: { role: worker, title: Work }
`
  const parsed = parseFlow(valid)
  assert.equal(parsed.flow?.rearm, 10)
  assert.deepEqual(validateFlow(parsed.flow!), [])

  // Refuses negative
  const negative = `
name: Rearm negative
rearm: -1
roles:
  worker: { kind: agent, seat: cursor, outcomes: [done] }
seed: { role: worker, title: Work }
`
  assert.ok(errors(negative).some((e) => /rearm/.test(e)))

  // Refuses non-integer
  const nonInt = `
name: Rearm float
rearm: 2.5
roles:
  worker: { kind: agent, seat: cursor, outcomes: [done] }
seed: { role: worker, title: Work }
`
  assert.ok(errors(nonInt).some((e) => /rearm/.test(e)))

  // Refuses exceeding ceiling
  const overCeiling = `
name: Rearm huge
rearm: 500
roles:
  worker: { kind: agent, seat: cursor, outcomes: [done] }
seed: { role: worker, title: Work }
`
  assert.ok(errors(overCeiling).some((e) => /rearm.*exceed/.test(e)))
})

test('a role order with {{name}}, {{member}}, and {{seat}} validates clean (#528)', () => {
  const yaml = `
name: Review flow
inputs: []
roles:
  reviewer:
    kind: agent
    seat: cursor
    count: 1
    permission: read
    outcomes: [approve, request-changes]
    order: |
      You are {{name}} (member: {{member}}).
      Sign your review with {{seat}}.
seed:
  role: reviewer
  title: Review round
rules: []
wait: {}
`
  const { flow } = parseFlow(yaml)
  const problems = validateFlow(flow!)
  assert.deepEqual(problems, [])
})

test('orderVars provides seat, name, and member, and renderOrder substitutes them (#528)', () => {
  const yaml = `
name: Review flow
inputs: []
roles:
  reviewer:
    kind: agent
    seat: cursor
    count: 1
    permission: read
    outcomes: [approve]
    order: "Seat: {{seat}}, Name: {{name}}, Member: {{member}}"
seed:
  role: reviewer
  title: Review round
rules: []
wait: {}
`
  const { flow } = parseFlow(yaml)
  const vars = orderVars(flow!.roles[0]!, flow!, {
    name: 'Gemini',
    member: 'Gemini in room',
    seat: 'Cursor · Gemini 3.8 Flash · High',
    room: 'Fix room',
    repo: '/work',
    runtime: 'cursor',
  })
  assert.equal(vars.seat, 'Cursor · Gemini 3.8 Flash · High')
  const rendered = renderOrder(vars)
  assert.match(rendered, /Seat: Cursor · Gemini 3\.8 Flash · High, Name: Gemini, Member: Gemini in room/)
})

test('ORDER_SLOTS contains all built-in keys produced by orderVars (#528)', () => {
  const yaml = `
name: Simple flow
inputs: []
roles:
  worker:
    kind: agent
    seat: cursor
    outcomes: [done]
seed:
  role: worker
  title: Simple
rules: []
`
  const { flow } = parseFlow(yaml)
  const vars = orderVars(flow!.roles[0]!, flow!, {
    name: 'Name',
    member: 'Member',
    seat: 'Seat',
    room: 'Room',
    repo: 'Repo',
    runtime: 'Runtime',
    run: 'Run',
  })
  const producedKeys = Object.keys(vars)
  for (const slot of ORDER_SLOTS) {
    assert.ok(producedKeys.includes(slot), `ORDER_SLOTS includes ${slot} which orderVars produces`)
  }
  for (const key of producedKeys) {
    assert.ok(ORDER_SLOTS.includes(key as never), `orderVars produces ${key} which is in ORDER_SLOTS`)
  }
})

test('BUILT_IN_SLOTS contains all base card keys produced by cardVars (#528)', () => {
  const vars = cardVars({
    flow: 'Flow',
    run: 'Run',
    room: 'Room',
    repo: 'Repo',
    role: 'Role',
    round: 1,
    n: 1,
    count: 3,
  })
  const producedKeys = Object.keys(vars)
  for (const slot of BUILT_IN_SLOTS) {
    assert.ok(producedKeys.includes(slot), `BUILT_IN_SLOTS includes ${slot} which cardVars produces`)
  }
  for (const key of producedKeys) {
    assert.ok(BUILT_IN_SLOTS.includes(key as never), `cardVars produces ${key} which is in BUILT_IN_SLOTS`)
  }
})

test('parseFlow accepts flow orders containing "---" front matter and markdown dividers (#432)', () => {
  const yaml = `
name: Front matter flow
roles:
  fixer:
    kind: agent
    seat: cursor
    outcomes: [done]
    order: |
      Start with YAML front matter:
      ---
      hunter: dragonfly
      ---
      Markdown separator:
      ---
      Ellipsis:
      ...
seed:
  role: fixer
  title: Start
rules: []
`
  const { flow, problems } = parseFlow(yaml)
  assert.equal(problems.length, 0)
  assert.ok(flow !== null)
  assert.equal(flow?.name, 'Front matter flow')
  assert.match(flow?.roles[0]?.order ?? '', /---/)
})

test('validateFlow accepts unconditional rule on role without outcomes (#443)', () => {
  const yaml = `
name: Pipeline flow
roles:
  builder:
    kind: agent
    seat: cursor
    outcomes: []
  deployer:
    kind: agent
    seat: cursor
    outcomes: []
seed:
  role: builder
  title: Build project
rules:
  - id: deploy
    on: builder
    then:
      role: deployer
      title: Deploy project
`
  const { flow, problems } = parseFlow(yaml)
  assert.equal(problems.length, 0)
  assert.ok(flow !== null)
  const validationProblems = validateFlow(flow!)
  assert.deepEqual(
    validationProblems,
    [],
    `expected valid pipeline flow without outcomes to pass validation, but got: ${validationProblems.map((p) => p.text).join('; ')}`,
  )
})

test('validateFlow rejects shadowed rule on role without outcomes (#443)', () => {
  const yaml = `
name: Pipeline flow
roles:
  builder:
    kind: agent
    seat: cursor
    outcomes: []
  deployer:
    kind: agent
    seat: cursor
    outcomes: []
  archiver:
    kind: agent
    seat: cursor
    outcomes: []
seed:
  role: builder
  title: Build project
rules:
  - id: deploy
    on: builder
    then:
      role: deployer
      title: Deploy project
  - id: archive
    on: builder
    then:
      role: archiver
      title: Archive project
`
  const { flow, problems } = parseFlow(yaml)
  assert.equal(problems.length, 0)
  assert.ok(flow !== null)
  const validationProblems = validateFlow(flow!)
  assert.equal(validationProblems.length, 1)
  assert.equal(validationProblems[0]?.at, 'rules[1]')
  assert.match(validationProblems[0]?.text ?? '', /nothing builder can answer reaches this rule/)
})

