import type { ConfigOption, RuntimeInfo, Session, SessionId } from '@harnessdesk/protocol'
import { runtimeId, sessionKey } from '@harnessdesk/protocol'
import type { ReactNode } from 'react'

import { AgentControl, ModeControl, ModelControl, MoreControl, PermissionControl, PlaceControl } from '../components/ComposerControls'
import { ContextUsage } from '../components/ContextUsage'
import { ModelMark, RuntimeMark } from '../components/BrandIcons'
import {
  AlertIcon,
  ChevronIcon,
  LocalIcon,
  ModelIcon,
  PlanIcon,
  PlusIcon,
  SendIcon,
  ShieldAlertIcon,
  ShieldOffIcon,
  ShieldIcon,
  SlidersIcon,
  ZapIcon,
} from '../components/Icons'
import { ComposerGap, ComposerSend, ComposerShell, ComposerTools, Popover, ProgressRing, Text, Button } from '../design'
import { StoreProvider } from '../state/context'
import { Slot } from '../slots/registry'
import { brandForRuntime } from '../lib/brands'
import { selectedChoice } from '../lib/options'
import { previewStore, runtime } from './harness'

type Shape = 'codex' | 'claude' | 'cursor' | 'acp'

const select = (id: string, label: string, category: string, currentValue: string, choices: readonly { value: string; label: string; risk?: 'elevated' | 'high' }[]): ConfigOption => ({
  id,
  type: 'select',
  label,
  category,
  currentValue,
  choices,
} as ConfigOption)

const bool = (id: string, label: string, currentValue: boolean, category?: string): ConfigOption => ({
  id,
  type: 'boolean',
  label,
  ...(category ? { category } : {}),
  currentValue,
} as ConfigOption)

const options: Record<Shape, readonly ConfigOption[]> = {
  codex: [
    select('permissions', 'Permissions', '_permissions', 'workspace', [{ value: 'workspace', label: 'Workspace', risk: 'elevated' }, { value: 'full', label: 'Full access', risk: 'high' }]),
    select('mode', 'Mode', 'mode', 'default', [{ value: 'default', label: 'Default' }, { value: 'plan', label: 'Plan' }]),
    select('model', 'Model', 'model', 'alpha-model', [{ value: 'alpha-model', label: 'Model A' }, { value: 'alpha-model-2', label: 'Model B' }]),
    select('effort', 'Reasoning effort', 'thought_level', 'medium', [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]),
    select('speed', 'Speed', 'other', 'standard', [{ value: 'standard', label: 'Standard' }, { value: 'fast', label: 'Fast' }]),
  ],
  claude: [
    select('mode', 'Mode', 'mode', 'default', [{ value: 'default', label: 'Default' }, { value: 'plan', label: 'Plan' }]),
    select('model', 'Model', 'model', 'beta-model', [{ value: 'beta-model', label: 'Model A' }, { value: 'beta-model-2', label: 'Model B' }]),
    select('effort', 'Reasoning effort', 'thought_level', 'high', [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }]),
    select('auto-compact', 'Auto-compact', 'model_config', 'enabled', [{ value: 'enabled', label: 'On' }, { value: 'disabled', label: 'Off' }]),
  ],
  cursor: [
    select('mode', 'Mode', 'mode', 'default', [{ value: 'default', label: 'Agent' }, { value: 'plan', label: 'Plan' }]),
    select('model', 'Model', 'model', 'gamma-model', [{ value: 'gamma-model', label: 'Model A' }, { value: 'gamma-model-2', label: 'Model B' }]),
    select('sandbox', 'Sandbox', 'other', 'default', [{ value: 'default', label: 'Default' }, { value: 'enabled', label: 'On' }]),
  ],
  acp: [
    select('permissions', 'Permissions', '_permissions', 'ask', [{ value: 'ask', label: 'Ask first' }, { value: 'allow', label: 'Allow' }]),
    select('mode', 'Mode', 'mode', 'chatty', [{ value: 'chatty', label: 'Chatty' }, { value: 'terse', label: 'Terse' }]),
    select('model', 'Model', 'model', 'small', [{ value: 'small', label: 'Small' }, { value: 'large', label: 'Large' }]),
    select('ponder', 'Pondering', 'thought_level', 'default', [{ value: 'default', label: 'Default' }, { value: 'brief', label: 'Brief' }, { value: 'long', label: 'Long' }]),
    select('voice', 'Voice', 'other', 'plain', [{ value: 'plain', label: 'Plain' }, { value: 'pirate', label: 'Pirate' }]),
    bool('verbose', 'Verbose', false, 'other'),
  ],
}

