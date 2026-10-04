import type { CeilingLevel, Flow, FlowAgentRole, FlowDocument, FlowPolicy, FlowPolicyRole, FlowPolicyRule, SeatCeiling } from '@harnessdesk/protocol'

import { flowModel, type DrawnFlow, type FlowModel } from '../lib/flow-model'

/**
 * Flows to draw, for the catalogue board, the preview frames, the browser
 * spec and the component tests: every one a real document in the shape the
 * host reads, so the drawing under test is the one a Run would show.
 *
 * Names are the common ones of the product's own examples and nobody's own.
 */
export const FLOW_GRAPH_SCENES = ['blueprint', 'straight', 'loop', 'fan-out', 'person', 'positions', 'long', 'legacy', 'empty'] as const
export type FlowGraphScene = (typeof FLOW_GRAPH_SCENES)[number]

const agent = (id: string, grant: CeilingLevel, over: Partial<FlowAgentRole> = {}): FlowAgentRole => ({
  id, kind: 'agent', uses: [`${id}-agent`], seats: [], isolate: false, grant, independentOf: [], ...over,
})
const check = (id: string, run: string): FlowPolicyRole => ({
  id, kind: 'check', check: { run, timeout: 600, exits: { 0: 'pass' }, otherwise: 'fail' },
})
const person = (id: string, outcomes: readonly string[]): FlowPolicyRole => ({ id, kind: 'person', outcomes })
const rule = (id: string, on: string, to: string, when?: FlowPolicyRule['when']): FlowPolicyRule => ({
  id, on, ...(when ? { when } : {}), then: { role: to, title: `Open ${to}` },
})
const policy = (name: string, roles: readonly FlowPolicyRole[], rules: readonly FlowPolicyRule[], over: Partial<FlowPolicy> = {}): FlowPolicy => ({
  version: 2, name, inputs: [], roles, rules, seed: { role: roles[0]!.id, title: 'Start' }, messaging: 'board-only', wait: 240, ...over,
})

/** Write, check, two reviewers, land, and a person at the gate: the whole product in one picture. */
const BLUEPRINT_ROLES: readonly FlowPolicyRole[] = [
  agent('write', 'edit'),
  check('check', 'pnpm verify'),
  agent('review', 'read', { count: 2, isolate: true }),
  agent('fix', 'edit'),
  check('land', 'pnpm land'),
  person('you', ['merged', 'dropped']),
]
const BLUEPRINT_RULES: readonly FlowPolicyRule[] = [
  rule('written', 'write', 'check'),
  rule('checked', 'check', 'review', { every: ['passes'] }),
  rule('approved', 'review', 'land', { every: ['approve'] }),
  rule('changes', 'review', 'fix', { any: ['request-changes'] }),
  rule('fixed', 'fix', 'check'),
  rule('landed', 'land', 'you', { every: ['landed'] }),
]

const LEGACY: Flow = {
  name: 'Fix and review',
  inputs: [],
  roles: [
    { id: 'fixer', kind: 'agent', count: 1, permission: 'read', seats: [{ runtime: 'alpha' }], outcomes: ['published'] },
    { id: 'reviewer', kind: 'agent', count: 2, permission: 'publish', seats: [{ runtime: 'beta' }], outcomes: ['approve', 'request-changes'] },
    { id: 'referee', kind: 'person', count: 1, permission: 'read', seats: [], outcomes: ['merged', 'dropped'] },
  ],
  rules: [
    { id: 'published', on: 'fixer', when: { every: ['published'] }, then: { role: 'reviewer', title: 'Review the change' } },
    { id: 'approved', on: 'reviewer', when: { every: ['approve'] }, then: { role: 'referee', title: 'Merge it?' } },
    { id: 'changes', on: 'reviewer', when: { any: ['request-changes'] }, then: { role: 'fixer', title: 'Address the review' } },
  ],
  seed: { role: 'fixer', title: 'Fix the reported issue' },
  wait: 240,
}

