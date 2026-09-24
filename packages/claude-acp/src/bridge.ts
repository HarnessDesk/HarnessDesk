import { closeSync, fstatSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import {
  agent as acpAgent,
  methods,
  ndJsonStream,
  RequestError,
  type AgentContext,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type SessionConfigOption,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
} from '@agentclientprotocol/sdk'
import { ClaudeAcpAgent, nodeToWebReadable, nodeToWebWritable } from '@agentclientprotocol/claude-agent-acp'

import { sessionFiles, trash } from './store.js'
import { DELEGATION_CAPABILITY, DELEGATION_LIST, DELEGATION_NOTIFICATION } from './delegation-wire.js'
import { SESSION_DELETE, SESSION_DELETE_CAPABILITY, TASKS_CAPABILITY, TASKS_CLEAR, TASKS_LIST, TASKS_NOTIFICATION, TASKS_STOP } from './tasks-wire.js'
import { DelegationRegistry } from './delegation.js'
import { childEnvironment, environmentAck, environmentIn } from './lane-environment.js'
import { TaskRegistry } from './tasks.js'
import {
  ATTACHMENT_CAPABILITY_VALUE,
  ATTACHMENT_RECEIPT,
  ATTACHMENTS_CAPABILITY,
  attachmentOptions,
  attachmentReceipt,
  decodeAttachmentInput,
  type AttachmentInput,
  type StagedAttachments,
} from './attachments.js'

const DEFAULT = 'default'
const EFFORT_OPTION_ID = 'effort'
const AUTOCOMPACT_OPTION_ID = 'autocompact'
const OUTPUT_STYLE_OPTION_ID = 'output_style'
const INSTRUCTIONS_CAPABILITY = 'instructions'
const CLAUDE_CONFIG_DIR = process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude')
const TITLE_WINDOW = 512 * 1024
const NOTICE_LIMIT = 300
const LABELS: Readonly<Record<string, string>> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }
const AUTOCOMPACT_CHOICES = [
  { value: DEFAULT, name: 'Default', description: "Claude Code's own setting for this project." },
  { value: 'auto', name: 'Automatic', description: 'Claude Code decides when to compact.' },
  { value: '100k', name: '100k' },
  { value: '200k', name: '200k' },
  { value: '500k', name: '500k' },
  { value: '1m', name: '1M' },
] as const
type Meta = Record<string, unknown> | null | undefined

const encodeProjectPath = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')
export const transcriptPath = (cwd: string, sessionId: string): string => join(CLAUDE_CONFIG_DIR, 'projects', encodeProjectPath(cwd), `${sessionId}.jsonl`)

const WRAPPER_TAGS = ['local-command-caveat', 'local-command-stdout', 'local-command-stderr', 'command-name', 'command-message', 'command-args', 'system-reminder', 'preview-annotation-context', 'context'] as const
const FOLDED_TAGS = ['context', 'preview-annotation-context'] as const
const PLUMBING_TAGS = [...WRAPPER_TAGS.filter((tag) => !(FOLDED_TAGS as readonly string[]).includes(tag)), 'task-notification'] as const
const INTERRUPTIONS = ['[Request interrupted by user', '[Request interrupted for tool use']
const IMAGE_NOTES = /\[Image:[^\]]*\]/g
const ANSI = /\u001b\[[0-9;]*m/g

export const unwrap = (title: string | null | undefined): string | null => {
  let text = title ?? ''
  for (const tag of WRAPPER_TAGS) text = text.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?(?:</${tag}>|$)`, 'g'), ' ')
  const cleaned = text.replace(/\s+/g, ' ').trim()
  return cleaned.length > 0 ? cleaned : null
}
const tagContents = (text: string, tag: string): string | null => new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(text)?.[1] ?? null
const oneLine = (text: string): string => {
  const clean = text.replace(ANSI, '').replace(/\s+/g, ' ').trim()
  return clean.length > NOTICE_LIMIT ? `${clean.slice(0, NOTICE_LIMIT - 1)}…` : clean
}
export type Replayed = { readonly kind: 'prompt'; readonly text: string } | { readonly kind: 'notice'; readonly text: string; readonly echo?: true } | null
export type StoredKind = 'meta' | 'compact'

export const classifyReplayed = (raw: string, stored?: StoredKind): Replayed => {
  const text = raw.trim()
  if (text.length === 0) return null
  if (INTERRUPTIONS.some((marker) => text.startsWith(marker))) return { kind: 'notice', text: 'Interrupted' }
  if (text.startsWith('<task-notification>')) {
    const summary = oneLine(tagContents(text, 'summary') ?? '')
    return { kind: 'notice', text: summary.length > 0 ? summary : 'A background task reported back' }
  }
  for (const tag of ['local-command-stdout', 'local-command-stderr'] as const) {
    if (!text.includes(`<${tag}>`)) continue
    const said = oneLine(tagContents(text, tag) ?? '')
    return said.length > 0 ? { kind: 'notice', text: said, echo: true } : null
  }
  let stripped = text
  for (const tag of PLUMBING_TAGS) stripped = stripped.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?(?:</${tag}>|$)`, 'g'), ' ')
  const spoken = stripped.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  if (spoken.length === 0) return null
  if (stored === undefined) return { kind: 'prompt', text: spoken }
  if (stored === 'compact') return { kind: 'notice', text: 'Continued from a previous conversation' }
  const worth = spoken.replace(IMAGE_NOTES, ' ').replace(/[ \t]+/g, ' ').trim()
  return worth.length > 0 ? { kind: 'notice', text: `Claude Code added: ${oneLine(worth)}` } : null
}

