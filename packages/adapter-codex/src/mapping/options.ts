import type { CodexProtocol } from '@harnessdesk/codex'
import {
  findOption,
  refuseOptionValue,
  type ConfigOption,
  type OptionChoice,
  type OptionValue,
  type SessionSettings,
} from '@harnessdesk/protocol'

/**
 * Codex's controls ↔ the capability surface.
 *
 * Pure functions over two inputs: the thread's current settings, as Codex
 * reports them, and the catalogue of what Codex offers — models, collaboration
 * modes, permission profiles. Everything the renderer shows for a Codex
 * session is computed here, and nothing outside this file knows that a
 * profile is spelled `:workspace`.
 *
 * The option ids are stable and documented because presets and commands key
 * on them: `model`, `effort`, `mode`, `permissions`, `approvals`,
 * `approvalsReviewer`, `serviceTier`. Runtime-wide feature flags are
 * `feature.<name>`.
 */

type Model = CodexProtocol.v2.Model
type ModeMask = CodexProtocol.v2.CollaborationModeMask
type Profile = CodexProtocol.v2.PermissionProfileSummary
type AskForApproval = CodexProtocol.v2.AskForApproval
type ApprovalsReviewer = CodexProtocol.v2.ApprovalsReviewer
type ReasoningEffort = CodexProtocol.ReasoningEffort
type ThreadSettings = CodexProtocol.v2.ThreadSettings

/** What Codex offers, fetched once and refreshed when the account changes. */
export interface Catalog {
  readonly models: readonly Model[]
  readonly modes: readonly ModeMask[]
  readonly profiles: readonly Profile[]
  /**
   * A managed configuration's limits on what a user may choose, or null when
   * nothing is managed. When present, a choice outside the allowed set is
   * shown disabled with a reason rather than removed — an enterprise policy is
   * information the user should see, not a silent gap.
   */
  readonly requirements?: CodexProtocol.v2.ConfigRequirements | null
  /**
   * Why Codex could not read its vendor's catalogue, when it could not — in
   * which case `models` is the fallback compiled into this build, and the
   * model option says so. See `catalogWarningIn`.
   */
  readonly warning?: string | null
}

/**
 * The thread's settings as Codex reports them, kept in Codex's own vocabulary
 * so a `thread/settings/updated` notification can replace it wholesale.
 */
export interface ThreadState {
  readonly cwd: string
  readonly workspaceRoots: readonly string[]
  readonly model: string
  readonly modelProvider: string
  readonly effort: ReasoningEffort | null
  readonly approvalPolicy: AskForApproval
  readonly approvalsReviewer: ApprovalsReviewer
  /** The active profile id, derived from the legacy sandbox field when Codex reports none. */
  readonly permissions: string
  readonly serviceTier: string | null
  readonly mode: CodexProtocol.ModeKind
}

type StartLike = Pick<
  CodexProtocol.v2.ThreadStartResponse,
  | 'cwd'
  | 'runtimeWorkspaceRoots'
  | 'model'
  | 'modelProvider'
  | 'serviceTier'
  | 'approvalPolicy'
  | 'approvalsReviewer'
  | 'sandbox'
  | 'activePermissionProfile'
  | 'reasoningEffort'
>

/**
 * `thread/start` does not report the collaboration mode, and a fresh thread is
 * in Codex's default mode until told otherwise; `thread/settings/updated`
 * corrects this the first time anything changes.
 */
export const stateFromStartResponse = (response: StartLike): ThreadState => ({
  cwd: response.cwd,
  workspaceRoots: [...response.runtimeWorkspaceRoots],
  model: response.model,
  modelProvider: response.modelProvider,
  effort: response.reasoningEffort,
  approvalPolicy: response.approvalPolicy,
  approvalsReviewer: response.approvalsReviewer,
  permissions: response.activePermissionProfile?.id ?? profileForSandbox(response.sandbox),
  serviceTier: response.serviceTier,
  mode: 'default',
})

export const stateFromThreadSettings = (
  settings: ThreadSettings,
  previous: ThreadState,
): ThreadState => ({
  cwd: settings.cwd,
  workspaceRoots: previous.workspaceRoots,
  model: settings.model,
  modelProvider: settings.modelProvider,
  effort: settings.effort,
  approvalPolicy: settings.approvalPolicy,
  approvalsReviewer: settings.approvalsReviewer,
  permissions: settings.activePermissionProfile?.id ?? profileForSandbox(settings.sandboxPolicy),
  serviceTier: settings.serviceTier,
  mode: settings.collaborationMode.mode,
})

