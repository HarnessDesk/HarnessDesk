import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { CodexProtocol } from '@harnessdesk/codex'

import {
  noteUnservedModel,
  overlayDraftValues,
  runtimeOptions,
  sessionOptions,
  stateFromConfig,
  settingsUpdateFor,
  splitStartOptions,
  stateFromStartResponse,
  stateFromThreadSettings,
  type Catalog,
  type ThreadState,
} from '../src/mapping/options.js'

/**
 * The translation between Codex's settings and the capability surface, as
 * pure functions. The invariants that matter: a select always offers its
 * current value, the built-in profiles stand in for the legacy sandbox, and a
 * mode change carries the effort Codex would apply.
 */

const model = (overrides: Partial<CodexProtocol.v2.Model> = {}): CodexProtocol.v2.Model => ({
  id: 'gpt-5.5',
  model: 'gpt-5.5',
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  displayName: 'GPT-5.5',
  description: 'Frontier',
  modelSpecialty: null,
  hidden: false,
  supportedReasoningEfforts: [
    { reasoningEffort: 'low', description: 'fast' },
    { reasoningEffort: 'high', description: 'deep' },
  ],
  defaultReasoningEffort: 'medium',
  inputModalities: ['text'],
  supportsPersonality: true,
  multiAgentVersion: null,
  additionalSpeedTiers: [],
  serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x' }],
  defaultServiceTier: null,
  isDefault: true,
  ...overrides,
})

const catalog: Catalog = {
  models: [model(), model({ id: 'secret', model: 'secret', displayName: 'Secret', hidden: true })],
  modes: [
    { name: 'Plan', mode: 'plan', model: null, reasoning_effort: 'medium' },
    { name: 'Default', mode: 'default', model: null, reasoning_effort: null },
  ],
  profiles: [
    { id: ':read-only', description: null, allowed: true },
    { id: ':workspace', description: null, allowed: true },
    { id: ':danger-full-access', description: null, allowed: true },
    { id: 'ci', description: 'From the project', allowed: true },
  ],
}

const state: ThreadState = {
  cwd: '/w',
  workspaceRoots: ['/w'],
  model: 'gpt-5.5',
  modelProvider: 'openai',
  effort: null,
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user',
  permissions: ':workspace',
  serviceTier: null,
  mode: 'default',
}

const byId = (options: ReturnType<typeof sessionOptions>, id: string) => {
  const found = options.find((option) => option.id === id)
  assert.ok(found, `no option ${id}`)
  return found
}

test('a thread started with a sandbox still reports a profile, from the built-in mapping', () => {
  const fromSandbox = stateFromStartResponse({
    cwd: '/w',
    runtimeWorkspaceRoots: ['/w'],
    model: 'gpt-5.5',
    modelProvider: 'openai',
    serviceTier: null,
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: { type: 'readOnly', networkAccess: false },
    activePermissionProfile: null,
    reasoningEffort: null,
  })
  assert.equal(fromSandbox.permissions, ':read-only')
  assert.equal(fromSandbox.mode, 'default', 'thread/start does not report a mode; default until told')
})

test('every select offers its current value, even one set outside the interface', () => {
  const options = sessionOptions({ ...state, model: 'gpt-99', permissions: 'from-toml' }, catalog)
  const modelOption = byId(options, 'model')
  assert.ok(modelOption.type === 'select' && modelOption.choices.some((c) => c.value === 'gpt-99'))
  assert.ok(!(modelOption.type === 'select' && modelOption.choices.some((c) => c.value === 'secret')), 'hidden models are not offered')
  const permissions = byId(options, 'permissions')
  assert.ok(permissions.type === 'select' && permissions.choices.some((c) => c.value === 'from-toml'))
})