export const storedTitle = (path: string): string | null => {
  let handle: number
  try { handle = openSync(path, 'r') } catch { return null }
  try {
    const size = fstatSync(handle).size
    const length = Math.min(size, TITLE_WINDOW)
    const buffer = Buffer.alloc(length)
    readSync(handle, buffer, 0, length, size - length)
    let ai: string | null = null
    for (const line of buffer.toString('utf8').split('\n').reverse()) {
      if (!line.includes('-title"')) continue
      try {
        const entry = JSON.parse(line) as { type?: string; customTitle?: string; aiTitle?: string }
        if (entry.type === 'custom-title') {
          const named = unwrap(entry.customTitle)
          if (named) return named
        }
        if (entry.type === 'ai-title' && ai === null) ai = unwrap(entry.aiTitle)
      } catch { continue }
    }
    return ai
  } finally { closeSync(handle) }
}

const safeBlock = (block: unknown): unknown => {
  const shaped = block as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown; source?: { type?: unknown; data?: unknown; media_type?: unknown; url?: unknown } } | null
  if (shaped === null || typeof shaped !== 'object') return { type: 'text', text: '[unreadable content]' }
  if (shaped.type === 'text' && typeof shaped.text === 'string') return block
  if (shaped.type === 'image') {
    if (typeof shaped.data === 'string' && typeof shaped.mimeType === 'string') return block
    if (shaped.source?.type === 'base64' && typeof shaped.source.data === 'string') return { type: 'image', data: shaped.source.data, mimeType: shaped.source.media_type ?? 'image/png' }
    if (typeof shaped.source?.url === 'string') return { type: 'text', text: `[image: ${shaped.source.url}]` }
    return { type: 'text', text: '[image]' }
  }
  return { type: 'text', text: `[${typeof shaped.type === 'string' ? shaped.type : 'unknown'} content]` }
}
export const acpSafeToolContent = (update: SessionNotification['update']): SessionNotification['update'] => {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return update
  const entries = (update as { content?: readonly unknown[] }).content
  if (!Array.isArray(entries)) return update
  let changed = false
  const safe = entries.map((entry) => {
    const wrapper = entry as { type?: unknown; content?: unknown }
    if (wrapper === null || typeof wrapper !== 'object' || wrapper.type !== 'content') return entry
    const block = safeBlock(wrapper.content)
    if (block === wrapper.content) return entry
    changed = true
    return { ...wrapper, content: block }
  })
  return changed ? ({ ...update, content: safe } as SessionNotification['update']) : update
}

export const levelsOf = (models: readonly { value: string; supportedEffortLevels?: readonly string[] }[], modelId: string | null): readonly string[] => models.find((entry) => entry.value === modelId)?.supportedEffortLevels ?? []
export const withEffortLevels = (models: unknown, declared: readonly { value: string; supportedEffortLevels?: readonly string[] }[]): { models?: unknown } => {
  if (!models || typeof models !== 'object') return {}
  const value = models as { availableModels?: readonly Record<string, unknown>[] }
  if (!Array.isArray(value.availableModels)) return {}
  return { models: { ...value, availableModels: value.availableModels.map((model) => ({ ...model, _meta: { ...(model._meta as Record<string, unknown> | undefined), harnessdesk: { ...((model._meta as Record<string, unknown> | undefined)?.['harnessdesk'] as Record<string, unknown> | undefined), effortLevels: levelsOf(declared, String(model.modelId)).map((level) => ({ id: level, label: LABELS[level] ?? level })) } } })) } }
}
export const VERSION = '0.1.0'

export const withInstructions = <T extends { _meta?: Meta }>(params: T): T => {
  const harnessdesk = params._meta?.['harnessdesk']
  const text = typeof harnessdesk === 'object' && harnessdesk !== null ? (harnessdesk as Record<string, unknown>)[INSTRUCTIONS_CAPABILITY] : undefined
  if (typeof text !== 'string' || text.trim() === '' || typeof params._meta?.['systemPrompt'] === 'string') return params
  const existing = params._meta?.['systemPrompt']
  const appended = typeof existing === 'object' && existing !== null && typeof (existing as { append?: unknown }).append === 'string' ? `${(existing as { append: string }).append}\n\n${text.trim()}` : text.trim()
  return { ...params, _meta: { ...(params._meta ?? {}), systemPrompt: { append: appended } } }
}

/**
 * Phase 12's own extension applied at session creation: decodes
 * `_meta.harnessdesk.attachments`, stages what it approves, and merges the
 * resulting `claudeCode.options` fields (`skills`, `plugins`,
 * `settingSources`, `strictMcpConfig`) onto whatever is already in `_meta` —
 * never in place of it, so this composes with `withInstructions`/`withOptions`
 * regardless of call order. A request that never carried the extension at
 * all comes back unchanged: the plain path this bridge already has stays
 * exactly as it was.
 */