/**
 * The state a *new* thread would start in, from the effective configuration —
 * used to declare options before any session exists, so the composer can show
 * the model picker for the next conversation.
 *
 * The config's model can name something the installed Codex does not serve
 * (a config written for a newer CLI); the catalogue's default is used then,
 * because offering a model the backend would refuse is a trap, not a choice.
 */
export const stateFromConfig = (
  config: CodexProtocol.v2.Config,
  catalog: Catalog,
  cwd: string,
): ThreadState => {
  const configured = config.model
  const model =
    (configured && catalog.models.find((entry) => entry.id === configured)) ||
    catalog.models.find((entry) => entry.isDefault) ||
    catalog.models[0]
  const sandbox: CodexProtocol.v2.SandboxPolicy =
    config.sandbox_mode === 'read-only'
      ? { type: 'readOnly', networkAccess: false }
      : config.sandbox_mode === 'danger-full-access'
        ? { type: 'dangerFullAccess' }
        : {
            type: 'workspaceWrite',
            writableRoots: [],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          }
  return {
    cwd,
    workspaceRoots: [cwd],
    model: model?.id ?? configured ?? '',
    modelProvider: config.model_provider ?? 'openai',
    effort: config.model_reasoning_effort ?? model?.defaultReasoningEffort ?? null,
    approvalPolicy: config.approval_policy ?? 'on-request',
    approvalsReviewer: config.approvals_reviewer ?? 'user',
    permissions: profileForSandbox(sandbox),
    serviceTier: config.service_tier ?? model?.defaultServiceTier ?? null,
    mode: 'default',
  }
}

/**
 * Says, on the model option, when `stateFromConfig` had to substitute.
 *
 * The shared `config.toml` is written by every Codex client on the machine,
 * and the newest one — the desktop app, usually — names models the CLI
 * HarnessDesk runs may not serve yet. Substituting the default silently
 * looks like the app ignoring the user's settings; a line on the control
 * turns it into the one fact that explains the whole list.
 */
export const noteUnservedModel = (
  options: readonly ConfigOption[],
  configured: string | null | undefined,
  catalog: Catalog,
): ConfigOption[] => {
  if (!configured || catalog.models.some((entry) => entry.id === configured)) return [...options]
  const note = `Your Codex configuration names ${configured}, which this Codex does not offer. Its default is selected instead; a newer Codex may offer it.`
  return options.map((option) =>
    option.id === 'model'
      ? { ...option, description: option.description ? `${option.description} ${note}` : note }
      : option,
  )
}

/**
 * Draft values applied to a would-be thread, one at a time and validated
 * against the options that state declares — the same refusal a live session
 * would give. Changing the model without naming an effort resets the effort,
 * so the new model's own default shows instead of a level it may not support.
 */
export const overlayDraftValues = (
  state: ThreadState,
  values: Readonly<Record<string, OptionValue>>,
  catalog: Catalog,
): ThreadState => {
  let next = state
  for (const [id, value] of Object.entries(values)) {
    const option = findOption(sessionOptions(next, catalog), id)
    if (!option) throw new Error(`Codex has no session option named ${JSON.stringify(id)}.`)
    const refusal = refuseOptionValue(option, value)
    if (refusal) throw new Error(refusal)
    const text = value as string
    switch (id) {
      case 'model': {
        // Keep the effort when the new model supports it — Codex applies the
        // configured effort across models — and fall back to the new model's
        // default (effort: null) when it does not.
        const supported = catalog.models
          .find((entry) => entry.id === text)
          ?.supportedReasoningEfforts.some((entry) => entry.reasoningEffort === next.effort)
        next = { ...next, model: text, ...(supported ? {} : { effort: null }) }
        break
      }
      case 'effort':
        next = { ...next, effort: text as ReasoningEffort }
        break
      case 'mode':
        next = { ...next, mode: text as CodexProtocol.ModeKind }
        break
      case 'permissions':
        next = { ...next, permissions: text }
        break
      case 'approvals':
        next = { ...next, approvalPolicy: text as Exclude<AskForApproval, object> }
        break
      case 'approvalsReviewer':
        next = { ...next, approvalsReviewer: text as ApprovalsReviewer }
        break
      case 'serviceTier':
        next = { ...next, serviceTier: text === STANDARD_TIER ? null : text }
        break
    }
  }
  return next
}

