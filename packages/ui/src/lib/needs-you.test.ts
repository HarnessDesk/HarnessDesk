import { describe, expect, it } from 'vitest'
import { approvalId, sessionId, type Approval, type FlowExecution, type FlowPolicyRole, type FlowPolicyRule, type Intent } from '@harnessdesk/protocol'
import { abandonable, abandonEffect, approvalDoor, stepDoor } from './needs-you'

const roles: FlowPolicyRole[] = [
  { id: 'writer', kind: 'agent', uses: ['writer'], seats: [], isolate: false, grant: 'edit', independentOf: [] },
  { id: 'reviewer', kind: 'agent', uses: ['reviewer'], seats: [], isolate: false, grant: 'read', independentOf: [] },
  { id: 'fixer', kind: 'agent', uses: ['fixer'], seats: [], isolate: false, grant: 'edit', independentOf: [] },
  { id: 'verify', kind: 'check', check: { run: 'pnpm verify', timeout: 60, exits: { '0': 'pass' }, otherwise: 'fail' } },
  { id: 'decide', kind: 'person', outcomes: ['approved', 'request-changes'] },
  { id: 'referee', kind: 'person', outcomes: [] },
]
const rule = (id: string, on: string, then: string, when?: FlowPolicyRule['when']): FlowPolicyRule => ({
  id, on, ...(when ? { when } : {}), then: { role: then, title: `Open ${then}` },
})
const run = (patch: Partial<FlowExecution> = {}, rules: readonly FlowPolicyRule[] = [], extraRoles: readonly FlowPolicyRole[] = []): FlowExecution => ({
  version: 2, id: 'run-1', goal: 'team-1', state: 'running', reason: null, legacyRun: null, operations: [],
  rounds: [{ n: 3, role: 'decide', cards: [7], seats: [], evidence: [], state: 'running', cause: 'seed' }],
  document: { format: 'agents', flow: {
    version: 2, name: 'Build and review', inputs: [], roles: [...roles, ...extraRoles], rules, seed: { role: 'writer', title: 'Start' }, messaging: 'board-only', wait: 240,
  } },
  ...patch,
})
const card = (id: number, patch: Partial<Intent> = {}): Intent => ({
  id, title: `Card ${id}`, state: 'open', files: [], dependsOn: [], createdAt: 1, updatedAt: 2, role: 'decide', ...patch,
})
const decideRules = [
  rule('ship', 'decide', 'verify', { every: ['approved'] }),
  rule('rework', 'decide', 'fixer', { every: ['request-changes'] }),
]