const withAttachments = <T extends { _meta?: Meta }>(
  params: T,
  stagingRoot: (key: string) => string,
): { params: T; input: AttachmentInput | null; staged: StagedAttachments | null } => {
  const input = decodeAttachmentInput(params._meta)
  if (!input) return { params, input: null, staged: null }
  const attached = attachmentOptions(input, stagingRoot(input.key))
  if (!attached) return { params, input, staged: null }
  const meta = params._meta ?? {}
  const claudeCode = (meta['claudeCode'] ?? {}) as { options?: Record<string, unknown> }
  const merged: T = { ...params, _meta: { ...meta, claudeCode: { ...claudeCode, options: { ...(claudeCode.options ?? {}), ...attached.options } } } }
  return { params: merged, input, staged: attached.staged }
}
const CONTROL_IDS = [EFFORT_OPTION_ID, AUTOCOMPACT_OPTION_ID, OUTPUT_STYLE_OPTION_ID] as const
export const valueOf = (state: { values: Record<string, string> }, id: string): string => state.values[id] ?? DEFAULT
export const optionsIn = (meta: Meta): Record<string, string> => {
  const harnessdesk = meta?.['harnessdesk']
  const options = typeof harnessdesk === 'object' && harnessdesk !== null ? (harnessdesk as { options?: unknown }).options : undefined
  if (typeof options !== 'object' || options === null) return {}
  const result: Record<string, string> = {}
  for (const id of CONTROL_IDS) {
    const value = (options as Record<string, unknown>)[id]
    if (typeof value === 'string' && value.length > 0) result[id] = value
  }
  return result
}
const parsedSettings = (raw: unknown): Record<string, unknown> => {
  if (typeof raw !== 'string' || raw === '') return {}
  try { const parsed: unknown = JSON.parse(raw); return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {} } catch { return {} }
}
export const withOptions = (meta: Meta, values: Record<string, string>, abort: AbortController): Record<string, unknown> => {
  const claudeCode = (meta?.['claudeCode'] ?? {}) as { options?: Record<string, unknown> }
  const options: Record<string, unknown> = { ...(claudeCode.options ?? {}), abortController: abort }
  const environment = environmentIn(meta)
  if (environment) {
    options['env'] = childEnvironment(
      { ...process.env, ...(options['env'] as NodeJS.ProcessEnv | undefined) },
      environment,
    )
  }
  if (values[EFFORT_OPTION_ID] && values[EFFORT_OPTION_ID] !== DEFAULT) options['effort'] = values[EFFORT_OPTION_ID]
  else delete options['effort']
  const extraArgs = { ...((options['extraArgs'] as Record<string, string | null> | undefined) ?? {}) }
  const autocompact = values[AUTOCOMPACT_OPTION_ID]
  if (autocompact && autocompact !== DEFAULT) extraArgs['autocompact'] = autocompact
  else delete extraArgs['autocompact']
  const style = values[OUTPUT_STYLE_OPTION_ID]
  const settings = parsedSettings(extraArgs['settings'])
  if (style && style !== DEFAULT) extraArgs['settings'] = JSON.stringify({ ...settings, outputStyle: style })
  else if ('outputStyle' in settings) {
    const { outputStyle: _outputStyle, ...rest } = settings
    if (Object.keys(rest).length > 0) extraArgs['settings'] = JSON.stringify(rest)
    else delete extraArgs['settings']
  }
  if (Object.keys(extraArgs).length > 0) options['extraArgs'] = extraArgs
  else delete options['extraArgs']
  return { ...(meta ?? {}), claudeCode: { ...claudeCode, options, emitRawSDKMessages: true } }
}
export const commandsFor = (values: Record<string, string>, spawned: Record<string, string>): readonly string[] => {
  const commands: string[] = []
  for (const id of [EFFORT_OPTION_ID, AUTOCOMPACT_OPTION_ID]) {
    const value = values[id] ?? DEFAULT
    if (value !== (spawned[id] ?? DEFAULT)) commands.push(`/${id} ${value === DEFAULT ? 'auto' : value}`)
  }
  return commands
}

export interface HarnessDeskClaudeAgentOptions { readonly stateDir?: string; readonly log?: (line: string) => void }
type AcpClient = { sessionUpdate(params: SessionNotification): Promise<void>; requestPermission(params: unknown, signal?: AbortSignal): Promise<unknown>; readTextFile?(params: unknown): Promise<unknown>; writeTextFile?(params: unknown): Promise<unknown>; createElicitation?(params: unknown, signal?: AbortSignal): Promise<unknown>; completeElicitation?(params: unknown): Promise<void>; extNotification?(method: string, params: unknown): Promise<void> }
type Logger = { log: (...args: unknown[]) => void; error: (...args: unknown[]) => void }