export const settingsFromState = (state: ThreadState): SessionSettings => ({
  cwd: state.cwd,
  workspaceRoots: state.workspaceRoots,
  model: state.model,
  modelProvider: state.modelProvider,
})

/**
 * The built-in profiles correspond one to one with the legacy sandbox modes
 * (observed from `permissionProfile/list` on 0.135.0), so a thread started
 * with a sandbox rather than a profile still has a profile id to show.
 */
const profileForSandbox = (sandbox: CodexProtocol.v2.SandboxPolicy): string => {
  switch (sandbox.type) {
    case 'readOnly':
      return ':read-only'
    case 'dangerFullAccess':
      return ':danger-full-access'
    default:
      return ':workspace'
  }
}

// ----------------------------------------------------------------- vocabulary

const BUILTIN_PROFILES: Readonly<Record<string, Omit<OptionChoice, 'value'>>> = {
  ':read-only': { label: 'Read only', description: 'Can read the project but not change it.' },
  ':workspace': { label: 'Workspace write', description: 'Can edit files inside the project.' },
  ':danger-full-access': {
    label: 'Full access',
    description: 'No sandbox. Use with care.',
    risk: 'high',
  },
}

const APPROVALS: readonly OptionChoice[] = [
  { value: 'untrusted', label: 'Ask for everything', description: 'Approve every command and edit.' },
  { value: 'on-failure', label: 'Ask on failure', description: 'Escalate only when sandboxed work fails.' },
  { value: 'on-request', label: 'Agent decides', description: 'It escalates when it judges it needs to.' },
  { value: 'never', label: 'Never ask', description: 'Runs unattended. Use with care.', risk: 'high' },
]

const REVIEWERS: readonly OptionChoice[] = [
  { value: 'user', label: 'You', description: 'Every approval request comes to this window.' },
  {
    value: 'auto_review',
    label: 'Automatic review',
    description: 'A review step gathers context and decides by risk before asking you.',
    risk: 'elevated',
  },
  {
    value: 'guardian_subagent',
    label: 'Guardian sub-agent',
    description: 'A separate agent reviews requests on your behalf.',
    risk: 'elevated',
  },
]

/**
 * Display names for the reasoning levels Codex has shipped so far. A level
 * not listed here is shown by its id — never dropped — because the vendor
 * adds levels faster than this table learns them: `max` and `ultra` arrived
 * with GPT-5.6, and `xhigh` had been labelled "Max" until then. Labels must
 * therefore never borrow a word that could become a real id.
 */
export const effortLabel = (effort: string): string => EFFORT_LABELS[effort] ?? effort

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
}

const STANDARD_TIER = 'standard'

/** Ensures the current value is always among the choices, so a select never renders blank. */
const withCurrent = (choices: readonly OptionChoice[], current: string): OptionChoice[] =>
  choices.some((choice) => choice.value === current)
    ? [...choices]
    : [...choices, { value: current, label: current, description: 'Set outside this interface.' }]

// -------------------------------------------------------------------- options

const MANAGED_REASON = 'Restricted by a managed configuration.'

/** Marks choices outside `allowed` as disabled, keeping them visible with a reason. */
const gate = (choices: OptionChoice[], allowed: readonly string[] | null | undefined): OptionChoice[] =>
  allowed == null
    ? choices
    : choices.map((choice) =>
        allowed.includes(choice.value) ? choice : { ...choice, disabled: MANAGED_REASON },
      )