describe('a person step', () => {
  it('offers each word its role declares, with what the Flow does after it', () => {
    const door = stepDoor(card(7), run({}, decideRules))
    expect(door).toEqual({ kind: 'answer', card: 7, answers: [
      { outcome: 'approved', effect: 'Approved opens the verify check.' },
      { outcome: 'request-changes', effect: 'Request changes opens a fixer round.' },
    ] })
  })

  it('says a step for you when the next role is a person, and a round when it is an agent', () => {
    const door = stepDoor(card(7), run({}, [rule('again', 'decide', 'referee', { every: ['approved'] }), rule('rework', 'decide', 'writer', { every: ['request-changes'] })]))
    expect(door?.kind === 'answer' && door.answers.map((one) => one.effect)).toEqual([
      'Approved opens a step for you.', 'Request changes opens a writer round.',
    ])
  })

  it('says when a word has no rule after it, and when it finishes the Run', () => {
    const none = stepDoor(card(7), run({}, [rule('ship', 'decide', 'verify', { every: ['approved'] })]))
    expect(none?.kind === 'answer' && none.answers.map((one) => one.effect)).toEqual([
      'Approved opens the verify check.', 'Request changes ends the Run without a next step.',
    ])
    // No rule starts from this role at all: it is the last step, and answering it settles the Run.
    const last = stepDoor(card(7), run({}, []))
    expect(last?.kind === 'answer' && last.answers.map((one) => one.effect)).toEqual([
      'Approved finishes the Run.', 'Request changes finishes the Run.',
    ])
  })

  it('says a rule that reads evidence may open its role', () => {
    const door = stepDoor(card(7), run({}, [rule('land', 'decide', 'fixer', { every: ['approved'], evidence: [{ ci: 'green' }] })]))
    expect(door?.kind === 'answer' && door.answers[0]?.effect).toBe('Approved may open a fixer round, depending on the Run\'s evidence.')
  })

  it('says an answer is only recorded while the Run is not running, which advances nothing', () => {
    const rules = [rule('ship', 'decide', 'verify', { every: ['approved'] })]
    const effects = (state: FlowExecution['state']) => {
      const door = stepDoor(card(7), run({ state }, rules))
      return door?.kind === 'answer' ? door.answers.map((one) => one.effect) : null
    }
    expect(effects('stalled')).toEqual([
      'Approved is recorded, and no rule follows while this Run is stalled.', 'Request changes is recorded, and no rule follows while this Run is stalled.',
    ])
    for (const state of ['stopped', 'settled'] as const) {
      expect(effects(state)).toEqual([`Approved is recorded, and no rule follows: this Run is ${state}.`, `Request changes is recorded, and no rule follows: this Run is ${state}.`])
    }
    const referee = run({ state: 'stopped', rounds: [{ n: 3, role: 'referee', cards: [7], seats: [], evidence: [], state: 'running', cause: 'seed' }] })
    const marked = stepDoor(card(7, { role: 'referee' }), referee)
    expect(marked?.kind === 'answer' && marked.answers[0]?.effect).toBe('Marking it done is recorded, and no rule follows: this Run is stopped.')
  })

  it('lets a role that declares no words be marked done, as the board does', () => {
    const referee = run({ rounds: [{ n: 3, role: 'referee', cards: [7], seats: [], evidence: [], state: 'running', cause: 'seed' }] }, [rule('after', 'referee', 'writer')])
    expect(stepDoor(card(7, { role: 'referee' }), referee)).toEqual({ kind: 'answer', card: 7, answers: [{ outcome: null, effect: 'Marking it done opens a writer round.' }] })
    const last = run({ rounds: [{ n: 3, role: 'referee', cards: [7], seats: [], evidence: [], state: 'running', cause: 'seed' }] })
    expect(stepDoor(card(7, { role: 'referee' }), last)).toEqual({ kind: 'answer', card: 7, answers: [{ outcome: null, effect: 'Marking it done ends the Run without a next step.' }] })
  })

  it('sends a review step to the board, where its attempt is chosen', () => {
    const review = run({}, [rule('land', 'decide', 'verify', { every: ['approved'], evidence: [{ review: 'approved' }] })])
    expect(stepDoor(card(7), review)).toEqual({ kind: 'review', card: 7 })
  })

  it('has no door for a card an agent or a check holds, one already answered, or one no Run opened', () => {
    const agents = run({ rounds: [{ n: 1, role: 'writer', cards: [7], seats: [], evidence: [], state: 'running', cause: 'seed' }] })
    expect(stepDoor(card(7, { role: 'writer' }), agents)).toBeNull()
    expect(stepDoor(card(7, { state: 'done', outcome: 'approved' }), run({}, decideRules))).toBeNull()
    expect(stepDoor(card(7, { state: 'abandoned' }), run({}, decideRules))).toBeNull()
    expect(stepDoor(card(8), run({}, decideRules))).toBeNull()
    expect(stepDoor(card(7), null)).toBeNull()
  })

  it('reads no effect from a Run on the old format, which keeps its original routing', () => {
    const legacy = { ...run({}, decideRules), document: { format: 'legacy' as const, flow: { name: 'Old' } as never } }
    expect(stepDoor(card(7), legacy)).toBeNull()
  })
})