const long = (): FlowPolicy => policy('Plan, build and ship', [
  agent('plan', 'read'),
  agent('write', 'edit'),
  check('check', 'pnpm verify'),
  agent('review', 'read', { count: 3, isolate: true }),
  agent('fix', 'edit'),
  check('test', 'pnpm test'),
  agent('docs', 'edit'),
  check('land', 'pnpm land'),
  person('you', ['merged', 'dropped']),
], [
  rule('planned', 'plan', 'write'),
  rule('written', 'write', 'check'),
  rule('checked', 'check', 'review', { every: ['passes'] }),
  rule('changes', 'review', 'fix', { any: ['request-changes'] }),
  rule('fixed', 'fix', 'check'),
  rule('approved', 'review', 'test', { every: ['approve'] }),
  rule('tested', 'test', 'docs', { every: ['passes'] }),
  rule('documented', 'docs', 'land'),
  rule('landed', 'land', 'you', { every: ['landed'] }),
])

/** The same Flow laid out by hand: a Flow's own `layout.positions` win over the drawing's. */
const positioned = (): FlowPolicy => policy('Write, review, land', [
  agent('write', 'edit'),
  check('check', 'pnpm verify'),
  agent('review', 'read'),
  person('you', ['merged', 'dropped']),
], [
  rule('written', 'write', 'check'),
  rule('checked', 'check', 'review', { every: ['passes'] }),
  rule('approved', 'review', 'you', { every: ['approve'] }),
  rule('changes', 'review', 'write', { any: ['request-changes'] }),
], {
  layout: { positions: { write: { x: 0, y: 0 }, check: { x: 260, y: 90 }, review: { x: 520, y: 0 }, you: { x: 780, y: 90 } } },
})

export const flowGraphFlow = (scene: FlowGraphScene): DrawnFlow => {
  switch (scene) {
    case 'blueprint': return policy('Write, review, land', BLUEPRINT_ROLES, BLUEPRINT_RULES)
    case 'straight': return policy('Write and check', [agent('write', 'edit'), check('check', 'pnpm verify'), check('land', 'pnpm land')], [
      rule('written', 'write', 'check'),
      rule('checked', 'check', 'land', { every: ['passes'] }),
    ])
    case 'loop': return policy('Write until it passes review', [agent('write', 'edit'), check('check', 'pnpm verify'), agent('review', 'read')], [
      rule('written', 'write', 'check'),
      rule('checked', 'check', 'review', { every: ['passes'] }),
      rule('changes', 'review', 'write', { any: ['request-changes'] }),
    ])
    case 'fan-out': return policy('Three reviewers', [agent('write', 'edit'), agent('review', 'read', { count: 3, isolate: true }), check('land', 'pnpm land')], [
      rule('written', 'write', 'review'),
      rule('approved', 'review', 'land', { every: ['approve'] }),
    ])
    case 'person': return policy('Check, then ask', [agent('write', 'edit'), check('check', 'pnpm verify'), person('you', ['ship it', 'rework'])], [
      rule('written', 'write', 'check'),
      rule('checked', 'check', 'you', { every: ['passes'] }),
    ])
    case 'positions': return positioned()
    case 'long': return long()
    case 'legacy': return LEGACY
    case 'empty': return { version: 2, name: 'Nothing yet', inputs: [], roles: [], rules: [], seed: { role: 'start', title: 'Start' }, messaging: 'board-only', wait: 240 }
  }
}

/** A Run's frozen copy of the Flow, as the host stores it. */
export const flowGraphDocument = (scene: FlowGraphScene): FlowDocument => {
  const flow = flowGraphFlow(scene)
  return 'version' in flow ? { format: 'agents', flow } : { format: 'legacy', flow }
}

const ran = (level: CeilingLevel, hold: SeatCeiling['hold']): SeatCeiling => ({ level, hold })

/**
 * What the seats a Run opened ran under, for the scenes drawn as that Run
 * would: the blueprint's writers and reviewers were only asked to keep to their
 * ceiling, as the spec's frame reads, and the loop's were held to it, so both
 * words are drawn. The rest are drawn as written, with no Run behind them.
 */
const SEATED: Partial<Record<FlowGraphScene, ReadonlyMap<string, SeatCeiling>>> = {
  blueprint: new Map([['write', ran('edit', 'asked')], ['review', ran('read', 'asked')], ['fix', ran('edit', 'asked')]]),
  loop: new Map([['write', ran('edit', 'held')], ['review', ran('read', 'held')]]),
}

/** A Flow drawn as the Run that holds it would: with what its seats ran under where a scene has been seated. */
export const flowGraphModel = (scene: FlowGraphScene, ceilings: ReadonlyMap<string, SeatCeiling> | undefined = SEATED[scene]): FlowModel =>
  flowModel(flowGraphFlow(scene), ceilings ? { ceilings } : {})