export const sessionOptions = (state: ThreadState, catalog: Catalog): ConfigOption[] => {
  const options: ConfigOption[] = []
  const model = catalog.models.find((entry) => entry.id === state.model)
  const req = catalog.requirements ?? null

  options.push({
    type: 'select',
    id: 'model',
    category: 'model',
    label: 'Model',
    ...(catalog.warning
      ? {
          description: `Codex could not read its current model catalogue (${catalog.warning}), so this list is the one built into the installed Codex. A newer Codex may read it.`,
        }
      : {}),
    currentValue: state.model,
    choices: withCurrent(
      catalog.models
        .filter((entry) => !entry.hidden)
        .map((entry) => ({
          value: entry.id,
          label: entry.displayName,
          ...(entry.description ? { description: entry.description } : {}),
        })),
      state.model,
    ),
  })

  if (model && model.supportedReasoningEfforts.length > 0) {
    const current = state.effort ?? model.defaultReasoningEffort
    options.push({
      type: 'select',
      id: 'effort',
      category: 'thought_level',
      label: 'Reasoning effort',
      description: 'How hard the model thinks before answering.',
      currentValue: current,
      choices: withCurrent(
        model.supportedReasoningEfforts.map((entry) => ({
          value: entry.reasoningEffort,
          label: EFFORT_LABELS[entry.reasoningEffort] ?? entry.reasoningEffort,
          ...(entry.description ? { description: entry.description } : {}),
        })),
        current,
      ),
    })
  }

  if (catalog.modes.length > 0) {
    options.push({
      type: 'select',
      id: 'mode',
      category: 'mode',
      label: 'Mode',
      description: 'How the agent collaborates — planning first, or acting directly.',
      currentValue: state.mode,
      choices: withCurrent(
        catalog.modes.flatMap((mask) =>
          mask.mode
            ? [
                {
                  value: mask.mode,
                  label: mask.name,
                  ...(mask.reasoning_effort
                    ? { description: `Reasons at ${EFFORT_LABELS[mask.reasoning_effort] ?? mask.reasoning_effort} effort.` }
                    : {}),
                },
              ]
            : [],
        ),
        state.mode,
      ),
    })
  }

  options.push({
    type: 'select',
    id: 'permissions',
    category: '_permissions',
    label: 'Permissions',
    description: 'What the agent may touch without asking.',
    currentValue: state.permissions,
    choices: gate(
      withCurrent(
        catalog.profiles.map((profile) => ({
          value: profile.id,
          ...(BUILTIN_PROFILES[profile.id] ?? {
            label: profile.id,
            description: profile.description ?? 'A profile from your configuration.',
          }),
        })),
        state.permissions,
      ),
      // 0.149.0 dropped `ConfigRequirements.allowedPermissions` for a per-profile
      // `allowed`, which Codex computes from the effective requirements. Only an
      // explicit `false` withholds a profile, so an unmanaged configuration — or
      // a Codex that predates the flag — disables nothing.
      catalog.profiles.some((profile) => profile.allowed === false)
        ? catalog.profiles.filter((profile) => profile.allowed !== false).map((profile) => profile.id)
        : null,
    ),
  })

  const approvalValue =
    typeof state.approvalPolicy === 'string' ? state.approvalPolicy : 'granular'
  options.push({
    type: 'select',
    id: 'approvals',
    category: '_permissions',
    label: 'Approvals',
    description: 'How much the agent asks before acting.',
    currentValue: approvalValue,
    choices: gate(
      approvalValue === 'granular'
        ? [
            ...APPROVALS,
            { value: 'granular', label: 'Custom', description: 'Per-capability rules from your configuration.' },
          ]
        : [...APPROVALS],
      req?.allowedApprovalPolicies
        ? req.allowedApprovalPolicies.map((policy) => (typeof policy === 'string' ? policy : 'granular'))
        : null,
    ),
  })

  options.push({
    type: 'select',
    id: 'approvalsReviewer',
    category: '_permissions',
    label: 'Reviewed by',
    description: 'Who decides on approval requests.',
    currentValue: state.approvalsReviewer,
    choices: gate(withCurrent(REVIEWERS, state.approvalsReviewer), req?.allowedApprovalsReviewers),
  })

  if (model && model.serviceTiers.length > 0) {
    const current = state.serviceTier ?? STANDARD_TIER
    options.push({
      type: 'select',
      id: 'serviceTier',
      category: 'other',
      label: 'Speed',
      description: 'Service tier for this model.',
      currentValue: current,
      choices: withCurrent(
        [
          { value: STANDARD_TIER, label: 'Standard' },
          ...model.serviceTiers.map((tier) => ({
            value: tier.id,
            label: tier.name,
            ...(tier.description ? { description: tier.description } : {}),
          })),
        ],
        current,
      ),
    })
  }

  return options
}