describe('abandoning a card', () => {
  const writerRound = (cards: readonly number[], patch: Partial<FlowExecution['rounds'][number]> = {}) => ({ n: 2, role: 'writer', cards, seats: [], evidence: [], state: 'running' as const, cause: 'seed', ...patch })

  it('says first that the rule after its role still fires, and what it opens', () => {
    const execution = run({ rounds: [writerRound([4])] }, [rule('review', 'writer', 'reviewer')])
    expect(abandonEffect(execution, [card(4, { role: 'writer' })], card(4, { role: 'writer' })))
      .toBe('The rule that follows the writer role still fires, so abandoning this card opens a reviewer round.')
  })

  it('names a step for you and a check by what they are', () => {
    const toPerson = run({ rounds: [writerRound([4])] }, [rule('ask', 'writer', 'decide')])
    expect(abandonEffect(toPerson, [card(4, { role: 'writer' })], card(4, { role: 'writer' }))).toContain('opens a step for you.')
    const toCheck = run({ rounds: [writerRound([4])] }, [rule('check', 'writer', 'verify')])
    expect(abandonEffect(toCheck, [card(4, { role: 'writer' })], card(4, { role: 'writer' }))).toContain('opens the verify check.')
  })

  it('says it may open the role when the rule reads evidence', () => {
    const execution = run({ rounds: [writerRound([4])] }, [rule('land', 'writer', 'reviewer', { evidence: [{ ci: 'green' }] })])
    expect(abandonEffect(execution, [card(4, { role: 'writer' })], card(4, { role: 'writer' })))
      .toBe('The rule that follows the writer role still applies, so abandoning this card may open a reviewer round, depending on the Run\'s evidence.')
  })

  it('says the Run ends when every rule needs an answer the abandoned card does not have', () => {
    const execution = run({ rounds: [writerRound([4])] }, [rule('ship', 'writer', 'reviewer', { every: ['done'] })])
    expect(abandonEffect(execution, [card(4, { role: 'writer' })], card(4, { role: 'writer' })))
      .toBe('No rule that follows the writer role accepts a card with no answer, so abandoning this card ends the Run without a next step.')
  })

  it('says the Run ends at a role no rule starts from', () => {
    const execution = run({ rounds: [writerRound([4])] }, [])
    expect(abandonEffect(execution, [card(4, { role: 'writer' })], card(4, { role: 'writer' })))
      .toBe('Nothing follows the writer role, so abandoning this card ends the Run without a next step.')
  })

  it('reads what the round\'s other cards answered, as the engine does', () => {
    const rules = [rule('ship', 'writer', 'verify', { any: ['published'] }), rule('again', 'writer', 'reviewer')]
    const execution = run({ rounds: [writerRound([4, 5])] }, rules)
    const answered = card(5, { role: 'writer', state: 'done', outcome: 'published' })
    expect(abandonEffect(execution, [card(4, { role: 'writer' }), answered], card(4, { role: 'writer' }))).toContain('opens the verify check.')
    const silent = card(5, { role: 'writer', state: 'abandoned' })
    expect(abandonEffect(execution, [card(4, { role: 'writer' }), silent], card(4, { role: 'writer' }))).toContain('opens a reviewer round.')
  })

  it('reads the card as it is given, and an outcome it kept from an earlier answer still counts', () => {
    // A card put back in play keeps the outcome it once answered, and abandoning it leaves that in place.
    const rules = [rule('ship', 'writer', 'verify', { every: ['published'] }), rule('again', 'writer', 'reviewer')]
    const execution = run({ rounds: [writerRound([4])] }, rules)
    const reopened = card(4, { role: 'writer', outcome: 'published' })
    expect(abandonEffect(execution, [card(4, { role: 'writer' })], reopened)).toContain('opens the verify check.')
    expect(abandonEffect(execution, [reopened], card(4, { role: 'writer' }))).toContain('opens a reviewer round.')
  })

  it('waits for the round\'s other cards before any rule decides', () => {
    const execution = run({ rounds: [writerRound([4, 5, 6])] }, [rule('review', 'writer', 'reviewer')])
    const cards = [card(4, { role: 'writer' }), card(5, { role: 'writer', state: 'claimed' }), card(6, { role: 'writer', state: 'done', outcome: 'published' })]
    expect(abandonEffect(execution, cards, cards[0]!))
      .toBe('Round 2 stays open until its other card finishes (#5). Then the rule that follows the writer role decides, with this card counting as no answer.')
    const several = [card(4, { role: 'writer' }), card(5, { role: 'writer' }), card(6, { role: 'writer' })]
    expect(abandonEffect(execution, several, several[0]!)).toContain('its other cards finish (#5, #6)')
  })

  it('treats a card the board no longer holds as unfinished, as the engine does', () => {
    const execution = run({ rounds: [writerRound([4, 5])] }, [rule('review', 'writer', 'reviewer')])
    expect(abandonEffect(execution, [card(4, { role: 'writer' })], card(4, { role: 'writer' }))).toContain('stays open until its other card finishes (#5)')
  })

  it('says nothing follows when the Run is not running, or the card\'s round is over', () => {
    const rules = [rule('review', 'writer', 'reviewer')]
    for (const state of ['stopped', 'settled'] as const) {
      expect(abandonEffect(run({ state, rounds: [writerRound([4])] }, rules), [card(4, { role: 'writer' })], card(4, { role: 'writer' })))
        .toBe(`This Run is ${state}, so no rule follows: abandoning only sets the card aside.`)
    }
    // A stalled Run advances nothing now, and says no more than that.
    expect(abandonEffect(run({ state: 'stalled', rounds: [writerRound([4])] }, rules), [card(4, { role: 'writer' })], card(4, { role: 'writer' })))
      .toBe('This Run is stalled, so no rule follows now: abandoning only sets the card aside.')
    const later = run({ rounds: [writerRound([4], { state: 'closed' }), { n: 3, role: 'reviewer', cards: [5], seats: [], evidence: [], state: 'running', cause: 'review' }] }, rules)
    expect(abandonEffect(later, [card(4, { role: 'writer' })], card(4, { role: 'writer' })))
      .toBe('Its round has already ended, so no rule follows: abandoning only sets the card aside.')
  })

  it('claims nothing about a rule it cannot read', () => {
    const legacy = { ...run({ rounds: [writerRound([4])] }), document: { format: 'legacy' as const, flow: { name: 'Old' } as never } }
    expect(abandonEffect(legacy, [card(4, { role: 'writer' })], card(4, { role: 'writer' })))
      .toBe('Abandoning sets the card aside. If a rule follows its role, the next round opens as usual.')
    expect(abandonEffect(run({ rounds: [] }), [card(4)], card(4)))
      .toBe('Abandoning sets the card aside. If a rule follows its role, the next round opens as usual.')
  })

  it('offers abandoning a card that has not finished', () => {
    expect(['open', 'claimed', 'blocked'].map((state) => abandonable(card(1, { state: state as Intent['state'] })))).toEqual([true, true, true])
    expect(['done', 'abandoned'].map((state) => abandonable(card(1, { state: state as Intent['state'] })))).toEqual([false, false])
  })
})