test('effort, speed and the mode switch appear only when the catalogue supports them', () => {
  const options = sessionOptions(state, catalog)
  assert.deepEqual(
    options.map((option) => [option.id, option.category]),
    [
      ['model', 'model'],
      ['effort', 'thought_level'],
      ['mode', 'mode'],
      ['permissions', '_permissions'],
      ['approvals', '_permissions'],
      ['approvalsReviewer', '_permissions'],
      ['serviceTier', 'other'],
    ],
  )
  const effort = byId(options, 'effort')
  assert.equal(effort.currentValue, 'medium', 'a null effort shows the model default')

  const bare = sessionOptions(
    { ...state, model: 'unknown-model' },
    { ...catalog, modes: [] },
  )
  assert.deepEqual(
    bare.map((option) => option.id),
    ['model', 'permissions', 'approvals', 'approvalsReviewer'],
    'no known model means no effort or tier; no modes means no mode switch',
  )
})

test('a managed configuration disables the choices it forbids, keeping them visible', () => {
  const managed: Catalog = {
    ...catalog,
    // 0.149.0 moved the permission restriction onto the profile itself; the
    // rest of a managed policy still arrives on the requirements.
    profiles: catalog.profiles.map((profile) => ({
      ...profile,
      allowed: profile.id !== ':danger-full-access' && profile.id !== 'ci',
    })),
    requirements: {
      allowedApprovalPolicies: ['on-request', 'untrusted'],
      allowedApprovalsReviewers: ['user'],
      allowedSandboxModes: null,
      allowedWebSearchModes: null,
      allowManagedHooksOnly: null,
      allowAppshots: null,
      computerUse: null,
      featureRequirements: null,
      hooks: null,
      enforceResidency: null,
      network: null,
    } as never,
  }
  const options = sessionOptions(state, managed)
  const permissions = byId(options, 'permissions')
  const full = permissions.type === 'select' && permissions.choices.find((c) => c.value === ':danger-full-access')
  assert.ok(full && full.disabled, 'a forbidden permission profile is disabled, not removed')
  const workspace = permissions.type === 'select' && permissions.choices.find((c) => c.value === ':workspace')
  assert.ok(workspace && !workspace.disabled, 'an allowed one is not')
  const approvals = byId(options, 'approvals')
  assert.ok(approvals.type === 'select' && approvals.choices.find((c) => c.value === 'never')?.disabled)
  const reviewer = byId(options, 'approvalsReviewer')
  assert.ok(reviewer.type === 'select' && reviewer.choices.find((c) => c.value === 'guardian_subagent')?.disabled)
})

test('full access and unattended approvals are marked as risks', () => {
  const options = sessionOptions(state, catalog)
  const permissions = byId(options, 'permissions')
  assert.equal(
    permissions.type === 'select' && permissions.choices.find((c) => c.value === ':danger-full-access')?.risk,
    'high',
  )
  const approvals = byId(options, 'approvals')
  assert.equal(approvals.type === 'select' && approvals.choices.find((c) => c.value === 'never')?.risk, 'high')
  const custom = permissions.type === 'select' && permissions.choices.find((c) => c.value === 'ci')
  assert.equal(custom && custom.description, 'From the project')
})

test('a granular approval policy is shown as a custom choice rather than misreported', () => {
  const granular: ThreadState = {
    ...state,
    approvalPolicy: {
      granular: { sandbox_approval: true, rules: true, skill_approval: false, request_permissions: true, mcp_elicitations: true },
    },
  }
  const approvals = byId(sessionOptions(granular, catalog), 'approvals')
  assert.equal(approvals.currentValue, 'granular')
})

test('setting a mode sends the preset effort, and the standard tier clears the field', () => {
  const mode = settingsUpdateFor('mode', 'plan', state, catalog)
  assert.deepEqual(mode.collaborationMode, {
    mode: 'plan',
    settings: { model: 'gpt-5.5', reasoning_effort: 'medium', developer_instructions: null },
  })
  assert.deepEqual(settingsUpdateFor('serviceTier', 'standard', state, catalog), { serviceTier: null })
  assert.deepEqual(settingsUpdateFor('serviceTier', 'priority', state, catalog), { serviceTier: 'priority' })
  assert.deepEqual(settingsUpdateFor('permissions', ':read-only', state, catalog), { permissions: ':read-only' })
  assert.throws(() => settingsUpdateFor('nope', 'x', state, catalog), /no session option/)
  assert.throws(() => settingsUpdateFor('model', true, state, catalog), /named value/)
})