/**
 * The `thread/settings/update` fields that set one option, or an error for an
 * id this adapter does not declare. The caller has already checked the value
 * against the declared choices.
 */
export const settingsUpdateFor = (
  id: string,
  value: OptionValue,
  state: ThreadState,
  catalog: Catalog,
): Omit<CodexProtocol.v2.ThreadSettingsUpdateParams, 'threadId'> => {
  if (typeof value !== 'string') {
    throw new Error(`Codex option ${JSON.stringify(id)} takes a named value, not ${typeof value}.`)
  }
  switch (id) {
    case 'model':
      return { model: value }
    case 'effort':
      return { effort: value as ReasoningEffort }
    case 'mode': {
      const mask = catalog.modes.find((entry) => entry.mode === value)
      return {
        collaborationMode: {
          mode: value as CodexProtocol.ModeKind,
          settings: {
            model: state.model,
            reasoning_effort: mask?.reasoning_effort ?? state.effort,
            developer_instructions: null,
          },
        },
      }
    }
    case 'permissions':
      return { permissions: value }
    case 'approvals':
      return { approvalPolicy: value as Exclude<AskForApproval, object> }
    case 'approvalsReviewer':
      return { approvalsReviewer: value as ApprovalsReviewer }
    case 'serviceTier':
      return { serviceTier: value === STANDARD_TIER ? null : value }
    default:
      throw new Error(`Codex has no session option named ${JSON.stringify(id)}.`)
  }
}

/** The option values `thread/start`, `thread/resume` and `thread/fork` all take directly. */
export type StartOptionParams = Pick<
  CodexProtocol.v2.ThreadStartParams,
  'model' | 'permissions' | 'approvalPolicy' | 'approvalsReviewer' | 'serviceTier'
>

/**
 * Splits initial option values into what the thread verbs accept directly and
 * what must follow as a settings update, because `thread/start` takes a model
 * and a profile but not an effort or a mode.
 */
export const splitStartOptions = (
  options: Readonly<Record<string, OptionValue>>,
): {
  readonly start: StartOptionParams
  readonly after: readonly (readonly [string, OptionValue])[]
} => {
  const start: {
    model?: string
    permissions?: string
    approvalPolicy?: Exclude<AskForApproval, object>
    approvalsReviewer?: ApprovalsReviewer
    serviceTier?: string | null
  } = {}
  const after: (readonly [string, OptionValue])[] = []
  for (const [id, value] of Object.entries(options)) {
    if (typeof value !== 'string') {
      throw new Error(`Codex option ${JSON.stringify(id)} takes a named value, not ${typeof value}.`)
    }
    switch (id) {
      case 'model':
        start.model = value
        break
      case 'permissions':
        start.permissions = value
        break
      case 'approvals':
        start.approvalPolicy = value as Exclude<AskForApproval, object>
        break
      case 'approvalsReviewer':
        start.approvalsReviewer = value as ApprovalsReviewer
        break
      case 'serviceTier':
        start.serviceTier = value === STANDARD_TIER ? null : value
        break
      case 'effort':
      case 'mode':
        after.push([id, value])
        break
      default:
        throw new Error(`Codex has no session option named ${JSON.stringify(id)}.`)
    }
  }
  return { start, after }
}

// ------------------------------------------------------- runtime-wide options

export const FEATURE_PREFIX = 'feature.'

/**
 * Experimental features as toggles. Only `beta` features carry a display name
 * and description — the other stages are internal flags Codex's own
 * interface hides too — so only those are offered.
 */
export const runtimeOptions = (
  features: readonly CodexProtocol.v2.ExperimentalFeature[],
): ConfigOption[] =>
  features
    .filter((feature) => feature.stage === 'beta')
    .map((feature) => ({
      type: 'boolean',
      id: `${FEATURE_PREFIX}${feature.name}`,
      category: 'other',
      label: feature.displayName ?? feature.name,
      ...(feature.description ? { description: feature.description } : {}),
      currentValue: feature.enabled,
    }))

export const featureNameOf = (optionId: string): string | null =>
  optionId.startsWith(FEATURE_PREFIX) ? optionId.slice(FEATURE_PREFIX.length) : null