describe('an approval, as a second door to the same answer', () => {
  const base = { id: approvalId('a1'), sessionId: sessionId('s1'), requestedAt: 10 }
  const options = [
    { id: 'always', label: 'Always allow', intent: 'approveAlways' as const },
    { id: 'no', label: 'Deny', intent: 'deny' as const },
    { id: 'yes', label: 'Allow once', intent: 'approve' as const },
  ]
  const choiceLabels = (door: ReturnType<typeof approvalDoor>) => door.choices.map((one) => one.label)

  it('draws the agent\'s own choices in the docked card\'s order, with only the plain yes filled', () => {
    const command: Approval = { ...base, type: 'command', command: 'pnpm verify', cwd: '/work', actions: [], options }
    const door = approvalDoor(command)
    expect(choiceLabels(door)).toEqual(['Deny', 'Always allow', 'Allow once'])
    expect(door.choices.map((one) => one.primary)).toEqual([false, false, true])
    expect(door.choices.map((one) => one.decision)).toEqual([
      { type: 'option', optionId: 'no' }, { type: 'option', optionId: 'always' }, { type: 'option', optionId: 'yes' },
    ])
    expect(door.detail).toEqual({ code: 'pnpm verify' })
    expect(door.elsewhere).toBe(false)
  })

  it('answers a cancel choice as the card does, with a cancel', () => {
    const command: Approval = { ...base, type: 'command', command: 'ls', cwd: '/work', actions: [], options: [{ id: 'stop', label: 'Cancel', intent: 'cancel' }, options[2]!] }
    expect(approvalDoor(command).choices[0]?.decision).toEqual({ type: 'cancel' })
  })

  it('shows the input a running command is asked to take, which is what is being approved', () => {
    const stdin: Approval = { ...base, type: 'command', kind: 'stdin', command: 'npm login', input: 'y\n', cwd: '/work', actions: [], options }
    expect(approvalDoor(stdin).detail).toEqual({ code: 'y\n', inputTo: { command: 'npm login', folder: '/work' } })
  })

  it('names the files a change would touch, and why it asks', () => {
    const change = (path: string) => ({ path, kind: { type: 'update' as const, movePath: null }, diff: '' })
    const files: Approval = { ...base, type: 'fileChange', changes: [change('src/a.ts'), change('src/b.ts')], reason: 'Retry the call', options }
    expect(approvalDoor(files).detail).toEqual({ reason: 'Retry the call', lists: [{ label: 'Files', items: ['src/a.ts', 'src/b.ts'] }] })
  })

  it('says what an access request would open, and why it asks, so a yes is not given blind', () => {
    const permission: Approval = { ...base, type: 'permission', summary: 'Edit outside the folder', reason: 'The file is outside the workspace.', filesystem: ['/etc'], network: ['example.com'], options }
    expect(approvalDoor(permission).detail).toEqual({
      reason: 'The file is outside the workspace.',
      lists: [{ label: 'Folders', items: ['/etc'] }, { label: 'Network', items: ['example.com'] }],
    })
    // A request that names nothing beyond its summary shows nothing beside it, and an empty list is not a line.
    expect(approvalDoor({ ...base, type: 'permission', summary: 'Use a tool', filesystem: [], options }).detail).toEqual({})
  })

  it('shows a command whole, with the reason the runtime gave', () => {
    const command: Approval = { ...base, type: 'command', command: 'pnpm verify && echo done', cwd: '/work', actions: [], reason: 'Run the checks', options }
    expect(approvalDoor(command).detail).toEqual({ code: 'pnpm verify && echo done', reason: 'Run the checks' })
  })

  it('words a board tool\'s grants as the card does, and fills only the plain yes', () => {
    const grants = [
      { id: 'no', label: 'Reject', intent: 'deny' as const },
      { id: 'session', label: 'Allow tool', intent: 'approveAlways' as const, grant: 'session-tool' as const },
      { id: 'once', label: 'Allow', intent: 'approve' as const },
    ]
    const tool: Approval = { ...base, type: 'permission', summary: 'claim_work (harnessdesk MCP Server)', options: grants }
    const door = approvalDoor(tool, { sessionOptionLabel: 'Allow for this session', onceOptionLabel: 'Allow once' })
    expect(choiceLabels(door)).toEqual(['Reject', 'Allow for this session', 'Allow once'])
    expect(door.choices.map((one) => one.primary)).toEqual([false, false, true])
    // Not a board tool, or a runtime that words none: the agent's own labels.
    expect(choiceLabels(approvalDoor(tool))).toEqual(['Reject', 'Allow tool', 'Allow'])
    const other: Approval = { ...tool, summary: 'read_file (other MCP Server)' }
    expect(choiceLabels(approvalDoor(other, { sessionOptionLabel: 'Allow for this session', onceOptionLabel: 'Allow once' }))).toEqual(['Reject', 'Allow tool', 'Allow'])
  })

  it('answers a question that has one single-choice question with the option picked', () => {
    const question: Approval = { ...base, type: 'userInput', tool: 'ask', questions: [{ id: 'target', question: 'Which target?', multiSelect: false, options: [
      { id: 'web', label: 'Web', description: 'The storefront' }, { id: 'api', label: 'API' },
    ] }] }
    const door = approvalDoor(question)
    expect(choiceLabels(door)).toEqual(['Web', 'API', 'Cancel'])
    expect(door.choices.map((one) => one.decision)).toEqual([
      { type: 'answers', answers: { target: ['web'] } }, { type: 'answers', answers: { target: ['api'] } }, { type: 'cancel' },
    ])
    expect(door.choices.some((one) => one.primary)).toBe(false)
    expect(door.choices[0]?.title).toBe('The storefront')
    expect(door.elsewhere).toBe(false)
  })

  it('leaves a question that needs a form to its conversation, and offers only to cancel it here', () => {
    const many: Approval = { ...base, type: 'userInput', tool: 'ask', questions: [
      { id: 'a', question: 'One?', multiSelect: false, options: [{ id: 'x', label: 'X' }] },
      { id: 'b', question: 'Two?', multiSelect: false, options: [{ id: 'y', label: 'Y' }] },
    ] }
    const multi: Approval = { ...base, type: 'userInput', tool: 'ask', questions: [{ id: 'a', question: 'Which?', multiSelect: true, options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }] }] }
    const free: Approval = { ...base, type: 'userInput', tool: 'ask', questions: [{ id: 'a', question: 'Why?', multiSelect: false, options: [] }] }
    for (const approval of [many, multi, free]) {
      const door = approvalDoor(approval)
      expect(choiceLabels(door)).toEqual(['Cancel'])
      expect(door.choices[0]?.decision).toEqual({ type: 'cancel' })
      expect(door.elsewhere).toBe(true)
    }
  })

  it('leaves an approval that offers no choice to its conversation, where its card does', () => {
    const none: Approval = { ...base, type: 'permission', summary: 'Use a tool', options: [] }
    const door = approvalDoor(none)
    expect(door.choices).toEqual([])
    expect(door.elsewhere).toBe(true)
  })

  it('leaves a tool\'s request for information to its conversation', () => {
    const elicitation: Approval = { ...base, type: 'elicitation', server: 'docs', message: 'Which space?', schema: { type: 'object' } }
    const door = approvalDoor(elicitation)
    expect(choiceLabels(door)).toEqual(['Cancel'])
    expect(door.elsewhere).toBe(true)
  })
})
