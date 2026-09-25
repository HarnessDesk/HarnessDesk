import type { CompiledFlow, FlowEntry, FlowExecution, FlowPreview, FlowPreviewSeat, FlowStartTarget, FlowUpdatePreview, SeatPlan } from '@harnessdesk/protocol'

import { PREVIEW_ROOT } from './sidebar-fixture'

/**
 * Every visible state of the project Flows section, the dry run and Update —
 * a project's own valid flow, an old one still on the legacy format, one
 * that ships and can only be customized, and one whose file will not parse —
 * so the preview harness draws all four without opening a real project.
 *
 * Seat candidates keep the anonymized display names the rest of this
 * directory's fixtures use (`Alpha`/`Beta`/`Gamma`), never a real runtime's
 * brand name: this data can end up in a public screenshot.
 */

const held: SeatPlan = {
  id: 'implementer',
  from: 'prefer',
  winner: 0,
  blocked: null,
  ceiling: { level: 'edit', hold: 'held' },
  candidates: [
    { seat: { runtime: 'alpha' }, label: 'Alpha', runtimeName: 'Alpha', state: 'taken', reason: null, fix: null },
  ],
}

const asked: SeatPlan = {
  id: 'reviewer',
  from: 'machine',
  winner: 2,
  blocked: null,
  ceiling: { level: 'read', hold: 'asked' },
  candidates: [
    { seat: { runtime: 'gamma' }, label: 'Gamma', runtimeName: 'Gamma', state: 'passed', reason: { kind: 'signedOut' }, fix: { kind: 'signIn', runtime: 'gamma' } },
    { seat: { runtime: 'delta' }, label: 'Delta', runtimeName: 'Delta', state: 'passed', reason: { kind: 'notInstalled', added: false }, fix: { kind: 'add', runtime: 'delta' } },
    { seat: { runtime: 'beta' }, label: 'Beta', runtimeName: 'Beta', state: 'taken', reason: null, fix: null },
  ],
}

export const FLOW_SEATS: readonly FlowPreviewSeat[] = [
  { role: 'fixer', index: 0, agent: 'implementer', isolate: true, plan: held },
  { role: 'reviewer', index: 0, agent: 'code-reviewer', isolate: false, plan: asked },
]

const FIX_SOURCE = [
  'version: 2',
  'name: "Fix and review"',
  'description: "One implementer fixes it in isolation, then a reviewer looks."',
  'inputs:',
  '  task:',
  '    label: "Task"',
  'roles:',
  '  fixer:',
  '    kind: agent',
  '    uses: [implementer]',
  '    isolate: true',
  '    grant: edit',
  '    independentOf: []',
  '  verify:',
  '    kind: check',
  '    run: "pnpm verify"',
  '    timeout: 1800',
  '  reviewer:',
  '    kind: agent',
  '    uses: [code-reviewer]',
  '    grant: read',
  '    independentOf: []',
  'seed: { role: fixer, title: "{{task}}" }',
  'rules:',
  '  - id: to-verify',
  '    on: fixer',
  '    then: { role: verify, title: "Check the fix" }',
  '  - id: to-reviewer',
  '    on: verify',
  '    when: { every: [pass] }',
  '    then: { role: reviewer, title: "Review the fix" }',
  'messaging: board-only',
  'wait: 240',
  'layout: {"race":"fixer"}',
  '',
].join('\n')

const FIX_DOCUMENT: CompiledFlow['document'] = {
  format: 'agents',
  flow: {
    version: 2,
    name: 'Fix and review',
    description: 'One implementer fixes it in isolation, then a reviewer looks.',
    inputs: [{ id: 'task', label: 'Task' }],
    roles: [
      { id: 'fixer', kind: 'agent', uses: ['implementer'], seats: [], isolate: true, grant: 'edit', independentOf: [] },
      { id: 'verify', kind: 'check', check: { run: 'pnpm verify', timeout: 1800, exits: { 0: 'pass' }, otherwise: 'fail' } },
      { id: 'reviewer', kind: 'agent', uses: ['code-reviewer'], seats: [], isolate: false, grant: 'read', independentOf: [] },
    ],
    rules: [
      { id: 'to-verify', on: 'fixer', then: { role: 'verify', title: 'Check the fix' } },
      { id: 'to-reviewer', on: 'verify', when: { every: ['pass'] }, then: { role: 'reviewer', title: 'Review the fix' } },
    ],
    seed: { role: 'fixer', title: '{{task}}' },
    messaging: 'board-only',
    wait: 240,
    layout: { race: 'fixer' },
  },
}

export const FIX_PREVIEW: FlowPreview = {
  token: 'preview-fix-token',
  compiled: { document: FIX_DOCUMENT, bindings: [], problems: [] },
  seats: FLOW_SEATS,
  commands: [{ role: 'verify', run: 'pnpm verify', cwd: PREVIEW_ROOT, timeout: 1800 }],
  guards: [
    { rule: 'to-verify', unevidenced: true, requires: [] },
    { rule: 'to-reviewer', unevidenced: false, requires: [{ check: 'verify' }] },
  ],
  messaging: 'board-only',
  problems: [],
}

const LEGACY_SOURCE = [
  '---',
  'name: Old fix',
  'permission: read',
  '---',
  '',
  'Fix the reported issue and open a pull request.',
  '',
].join('\n')