test('initial options split into what thread/start takes and what must follow', () => {
  const { start, after } = splitStartOptions({
    model: 'gpt-5.5',
    permissions: ':read-only',
    approvals: 'never',
    effort: 'high',
    mode: 'plan',
    serviceTier: 'standard',
  })
  assert.deepEqual(start, {
    model: 'gpt-5.5',
    permissions: ':read-only',
    approvalPolicy: 'never',
    serviceTier: null,
  })
  assert.deepEqual(after, [
    ['effort', 'high'],
    ['mode', 'plan'],
  ])
  assert.throws(() => splitStartOptions({ nope: 'x' }), /no session option/)
})

test('a settings notification replaces the state wholesale, keeping only the roots', () => {
  const next = stateFromThreadSettings(
    {
      cwd: '/elsewhere',
      approvalPolicy: 'never',
      approvalsReviewer: 'guardian_subagent',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      activePermissionProfile: { id: ':read-only', extends: null },
      model: 'gpt-5.4',
      modelProvider: 'openai',
      serviceTier: 'priority',
      effort: 'high',
      summary: null,
      collaborationMode: {
        mode: 'plan',
        settings: { model: 'gpt-5.4', reasoning_effort: 'high', developer_instructions: null },
      },
      multiAgentMode: 'explicitRequestOnly',
      personality: 'pragmatic',
    },
    state,
  )
  assert.deepEqual(next, {
    cwd: '/elsewhere',
    workspaceRoots: ['/w'],
    model: 'gpt-5.4',
    modelProvider: 'openai',
    effort: 'high',
    approvalPolicy: 'never',
    approvalsReviewer: 'guardian_subagent',
    permissions: ':read-only',
    serviceTier: 'priority',
    mode: 'plan',
  })
})

test('only beta features become toggles; the rest are internal flags', () => {
  const options = runtimeOptions([
    { name: 'memories', stage: 'beta', displayName: 'Memories', description: 'Keep memories.', announcement: '', enabled: true, defaultEnabled: false },
    { name: 'x', stage: 'underDevelopment', displayName: null, description: null, announcement: null, enabled: true, defaultEnabled: true },
    { name: 'y', stage: 'removed', displayName: null, description: null, announcement: null, enabled: false, defaultEnabled: false },
  ])
  assert.deepEqual(options, [
    {
      type: 'boolean',
      id: 'feature.memories',
      category: 'other',
      label: 'Memories',
      description: 'Keep memories.',
      currentValue: true,
    },
  ])
})

// ------------------------------------------------- pre-session draft options

/** A second selectable model whose effort levels differ from the default's. */
const codexModel = model({
  id: 'gpt-5.3-codex',
  model: 'gpt-5.3-codex',
  displayName: 'Codex',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'steady' }],
  defaultReasoningEffort: 'medium',
  isDefault: false,
})

const draftCatalog: Catalog = { ...catalog, models: [model(), codexModel] }

const config = (fields: Record<string, unknown> = {}): CodexProtocol.v2.Config =>
  fields as unknown as CodexProtocol.v2.Config

const emptyConfig = config()

test('an empty config drafts the catalogue default model at its own effort', () => {
  const state = stateFromConfig(emptyConfig, draftCatalog, '/repo')
  assert.equal(state.model, 'gpt-5.5')
  assert.equal(state.effort, 'medium')
  assert.equal(state.permissions, ':workspace')
  assert.equal(state.approvalPolicy, 'on-request')
  // The declared options include the model select with the default current.
  const options = sessionOptions(state, draftCatalog)
  const modelOption = options.find((option) => option.id === 'model')
  assert.equal(modelOption?.currentValue, 'gpt-5.5')
})