const SHAPES: readonly { shape: Shape; id: string; name: string }[] = [
  { shape: 'codex', id: 'alpha', name: 'Alpha' },
  { shape: 'claude', id: 'beta', name: 'Beta' },
  { shape: 'cursor', id: 'gamma', name: 'Gamma' },
  { shape: 'acp', id: 'delta', name: 'Delta' },
]

const runtimes = SHAPES.map(({ id, name }) => ({
  ...runtime(id, name),
  presentation: { name },
} as RuntimeInfo))

const usage = {
  total: { totalTokens: 12_000, inputTokens: 9_000, cachedInputTokens: 2_000 },
  last: { totalTokens: 2_000, inputTokens: 1_600, cachedInputTokens: 300 },
  contextUsed: 8_000,
  contextWindow: 64_000,
}

const liveStore = (shape: Shape) => {
  const entry = SHAPES.find((candidate) => candidate.shape === shape)!
  const key = sessionKey(runtimeId(entry.id), `slot-${entry.id}` as SessionId)
  const session = {
    id: `slot-${entry.id}`,
    runtime: runtimeId(entry.id),
    status: { type: 'idle' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    turns: [],
    options: options[shape],
    ...(shape === 'cursor' ? {} : { usage }),
  } as unknown as Session
  return previewStore({
    runtimes,
    activeRuntime: runtimeId(entry.id),
    sessions: new Map([[key, session]]),
    activeSessionKey: key,
  })
}

const draftStore = previewStore({
  runtimes,
  activeRuntime: runtimeId('alpha'),
  draftOptions: options.codex,
  workspace: { path: '/work/project' } as never,
})

const Frame = ({ children }: { children: ReactNode }) => (
  <section className="min-w-0">
    <h2 data-preview-caption="" className="mb-2 text-sm font-semibold text-muted-foreground">Composer slots — today and proposed</h2>
    <div className="overflow-hidden rounded-lg border bg-background p-4">
      <div className="grid gap-2">{children}</div>
    </div>
  </section>
)

const Caption = ({ children }: { children: string }) => <Text role="meta" as="div" className="mb-1">{children}</Text>

const currentLabel = (option: ConfigOption | undefined): string | null => {
  if (!option) return null
  return option.type === 'select' ? selectedChoice(option)?.label ?? option.currentValue : option.label
}

const optionsFor = (shape: Shape, category: string): ConfigOption[] =>
  options[shape].filter((option) => option.category === category)

const permissionGlyph = (shape: Shape): ReactNode => {
  const risk = optionsFor(shape, '_permissions')
    .map((option) => option.type === 'select' ? selectedChoice(option)?.risk : undefined)
    .find((value) => value === 'high' || value === 'elevated')
  return risk === 'high' ? <ShieldOffIcon size={13} /> : risk === 'elevated' ? <ShieldAlertIcon size={13} /> : <ShieldIcon size={13} />
}

const modeGlyph = (shape: Shape): ReactNode => {
  const option = optionsFor(shape, 'mode')[0]
  const choice = option?.type === 'select' ? selectedChoice(option) : undefined
  return choice && /plan/i.test(`${choice.value} ${choice.label}`) ? <PlanIcon size={13} /> : <ZapIcon size={13} />
}

const modelLabels = (shape: Shape): { name: string | null; effort: string | null; all: string } => {
  const model = optionsFor(shape, 'model')[0]
  const effort = optionsFor(shape, 'thought_level')[0]
  const name = currentLabel(model)
  const reasoning = currentLabel(effort)
  return { name, effort: reasoning, all: [name, reasoning].filter(Boolean).join(' ') }
}

const EmptyUsageRing = () => (
  <Popover title="No usage yet" drop="up" align="right" label={<ProgressRing value={null} size={16} label="No usage yet" />}>
    {() => null}
  </Popover>
)

const Today = ({ shape, caption, draft = false }: { shape: Shape; caption: string; draft?: boolean }) => {
  const own = draft ? draftStore : liveStore(shape)
  return (
    <div className="min-w-0">
      <Caption>{caption}</Caption>
      <StoreProvider store={own}>
        <ComposerShell className="mx-auto w-full max-w-(--hd-column)">
          <ComposerTools>
            <Popover title="Add" drop="up" align="left" label={<PlusIcon size={14} />}>
              {() => null}
            </Popover>
            <PlaceControl />
            <AgentControl />
            <PermissionControl />
            <ModeControl />
            <Slot name="composer.action" />
            <ComposerGap />
            <MoreControl />
            <ContextUsage />
            {(draft || shape === 'cursor') && <EmptyUsageRing />}
            <ModelControl />
            <ComposerSend aria-label="Send" title="Send"><SendIcon size={15} /></ComposerSend>
          </ComposerTools>
        </ComposerShell>
      </StoreProvider>
    </div>
  )
}

const Chevron = () => <ChevronIcon size={11} style={{ transform: 'rotate(90deg)' }} />

const MockControl = ({
  title,
  label,
  icon,
  disabledReason,
  warning,
  track,
  tone = 'calm',
  slot,
  end = false,
}: {
  title: string
  label: ReactNode
  icon: ReactNode
  disabledReason?: string
  warning?: string
  track?: boolean
  tone?: 'calm' | 'warn' | 'alert'
  /** The slot's fixed track: the control sits inside it, so a shorter or missing label moves nothing. */
  slot?: string
  end?: boolean
}) => (
  <div className={`flex min-w-0 shrink-0 ${slot ?? ''} ${end ? 'justify-end' : 'justify-start'}`}>{disabledReason ? (
    <Button variant="ghost" size="sm" disabled title={disabledReason} aria-label={`${title}: ${disabledReason}`}>
      {icon}<span className={track ? 'max-w-40 truncate' : undefined}>{label}</span><Chevron />
    </Button>
  ) : (
    <Popover title={warning ?? title} drop="up" tone={warning ? 'warn' : tone} label={<>{icon}{warning && <span title={warning}><AlertIcon size={11} /></span>}{<span className={track ? 'max-w-40 truncate' : undefined}>{label}</span>}<Chevron /></>}>
      {() => null}
    </Popover>
  )}</div>
)

const Proposed = ({
  caption,
  shape,
  draft = false,
  modelRemoved = false,
  staleMode = false,
}: {
  caption: string
  shape: Shape
  draft?: boolean
  modelRemoved?: boolean
  staleMode?: boolean
}) => {
  const own = draft ? draftStore : liveStore(shape)
  const permissionOptions = optionsFor(shape, '_permissions')
  const hasPermission = permissionOptions.length > 0
  const permissionLabel = currentLabel(permissionOptions[0])
  const modeOption = optionsFor(shape, 'mode')[0]
  const modelOption = optionsFor(shape, 'model')[0]
  const hasMode = Boolean(modeOption)
  const hasModel = Boolean(modelOption)
  // The proposed category map sends Claude's model_config option to More.
  const hasOther = optionsFor(shape, 'other').length > 0 || optionsFor(shape, 'model_config').length > 0
  const model = modelLabels(shape)
  const staleReason = 'Saved mode "Plan" is no longer offered; it will not be sent.'
  return (
    <div className="min-w-0">
      <Caption>{caption}</Caption>
      <StoreProvider store={own}>
      <ComposerShell className="mx-auto w-full max-w-(--hd-column)">
        <ComposerTools className="min-w-0">
          <div className="flex min-w-0 shrink items-center gap-1.5">
            <Popover title="Add" drop="up" align="left" label={<PlusIcon size={14} />}>{() => null}</Popover>
            {draft && <Popover title="Starts in project" drop="up" align="left" label={<><LocalIcon size={13} /><Text role="row">Local</Text><Chevron /></>}>{() => null}</Popover>}
            <MockControl title={draft ? 'Which agent starts this conversation' : `This conversation is with ${SHAPES.find((candidate) => candidate.shape === shape)!.name}`} label={SHAPES.find((candidate) => candidate.shape === shape)!.name} icon={<RuntimeMark runtime={runtimes.find((entry) => entry.id === runtimeId(SHAPES.find((candidate) => candidate.shape === shape)!.id))!} size={13} />} track slot="w-24" />
            <MockControl title="What the agent may do" label={permissionLabel ?? 'Permissions'} icon={permissionGlyph(shape)} disabledReason={!hasPermission ? 'This agent has no permission setting' : undefined} slot="w-32" tone={permissionOptions.some((option) => option.type === 'select' && selectedChoice(option)?.risk === 'high') ? 'alert' : permissionOptions.some((option) => option.type === 'select' && selectedChoice(option)?.risk === 'elevated') ? 'warn' : 'calm'} />
            <MockControl title="Mode" label={currentLabel(modeOption) ?? 'Mode'} icon={modeGlyph(shape)} disabledReason={!hasMode ? 'This agent has no mode setting' : undefined} warning={staleMode ? staleReason : undefined} track slot="w-28" />
          </div>
          <span className="min-w-0 flex-1" />
          <div className="flex min-w-0 shrink items-center gap-1.5">
            {hasOther && <MockControl title="More options" label="More" icon={<SlidersIcon size={13} />} slot="w-20" end />}
            <ContextUsage />
            {(draft || shape === 'cursor') && <EmptyUsageRing />}
            <MockControl title={modelRemoved ? 'Unavailable' : 'Model and reasoning'} label={<span className="inline-flex items-baseline gap-1"><Text role="row">{model.name}</Text>{model.effort && <Text ink="muted">{model.effort}</Text>}</span>} icon={modelOption?.type === 'select' && selectedChoice(modelOption) ? <ModelMark model={`${selectedChoice(modelOption)?.value ?? ''} ${currentLabel(modelOption) ?? ''}`} agent={brandForRuntime(runtimes.find((entry) => entry.id === runtimeId(SHAPES.find((candidate) => candidate.shape === shape)!.id))!)} size={13} /> : <ModelIcon size={13} />} disabledReason={!hasModel ? 'This agent has no model setting' : undefined} warning={modelRemoved ? 'Unavailable — current model is no longer offered.' : undefined} track slot="w-44" end />
            <ComposerSend aria-label="Send" title="Send"><SendIcon size={15} /></ComposerSend>
          </div>
        </ComposerTools>
      </ComposerShell>
      </StoreProvider>
    </div>
  )
}

export const ComposerSlotFrames = () => (
  <Frame>
    {SHAPES.map(({ shape, name }) => (
      <div key={shape} className="grid gap-2">
        <Today shape={shape} caption={`${name} — today`} />
        <Proposed shape={shape} caption={`${name} — proposed`} />
      </div>
    ))}
    <div className="grid gap-2">
      <Today shape="acp" caption="Delta — today" />
      <Proposed shape="acp" caption="Delta — proposed (current model removed)" modelRemoved />
    </div>
    <div className="grid gap-2">
      <Today shape="codex" caption="Alpha — today" />
      <Proposed shape="codex" caption="Alpha — proposed (a saved mode is no longer offered)" staleMode />
    </div>
  </Frame>
)