export const PREVIEW_FLOWS: readonly FlowEntry[] = [
  { id: 'fix', origin: 'project', path: '.harnessdesk/flows/fix.yml', name: 'Fix and review', description: FIX_DOCUMENT.flow.description ?? null, format: 'agents', problem: null, shadows: [] },
  { id: 'old-fix', origin: 'project', path: '.harnessdesk/flows/old-fix.yml', name: 'Old fix', description: null, format: 'legacy', problem: null, shadows: [] },
  { id: 'comparison', origin: 'builtin', path: 'comparison.yml', name: 'Comparison', description: 'One task, two isolated agents, a check on each, then a person picks.', format: 'agents', problem: null, shadows: [] },
  { id: 'broken', origin: 'project', path: '.harnessdesk/flows/broken.yml', name: 'Broken flow', description: null, format: null, problem: 'roles.fixer.uses: there is no usable Agent called "ghost"', shadows: [{ origin: 'user', path: 'broken.yml' }] },
]

export const PREVIEW_FLOW_SOURCE: Readonly<Record<string, string>> = {
  fix: FIX_SOURCE,
  'old-fix': LEGACY_SOURCE,
  comparison: FIX_SOURCE,
}

/** The one live preview this fixture answers with — every catalogue id previews as the same worked example. */
export const previewFlowPreviewFor = (source: string): FlowPreview =>
  source === LEGACY_SOURCE
    ? { token: null, compiled: { document: { format: 'legacy', flow: { name: 'Old fix', inputs: [], roles: [], rules: [], seed: { role: 'fixer', title: 'Fix' }, wait: 240 } }, bindings: [], problems: [] }, seats: [], commands: [], guards: [], messaging: 'board-only', problems: [{ level: 'warning', at: 'format', text: 'This flow uses the old format' }] }
    : FIX_PREVIEW

export const PREVIEW_FLOW_UPDATE: FlowUpdatePreview = {
  token: 'update-token',
  resuming: false,
  edits: [
    { path: '.harnessdesk/agents/old-fix-fixer/AGENT.md', before: null, after: '---\nname: "Old fix — fixer"\nceiling: edit\nanswers: []\n---\n\nFix the reported issue and open a pull request.\n' },
    { path: '.harnessdesk/flows/old-fix.yml', before: LEGACY_SOURCE, after: FIX_SOURCE },
  ],
  problems: [],
}

/** Customize copies one file verbatim — no Agent conversion, unlike Update above. */
export const PREVIEW_FLOW_CUSTOMIZE: FlowUpdatePreview = {
  token: 'customize-token',
  resuming: false,
  edits: [
    { path: '.harnessdesk/flows/comparison.yml', before: null, after: FIX_SOURCE },
  ],
  problems: [],
}

/**
 * A front-door start's own resolved target, three ways: a branch's head (a
 * pinned revision, shown as "at a1b2c3d on branch feature"), a diff's own
 * range (no head repeated — its label already carries both ends), and a
 * working tree's bounded snapshot (`head: null`, `dirty: true` — never a
 * committed head to pin).
 */
const FLOW_TARGETS: Readonly<Record<'branch' | 'diff' | 'working-diff', FlowStartTarget>> = {
  branch: { kind: 'branch', label: 'branch feature', base: 'main', head: 'a1b2c3d4e5f678901234567890abcdef12345678', pr: null, dirty: false },
  diff: { kind: 'diff', label: 'changes from abc123 to def456', base: 'abc1234567890123456789012345678901234567', head: 'def4567890123456789012345678901234567890', pr: null, dirty: false },
  'working-diff': { kind: 'working-diff', label: 'the working tree', base: null, head: null, pr: null, dirty: true },
}

const FLOW_EXECUTION = (over: Partial<FlowExecution> = {}): FlowExecution => ({
  version: 2,
  id: 'preview-flow-run',
  goal: 'goal-flow',
  document: FIX_DOCUMENT,
  state: 'running',
  rounds: [{ n: 1, role: 'fixer', cards: [1], seats: [], evidence: [], state: 'running', cause: 'seed' }],
  operations: [],
  legacyRun: null,
  reason: null,
  ...over,
})

export const FLOW_EXECUTION_SCENES = ['pinned', 'stopped', 'diff', 'working-diff'] as const
export type FlowExecutionScene = (typeof FLOW_EXECUTION_SCENES)[number]

/** What the "flow scene" Dial in the preview harness stages for `goal-flow`'s own reserved run. */
export const sceneFlowExecution = (scene: FlowExecutionScene): FlowExecution => {
  if (scene === 'pinned') return FLOW_EXECUTION({ target: FLOW_TARGETS.branch })
  if (scene === 'diff') return FLOW_EXECUTION({ target: FLOW_TARGETS.diff })
  if (scene === 'working-diff') return FLOW_EXECUTION({ target: FLOW_TARGETS['working-diff'] })
  // A person's own stop, never a service's: the host's exact default
  // sentence (`packages/server/src/flow-execution.ts`), read lowercase and
  // shown by `TeamRoomPane`'s own `sentence()` as "The person stopped this flow."
  return FLOW_EXECUTION({ target: FLOW_TARGETS.branch, state: 'stopped', reason: 'the person stopped this flow' })
}