const clientFromContext = (context: AgentContext): AcpClient => ({
  sessionUpdate: (params) => context.notify(methods.client.session.update, params as never),
  requestPermission: (params, signal) => context.request(methods.client.session.requestPermission, params as never, { cancellationSignal: signal }),
  readTextFile: (params) => context.request(methods.client.fs.readTextFile, params as never),
  writeTextFile: (params) => context.request(methods.client.fs.writeTextFile, params as never),
  createElicitation: (params, signal) => context.request(methods.client.elicitation.create, params as never, { cancellationSignal: signal }),
  completeElicitation: (params) => context.notify(methods.client.elicitation.complete, params as never),
  extNotification: (method, params) => context.notify(method, params as never),
})
type StoredControls = { values: Record<string, string>; meta?: Meta; cwd: string }
type ModelInfo = { value: string; supportedEffortLevels?: readonly string[] }
type StoredControlsWithRuntime = StoredControls & { styles: readonly string[]; spawned: Record<string, string>; prompted: boolean }
const customOptions = (stored: StoredControlsWithRuntime): SessionConfigOption[] => [
  { type: 'select', id: AUTOCOMPACT_OPTION_ID, name: 'Auto-compact', description: 'When Claude Code compacts its context window.', category: 'model_config', currentValue: stored.values[AUTOCOMPACT_OPTION_ID] ?? DEFAULT, options: AUTOCOMPACT_CHOICES.map((choice) => ({ ...choice })) },
  ...(stored.styles.length > 0
    ? [{ type: 'select' as const, id: OUTPUT_STYLE_OPTION_ID, name: 'Output style', description: 'How Claude Code writes its replies.', category: 'model_config' as const, currentValue: stored.values[OUTPUT_STYLE_OPTION_ID] ?? DEFAULT, options: [{ value: DEFAULT, name: 'Default', description: "Claude Code's own setting for this project." }, ...stored.styles.filter((style) => style !== DEFAULT).map((style) => ({ value: style, name: style }))] }]
    : []),
]

const optionStyles = async (agent: ClaudeAcpAgent, sessionId: string): Promise<readonly string[]> => {
  const query = agent.sessions[sessionId]?.query as { initializationResult?: () => Promise<unknown> } | undefined
  if (!query?.initializationResult) return []
  try {
    const value = await query.initializationResult()
    const styles = (value as { available_output_styles?: unknown })?.available_output_styles
    return Array.isArray(styles) ? styles.filter((style): style is string => typeof style === 'string' && style.length > 0) : []
  } catch {
    return []
  }
}

const decorateModelOptions = <T extends { configOptions?: SessionConfigOption[] | null }>(response: T, modelInfos: readonly ModelInfo[]): T => {
  const levelsFor = (value: string): readonly { id: string; label: string }[] => {
    const model = modelInfos.find((entry) => entry.value === value)
    return (model?.supportedEffortLevels ?? []).map((level) => ({ id: level, label: LABELS[level] ?? level }))
  }
  const configOptions = response.configOptions?.map((option) => {
    if (option.id !== 'model' || option.type !== 'select' || !Array.isArray(option.options)) return option
    const decorateChoice = (choice: (typeof option.options)[number]): (typeof option.options)[number] => {
      if ('value' in choice) {
        return {
          ...choice,
          _meta: { ...(choice._meta ?? {}), harnessdesk: { effortLevels: levelsFor(choice.value) } },
        }
      }
      return { ...choice, options: choice.options.map((nested) => ({ ...nested, _meta: { ...(nested._meta ?? {}), harnessdesk: { effortLevels: levelsFor(nested.value) } } })) }
    }
    return {
      ...option,
      options: option.options.map(decorateChoice),
    }
  })
  return configOptions ? { ...response, configOptions } : response
}