test('a config naming a model this Codex does not serve falls back to the default, and says so', () => {
  // The user's real config names a model for a newer CLI; offering it would
  // start a thread the backend then refuses. The substitution is announced on
  // the model option rather than made silently.
  const configured = config({ model: 'gpt-9-sol' })
  const state = stateFromConfig(configured, draftCatalog, '/repo')
  assert.equal(state.model, 'gpt-5.5')
  const noted = noteUnservedModel(sessionOptions(state, draftCatalog), configured.model, draftCatalog)
  const modelOption = noted.find((option) => option.id === 'model')
  assert.match(modelOption?.description ?? '', /gpt-9-sol/)
  assert.match(modelOption?.description ?? '', /does not offer/)
  // Nothing else is touched, and a served model draws no note.
  assert.equal(noted.find((option) => option.id === 'permissions')?.description, 'What the agent may touch without asking.')
  const served = noteUnservedModel(sessionOptions(state, draftCatalog), 'gpt-5.5', draftCatalog)
  assert.equal(served.find((option) => option.id === 'model')?.description, undefined)
})

test('reasoning levels the table has not met are shown by id, and xhigh is not called Max', () => {
  // GPT-5.6 added `max` and `ultra` above `xhigh`; a label must never collide
  // with an id the vendor may add, and an unknown id must never be dropped.
  const wide = model({
    supportedReasoningEfforts: [
      { reasoningEffort: 'xhigh', description: 'extra' },
      { reasoningEffort: 'max' as CodexProtocol.ReasoningEffort, description: 'most' },
      { reasoningEffort: 'ultra' as CodexProtocol.ReasoningEffort, description: 'delegating' },
      { reasoningEffort: 'hyper' as CodexProtocol.ReasoningEffort, description: 'new' },
    ],
  })
  const options = sessionOptions({ ...state, effort: 'xhigh' }, { ...catalog, models: [wide] })
  const effort = options.find((option) => option.id === 'effort')
  assert.equal(effort?.type, 'select')
  const labels = Object.fromEntries(
    (effort?.type === 'select' ? effort.choices : []).map((choice) => [choice.value, choice.label]),
  )
  assert.deepEqual(labels, { xhigh: 'Extra high', max: 'Max', ultra: 'Ultra', hyper: 'hyper' })
})

test('config sandbox and effort carry into the draft', () => {
  const state = stateFromConfig(
    config({ sandbox_mode: 'danger-full-access', model_reasoning_effort: 'high' }),
    draftCatalog,
    '/repo',
  )
  assert.equal(state.permissions, ':danger-full-access')
  assert.equal(state.effort, 'high')
})

test('overlaying a model keeps a supported effort and drops an unsupported one', () => {
  const base = stateFromConfig(config({ model_reasoning_effort: 'high' }), draftCatalog, '/repo')
  assert.equal(base.effort, 'high')
  // gpt-5.3-codex only offers medium: high must not survive the switch.
  const next = overlayDraftValues(base, { model: 'gpt-5.3-codex' }, draftCatalog)
  assert.equal(next.model, 'gpt-5.3-codex')
  assert.equal(next.effort, null)
  const options = sessionOptions(next, draftCatalog)
  const effort = options.find((option) => option.id === 'effort')
  assert.equal(effort?.currentValue, 'medium')
})

test('overlay refuses values a live session would refuse', () => {
  const base = stateFromConfig(emptyConfig, draftCatalog, '/repo')
  assert.throws(() => overlayDraftValues(base, { model: 'not-a-model' }, draftCatalog), /not one of the values/)
  assert.throws(() => overlayDraftValues(base, { nonsense: 'x' }, draftCatalog), /no session option named/)
})