export class HarnessDeskClaudeAgent extends ClaudeAcpAgent {
  readonly #controls = new Map<string, StoredControlsWithRuntime>()
  readonly #tasks = new Map<string, TaskRegistry>()
  readonly #delegations = new Map<string, DelegationRegistry>()
  readonly #outputPollers = new Map<string, ReturnType<typeof setTimeout>>()
  readonly #deletedSessions = new Set<string>()
  /** The exact input a session was prepared with, and what actually got staged for it — set once at create/load, reapplied unchanged by `#recreate`. */
  readonly #attachments = new Map<string, { input: AttachmentInput; staged: StagedAttachments }>()
  readonly #stateDir: string
  readonly #log: (line: string) => void
  constructor(client: AcpClient, options: HarnessDeskClaudeAgentOptions = {}) {
    const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`))
    const logger: Logger = { log: (...args) => log(String(args[0] ?? '')), error: (...args) => log(String(args[0] ?? '')) }
    super(client as never, logger)
    const notify = client.sessionUpdate.bind(client)
    const extNotify = client.extNotification?.bind(client)
    if (extNotify) {
      client.extNotification = async (method, params) => {
        if (method === '_claude/sdkMessage') {
          const payload = params as { sessionId?: unknown; message?: unknown }
          const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
          if (sessionId && !this.#deletedSessions.has(sessionId) && payload.message) {
            const tasks = this.#tasks.get(sessionId) ?? new TaskRegistry()
            const delegations = this.#delegations.get(sessionId) ?? new DelegationRegistry()
            this.#tasks.set(sessionId, tasks)
            this.#delegations.set(sessionId, delegations)
            if (tasks.observe(payload.message)) {
              await extNotify(TASKS_NOTIFICATION, { sessionId, tasks: tasks.list() })
              this.#pollTaskOutput(sessionId)
            }
            if (delegations.observe(payload.message)) {
              await extNotify(DELEGATION_NOTIFICATION, { sessionId, delegations: delegations.list(), delegated: delegations.totals() })
            }
          }
        }
        return extNotify(method, params)
      }
    }
    client.sessionUpdate = async (params) => {
      if (params.update.sessionUpdate === 'config_option_update') {
        const stored = this.#controls.get(params.sessionId)
        const base = decorateModelOptions({ configOptions: params.update.configOptions }, (this.sessions[params.sessionId]?.modelInfos ?? []) as readonly ModelInfo[]).configOptions ?? []
        const custom = stored ? customOptions(stored) : []
        return notify({ ...params, update: { ...params.update, configOptions: [...base, ...custom] } })
      }
      return notify(params)
    }
    this.#stateDir = options.stateDir ?? process.env['CLAUDE_ACP_STATE_DIR'] ?? join(homedir(), '.harnessdesk', 'claude-acp')
    this.#log = options.log ?? ((line) => process.stderr.write(`${line}\n`))
  }
  override async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    const response = await super.initialize(request)
    return {
      ...response,
      agentInfo: { name: '@harnessdesk/claude-acp', title: 'Claude Code', version: VERSION },
      _meta: {
        ...(response._meta ?? {}),
        harnessdesk: {
          [TASKS_CAPABILITY]: true,
          [SESSION_DELETE_CAPABILITY]: true,
          [DELEGATION_CAPABILITY]: true,
          [INSTRUCTIONS_CAPABILITY]: true,
          sessionEnvironment: true,
          [ATTACHMENTS_CAPABILITY]: ATTACHMENT_CAPABILITY_VALUE,
        },
      },
    }
  }
  override async newSession(request: NewSessionRequest): Promise<NewSessionResponse> {
    const instructed = withInstructions(request)
    const { params, input, staged } = withAttachments(instructed, (key) => join(this.#stateDir, 'attachments', key))
    const values = optionsIn(params._meta)
    const response = await super.newSession({ ...params, _meta: withOptions(params._meta, values, new AbortController()) })
    this.#deletedSessions.delete(response.sessionId)
    if (input && staged) this.#attachments.set(response.sessionId, { input, staged })
    else this.#attachments.delete(response.sessionId)
    const session = this.sessions[response.sessionId]
    const decorated = decorateModelOptions(response, (session?.modelInfos ?? []) as readonly ModelInfo[])
    const stored: StoredControlsWithRuntime = { values: { ...values }, spawned: { ...values }, prompted: false, styles: await optionStyles(this, response.sessionId), meta: params._meta, cwd: params.cwd }
    this.#controls.set(response.sessionId, stored)
    this.#tasks.set(response.sessionId, new TaskRegistry())
    this.#delegations.set(response.sessionId, new DelegationRegistry())
    this.#writeControls(response.sessionId, stored.values)
    return environmentAck(
      { ...decorated, configOptions: [...(decorated.configOptions ?? []), ...customOptions(stored)] },
      environmentIn(params._meta),
    )
  }
  override async loadSession(request: LoadSessionRequest): Promise<LoadSessionResponse> {
    const remembered = this.#readControls(request.sessionId)
    this.#deletedSessions.delete(request.sessionId)
    const instructed = withInstructions(request)
    const { params, input, staged } = withAttachments(instructed, (key) => join(this.#stateDir, 'attachments', key))
    const response = await super.loadSession({ ...params, _meta: withOptions(params._meta, remembered, new AbortController()) })
    if (input && staged) this.#attachments.set(request.sessionId, { input, staged })
    else this.#attachments.delete(request.sessionId)
    const session = this.sessions[request.sessionId]
    const decorated = decorateModelOptions(response, (session?.modelInfos ?? []) as readonly ModelInfo[])
    const stored: StoredControlsWithRuntime = { values: remembered, spawned: { ...remembered }, prompted: true, styles: await optionStyles(this, request.sessionId), meta: params._meta, cwd: params.cwd }
    this.#controls.set(request.sessionId, stored)
    this.#tasks.set(request.sessionId, new TaskRegistry())
    this.#delegations.set(request.sessionId, new DelegationRegistry())
    await this.#replayStored(request.sessionId)
    return environmentAck(
      { ...decorated, configOptions: [...(decorated.configOptions ?? []), ...customOptions(stored)] },
      environmentIn(params._meta),
    )
  }
  override async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    if (!CONTROL_IDS.includes(params.configId as typeof CONTROL_IDS[number])) {
      const response = await super.setSessionConfigOption(params)
      const stored = this.#controls.get(params.sessionId)
      const base = decorateModelOptions({ configOptions: response.configOptions }, (this.sessions[params.sessionId]?.modelInfos ?? []) as readonly ModelInfo[]).configOptions ?? []
      const configOptions = [...base, ...(stored ? customOptions(stored) : [])]
      if (params.configId === 'model') await this.client.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'config_option_update', configOptions } })
      return { ...response, configOptions }
    }
    const stored = this.#controls.get(params.sessionId)
    if (!stored) throw RequestError.invalidParams(`Session not found: ${params.sessionId}`)
    const value = String(params.value)
    if (params.configId === AUTOCOMPACT_OPTION_ID && !AUTOCOMPACT_CHOICES.some((choice) => choice.value === value)) throw RequestError.invalidParams(`${JSON.stringify(value)} is not an auto-compact window Claude Code takes.`)
    if (params.configId === OUTPUT_STYLE_OPTION_ID && value !== DEFAULT && !stored.styles.includes(value)) throw RequestError.invalidParams(`${JSON.stringify(value)} is not an output style Claude Code reported.`)
    if (params.configId === EFFORT_OPTION_ID) {
      const option = this.sessions[params.sessionId]?.configOptions.find((entry): entry is Extract<SessionConfigOption, { type: 'select' }> => entry.id === EFFORT_OPTION_ID && entry.type === 'select')
      if (!option || !option.options.some((choice) => 'value' in choice && choice.value === value)) throw RequestError.invalidParams(`${JSON.stringify(value)} is not an effort level Claude Code takes.`)
    }
    if (stored.values[params.configId] === value) return { configOptions: customOptions(stored) }
    stored.values[params.configId] = value
    this.#writeControls(params.sessionId, stored.values)
    if (stored.prompted) {
      await this.#recreate(params.sessionId, stored)
      stored.spawned = { ...stored.values }
    } else {
      this.#log(`claude-acp: ${params.configId}=${value} queued for ${params.sessionId} until its first prompt`)
    }
    return { configOptions: customOptions(stored) }
  }
  override async prompt(params: Parameters<ClaudeAcpAgent['prompt']>[0]): ReturnType<ClaudeAcpAgent['prompt']> {
    const stored = this.#controls.get(params.sessionId)
    if (stored && !stored.prompted) {
      for (const command of commandsFor(stored.values, stored.spawned)) {
        await super.prompt({ sessionId: params.sessionId, prompt: [{ type: 'text', text: command }] })
      }
      stored.spawned = { ...stored.values }
      stored.prompted = true
    }
    const response = await super.prompt(params)
    if (stored && stored.values[OUTPUT_STYLE_OPTION_ID] !== stored.spawned[OUTPUT_STYLE_OPTION_ID] && stored.prompted) {
      await this.#recreate(params.sessionId, stored)
      stored.spawned = { ...stored.values }
    }
    if (!response.usage) return response
    return {
      ...response,
      _meta: {
        ...((response._meta ?? {}) as Record<string, unknown>),
        harnessdesk: {
          ...(((response._meta as Record<string, unknown> | null | undefined)?.['harnessdesk'] as Record<string, unknown> | undefined) ?? {}),
          inputTokensAreUncached: true,
        },
      },
    }
  }
  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method === SESSION_DELETE) {
      const sessionId = typeof params['sessionId'] === 'string' ? params['sessionId'] : ''
      if (!sessionId) throw RequestError.invalidParams('A session id is required.')
      this.#deletedSessions.add(sessionId)
      this.#controls.delete(sessionId)
      this.#tasks.delete(sessionId)
      this.#delegations.delete(sessionId)
      this.#attachments.delete(sessionId)
      const poller = this.#outputPollers.get(sessionId)
      if (poller) clearTimeout(poller)
      this.#outputPollers.delete(sessionId)
      this.#writeControls(sessionId, {})
      return { removed: trash(sessionFiles(sessionId)), disposition: 'trash' }
    }
    if (method === TASKS_LIST) return { tasks: this.#tasks.get(String(params['sessionId']))?.list() ?? [] }
    if (method === DELEGATION_LIST) {
      const registry = this.#delegations.get(String(params['sessionId']))
      return { delegations: registry?.list() ?? [], delegated: registry?.totals() ?? null }
    }
    if (method === TASKS_STOP) {
      const sessionId = String(params['sessionId'] ?? '')
      const taskId = String(params['taskId'] ?? '')
      const registry = this.#tasks.get(sessionId)
      if (!registry?.list().some((task) => task.id === taskId && task.state === 'running')) {
        this.#log(`claude-acp: task stop refused ${sessionId} ${taskId} ${JSON.stringify(registry?.list() ?? [])}`)
        return { stopped: false }
      }
      try {
        await this.sessions[sessionId]?.query.stopTask(taskId)
        registry.markStopped(taskId)
        await this.client.extNotification?.(TASKS_NOTIFICATION, { sessionId, tasks: registry.list() })
        return { stopped: true }
      } catch (error) {
        this.#log(`claude-acp: failed to stop task ${taskId}: ${String(error)}`)
        return { stopped: false }
      }
    }
    if (method === TASKS_CLEAR) {
      const sessionId = String(params['sessionId'] ?? '')
      const registry = this.#tasks.get(sessionId)
      if (registry?.clearFinished()) await this.client.extNotification?.(TASKS_NOTIFICATION, { sessionId, tasks: registry.list() })
      return { cleared: true }
    }
    if (method === ATTACHMENT_RECEIPT) {
      const sessionId = typeof params['sessionId'] === 'string' ? params['sessionId'] : ''
      const key = typeof params['key'] === 'string' ? params['key'] : ''
      const prepared = this.#attachments.get(sessionId)
      // The client never accepts a receipt it did not ask for and never
      // trusts a key that does not match what it prepared — enforced on its
      // own side too, but this bridge never answers for a session/key pair
      // it does not itself recognize as the one it was actually prepared
      // with, host-side re-validation or not.
      if (!prepared || prepared.input.key !== key) throw RequestError.invalidParams(`No prepared attachment input matches session ${sessionId} and its key.`)
      const query = this.sessions[sessionId]?.query as
        | { supportedCommands(): Promise<readonly { readonly name: string }[]>; mcpServerStatus(): Promise<readonly { readonly name: string; readonly status: string }[]> }
        | undefined
      if (!query) throw RequestError.invalidParams(`Session not found: ${sessionId}`)
      const receipt = await attachmentReceipt(prepared.input, prepared.staged, query)
      return { key: receipt.key, loaded: receipt.loaded, refused: receipt.refused }
    }
    throw RequestError.methodNotFound(method)
  }

  #pollTaskOutput(sessionId: string): void {
    if (this.#deletedSessions.has(sessionId) || this.#outputPollers.has(sessionId)) return
    const retries = (process.env['CLAUDE_ACP_TASK_OUTPUT_RETRIES_MS'] ?? '250,500,1000,2000,4000,8000').split(',').map(Number).filter((value) => Number.isFinite(value) && value >= 0)
    const poll = (attempt: number): void => {
      if (this.#deletedSessions.has(sessionId)) {
        this.#outputPollers.delete(sessionId)
        return
      }
      const registry = this.#tasks.get(sessionId)
      if (!registry) return
      let changed = false
      for (const entry of registry.awaitingOutput()) {
        try { changed = registry.attachOutput(entry.id, readFileSync(entry.outputFile, 'utf8')) || changed } catch {}
      }
      if (changed) void this.client.extNotification?.(TASKS_NOTIFICATION, { sessionId, tasks: registry.list() })
      const pending = registry.awaitingOutput()
      if (pending.length === 0) { this.#outputPollers.delete(sessionId); return }
      if (attempt >= retries.length) {
        for (const entry of pending) registry.markOutputMissing(entry.id)
        void this.client.extNotification?.(TASKS_NOTIFICATION, { sessionId, tasks: registry.list() })
        this.#outputPollers.delete(sessionId)
        return
      }
      this.#outputPollers.set(sessionId, setTimeout(() => poll(attempt + 1), retries[attempt] ?? 0))
    }
    poll(0)
  }
  async #recreate(sessionId: string, stored: StoredControlsWithRuntime): Promise<void> {
    const session = this.sessions[sessionId]
    if (!session) throw RequestError.invalidParams(`Session not found: ${sessionId}`)
    const creation = session.creationParams
    await super.closeSession({ sessionId })
    // `resume: sessionId` is added to whatever `claudeCode.options` already
    // held — never in its place. Phase 12's own fields (`skills`, `plugins`,
    // `settingSources`, `strictMcpConfig`) live in exactly that object, set
    // once at create/load time and never re-derived from the Agent's current
    // file here: a reconfigure or a resume reapplies the same frozen filter,
    // it does not ask this Agent what it wishes for today.
    const frozenClaudeCode = (stored.meta?.['claudeCode'] as Record<string, unknown> | undefined) ?? {}
    const frozenOptions = (frozenClaudeCode['options'] as Record<string, unknown> | undefined) ?? {}
    const response = await super.resumeSession({
      sessionId,
      cwd: stored.cwd,
      ...(creation?.mcpServers ? { mcpServers: creation.mcpServers } : {}),
      _meta: withOptions({ ...(stored.meta ?? {}), claudeCode: { ...frozenClaudeCode, options: { ...frozenOptions, resume: sessionId } } }, stored.values, new AbortController()),
    })
    const current = this.#controls.get(sessionId)
    if (current) {
      current.styles = await optionStyles(this, sessionId)
      this.#controls.set(sessionId, current)
    }
    void response
  }

  async #replayStored(sessionId: string): Promise<void> {
    const path = sessionFiles(sessionId)[0]
    if (!path) return
    let entries: Record<string, unknown>[] = []
    try {
      entries = readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
        try { const value = JSON.parse(line) as Record<string, unknown>; return value.type ? [value] : [] } catch { return [] }
      })
    } catch { return }
    const noticed = new Set<string>()
    const send = async (update: SessionNotification['update']): Promise<void> => this.client.sessionUpdate({ sessionId, update })
    for (const entry of entries) {
      const message = entry.message as { role?: string; content?: unknown } | undefined
      const content = message?.content
      if (entry.type === 'user') {
        const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
        for (const block of blocks) {
          const text = typeof block === 'string' ? block : (block as { type?: string; text?: unknown })?.type === 'text' ? String((block as { text: unknown }).text) : ''
          if (text) {
            const replay = classifyReplayed(text, entry.isCompactSummary === true ? 'compact' : entry.isMeta === true ? 'meta' : undefined)
            const echo = replay?.kind === 'notice' && replay.echo === true
            if (replay && !(echo && noticed.has(replay.text))) {
              if (echo) noticed.add(replay.text)
              await send({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: replay.text }, ...(replay.kind === 'notice' ? { _meta: { harnessdesk: { notice: true } } } : {}) })
            }
          }
          const toolResult = typeof block === 'object' && block !== null && (block as { type?: string }).type === 'tool_result' ? block as { tool_use_id?: string; content?: unknown } : null
          if (toolResult?.tool_use_id) {
            const result = Array.isArray(toolResult.content) ? toolResult.content.map((item) => safeBlock(item)) : [{ type: 'text', text: String(toolResult.content ?? '') }]
            await send({ sessionUpdate: 'tool_call_update', toolCallId: toolResult.tool_use_id, status: 'completed', content: result.map((item) => ({ type: 'content', content: item })) as never })
          }
        }
      } else if (entry.type === 'assistant' && Array.isArray(content)) {
        for (const block of content) {
          const value = block as { type?: string; id?: string; name?: string; input?: unknown; text?: string }
          if (value.type === 'tool_use' && value.id) {
            await send({ sessionUpdate: 'tool_call', toolCallId: value.id, title: value.name ?? 'tool', kind: 'other', status: 'in_progress', rawInput: value.input })
          } else if (value.type === 'text' && typeof value.text === 'string') {
            await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value.text } })
          }
        }
      }
    }
  }
  static serve(options: HarnessDeskClaudeAgentOptions = {}): void {
    const stream = ndJsonStream(nodeToWebWritable(process.stdout), nodeToWebReadable(process.stdin))
    let agent: HarnessDeskClaudeAgent
    const app = acpAgent({ name: 'harnessdesk-claude-acp' })
      .onRequest(methods.agent.initialize, (ctx) => agent.initialize(ctx.params))
      .onRequest(methods.agent.session.new, (ctx) => agent.newSession(ctx.params))
      .onRequest(methods.agent.session.load, (ctx) => agent.loadSession(ctx.params))
      .onRequest(methods.agent.session.fork, (ctx) => agent.unstable_forkSession(ctx.params))
      .onRequest(methods.agent.session.list, (ctx) => agent.listSessions(ctx.params))
      .onRequest(methods.agent.session.delete, (ctx) => agent.deleteSession(ctx.params))
      .onRequest(methods.agent.session.resume, (ctx) => agent.resumeSession(ctx.params))
      .onRequest(methods.agent.session.close, (ctx) => agent.closeSession(ctx.params))
      .onRequest(methods.agent.session.setMode, (ctx) => agent.setSessionMode(ctx.params))
      .onRequest(methods.agent.session.setConfigOption, (ctx) => agent.setSessionConfigOption(ctx.params))
      .onRequest(methods.agent.authenticate, (ctx) => agent.authenticate(ctx.params))
      .onRequest(methods.agent.providers.list, (ctx) => agent.unstable_listProviders(ctx.params))
      .onRequest(methods.agent.providers.set, (ctx) => agent.unstable_setProvider(ctx.params))
      .onRequest(methods.agent.providers.disable, (ctx) => agent.unstable_disableProvider(ctx.params))
      .onRequest(methods.agent.logout, (ctx) => agent.logout(ctx.params))
      .onRequest(methods.agent.session.prompt, (ctx) => agent.prompt(ctx.params))
      .onRequest(SESSION_DELETE, (params: unknown) => params as Record<string, unknown>, (ctx) => agent.extMethod(SESSION_DELETE, ctx.params))
      .onRequest(TASKS_LIST, (params: unknown) => params as Record<string, unknown>, (ctx) => agent.extMethod(TASKS_LIST, ctx.params))
      .onRequest(TASKS_STOP, (params: unknown) => params as Record<string, unknown>, (ctx) => agent.extMethod(TASKS_STOP, ctx.params))
      .onRequest(TASKS_CLEAR, (params: unknown) => params as Record<string, unknown>, (ctx) => agent.extMethod(TASKS_CLEAR, ctx.params))
      .onRequest(DELEGATION_LIST, (params: unknown) => params as Record<string, unknown>, (ctx) => agent.extMethod(DELEGATION_LIST, ctx.params))
      .onRequest(ATTACHMENT_RECEIPT, (params: unknown) => params as Record<string, unknown>, (ctx) => agent.extMethod(ATTACHMENT_RECEIPT, ctx.params))
      .onNotification(methods.agent.session.cancel, (ctx) => agent.cancel(ctx.params))
      .connect(stream)
    agent = new HarnessDeskClaudeAgent(clientFromContext(app.client), options)
  }
  #readControls(sessionId: string): Record<string, string> {
    try {
      const value = JSON.parse(readFileSync(join(this.#stateDir, 'options.json'), 'utf8')) as unknown
      const entry = value && typeof value === 'object' ? (value as Record<string, unknown>)[sessionId] : undefined
      return typeof entry === 'object' && entry !== null ? { ...(entry as Record<string, string>) } : {}
    } catch {
      try {
        const value = JSON.parse(readFileSync(join(this.#stateDir, 'efforts.json'), 'utf8')) as unknown
        const entry = value && typeof value === 'object' ? (value as Record<string, unknown>)[sessionId] : undefined
        return typeof entry === 'object' && entry !== null ? { ...(entry as Record<string, string>) } : {}
      } catch { return {} }
    }
  }
  #writeControls(sessionId: string, values: Record<string, string>): void {
    try {
      const path = join(this.#stateDir, 'options.json')
      let all: Record<string, Record<string, string>> = {}
      try { all = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, string>> } catch { all = {} }
      if (Object.keys(values).length === 0) delete all[sessionId]
      else all[sessionId] = values
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(all, null, 2))
      if (values.effort) writeFileSync(join(this.#stateDir, 'efforts.json'), JSON.stringify({ [sessionId]: { effort: values.effort } }, null, 2))
    } catch (error) { this.#log(`claude-acp: could not persist options: ${error instanceof Error ? error.message : String(error)}`) }
  }
}
