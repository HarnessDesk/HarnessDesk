import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ConfigOption, OptionChoice, RuntimeId, RuntimeInfo, SelectOption } from '@harnessdesk/protocol'
import { optionsIn } from '@harnessdesk/protocol'

import { Btn, Dialog } from '../design'
import { Badge } from '../design/ui/badge'
import { runtimeLabel } from '../lib/accounts'
import { CARRY_OPTIONS, type Carry } from '../lib/handoff'
import { worktreeBranch } from '../lib/worktree-branch'
import { type Brand, brandForRuntime } from '../lib/brands'
import { brandOf } from '../lib/identity'
import { describesEveryChoice, riskTone, selectedChoice } from '../lib/options'
import { matchPreset, presetsFor } from '../state/presets'
import { describeChecked, describeUpdate, describeVersion } from '../lib/versions'
import { useActiveSession, useRuntime, useSnapshot, useStore } from '../state/context'
import {
  AlertIcon,
  BrainIcon,
  BranchIcon,
  ChevronIcon,
  DiffIcon,
  HandoffIcon,
  LocalIcon,
  EffortHighIcon,
  EffortLowIcon,
  EffortMaxIcon,
  EffortMediumIcon,
  ModelIcon,
  NewWorktreeIcon,
  PlanIcon,
  PresetIcon,
  RetryIcon,
  RouteIcon,
  ShieldAlertIcon,
  ShieldIcon,
  ShieldOffIcon,
  SlidersIcon,
  SummaryIcon,
  TranscriptIcon,
  ZapIcon,
} from './Icons'
import { ModelMark, RuntimeMark } from './BrandIcons'
import { Menu, MenuItem, MenuLabel, MenuNote, MenuSeparator, MenuToggle, Submenu } from './Menu'
import { useOptionConfirm } from './OptionConfirm'
import { Popover, popoverStyles as styles } from './Popover'
import sheet from './ComposerControls.module.css'

/**
 * The controls that live in the composer.
 *
 * Placed here rather than in the header because they are decisions about the
 * message you are about to send: which model reads it, how hard it thinks, and
 * what it may do in response. Codex's own clients and DeepSeek Harness both put
 * them here, and being consistent with the tools people already use matters more
 * than any argument for the header.
 *
 * None of them knows what a control *is*. The runtime declares its options
 * with a category, and the category decides which popover draws it: `model`
 * and `thought_level` together, `_permissions` together with presets, `mode`
 * on its own, and everything else under "More". A control the interface has
 * never heard of lands in "More" with a working menu.
 */

const Chevron = () => <ChevronIcon size={11} style={{ transform: 'rotate(90deg)' }} />

/**
 * Below this toolbar width the controls keep their glyph and drop their
 * words. Five labelled controls and a send button need about 560px; the
 * window can go to 720 with the sidebar open, and a control whose icon says
 * what it is — a shield, a chip — can afford to be quiet there. The full
 * label stays in the trigger's title, and in the menu.
 */
const NARROW_TOOLBAR = 560

/**
 * Whether the toolbar this control sits in is narrow. The control renders a
 * layout-less wrapper so it can find its toolbar without the toolbar having
 * to know about it. A callback ref, because a control often mounts as
 * nothing — its options arrive after the runtime does — and starts watching
 * only once it has drawn something.
 */
const useNarrowToolbar = (): { ref: (node: HTMLSpanElement | null) => void; narrow: boolean } => {
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null)
  const ref = useCallback((node: HTMLSpanElement | null) => setToolbar(node?.parentElement ?? null), [])
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    if (!toolbar || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < NARROW_TOOLBAR)
    })
    observer.observe(toolbar)
    return () => observer.disconnect()
  }, [toolbar])
  return { ref, narrow }
}

/** A control's wrapper: no box of its own, just a way to reach the toolbar. */
const InToolbar = ({ refer, children }: { refer: (node: HTMLSpanElement | null) => void; children: ReactNode }) => (
  <span ref={refer} style={{ display: 'contents' }}>
    {children}
  </span>
)

/**
 * The option list the composer's controls act on: the live session's, or —
 * before any session exists — the runtime's draft list for the next one.
 * `store.setOption` routes to the matching side, so the controls themselves
 * cannot tell the difference, which is the point.
 */
const useComposerOptions = (): readonly ConfigOption[] | undefined => {
  const session = useActiveSession()
  const snapshot = useSnapshot()
  if (session) return session.options
  return snapshot.draftOptions ?? undefined
}

/**
 * The glyph for a choice, read off what the protocol says about it. A
 * permission's risk picks its shield; a mode is either a plan or a go. A
 * choice the interface cannot place gets none, and the trailing check still
 * says which one is on.
 */
const choiceIcon = (option: ConfigOption, choice: OptionChoice, agent: Brand | null = null): ReactNode => {
  if (option.category === '_permissions') {
    return choice.risk === 'high' ? (
      <ShieldOffIcon size={14} />
    ) : choice.risk === 'elevated' ? (
      <ShieldAlertIcon size={14} />
    ) : (
      <ShieldIcon size={14} />
    )
  }
  if (option.category === 'mode') {
    return /plan/i.test(choice.value) || /plan/i.test(choice.label) ? <PlanIcon size={14} /> : <ZapIcon size={14} />
  }
  // A model wears its maker's mark — Claude's, say, even when Cursor offers it.
  if (option.category === 'model') return <ModelMark model={`${choice.value} ${choice.label}`} agent={agent} size={14} />
  if (option.category === 'thought_level') {
    const word = `${choice.value} ${choice.label}`.toLowerCase()
    if (/max|ultra|xhigh|extreme/.test(word)) return <EffortMaxIcon size={14} />
    if (/high|deep/.test(word)) return <EffortHighIcon size={14} />
    if (/med|mid|standard|default|balanced/.test(word)) return <EffortMediumIcon size={14} />
    if (/low|min|fast|light|quick/.test(word)) return <EffortLowIcon size={14} />
  }
  return undefined
}

/** A control's trigger glyph: the shield in the colour of the current risk. */
const shieldFor = (tone: ReturnType<typeof riskTone>): ReactNode =>
  tone === 'alert' ? <ShieldOffIcon size={13} /> : tone === 'warn' ? <ShieldAlertIcon size={13} /> : <ShieldIcon size={13} />

/**
 * A choice's label, with the warning mark when picking it widens what the
 * agent may do — unless the row's own glyph already says so.
 */
const choiceLabel = (option: ConfigOption, choice: OptionChoice) => (
  <>
    {choice.label}
    {choice.risk === 'high' && choiceIcon(option, choice) === undefined && (
      <AlertIcon size={11} style={{ marginLeft: 2, verticalAlign: -1 }} />
    )}
  </>
)

/**
 * One select's choices, as radio rows. A disabled choice still lists so the
 * reason can be read; it just refuses clicks. Choices that declare a
 * `group` are listed under it.
 */
const ChoiceRows = ({
  option,
  choices = option.choices,
}: {
  option: SelectOption
  choices?: readonly OptionChoice[]
}) => {
  const store = useStore()
  const agent = brandForRuntime(useRuntime())
  const column = describesEveryChoice(option)
  const groups = new Map<string | undefined, OptionChoice[]>()
  for (const choice of choices) {
    const list = groups.get(choice.group) ?? []
    list.push(choice)
    groups.set(choice.group, list)
  }
  return (
    <>
      {[...groups.entries()].map(([group, list]) => (
        <div key={group ?? ''}>
          {group && <MenuLabel>{group}</MenuLabel>}
          {list.map((choice) => (
            <MenuItem
              key={choice.value}
              icon={choiceIcon(option, choice, agent)}
              selected={choice.value === option.currentValue}
              label={choiceLabel(option, choice)}
              {...(column && choice.description ? { hint: choice.description } : {})}
              {...(choice.description ? { title: choice.description } : {})}
              disabled={option.disabled || choice.disabled}
              onSelect={() => void store.setOption(option.id, choice.value)}
            />
          ))}
        </div>
      ))}
    </>
  )
}

/** One option, whole: its heading, its reason when refused, and its rows. */
const OptionRows = ({ option }: { option: ConfigOption }) => {
  const store = useStore()
  const { ask, dialog } = useOptionConfirm()
  return (
    <>
      {/* A select's heading names what the rows below are choices *of*; a
          switch is its own heading, and printing the label twice reads as a
          stutter. The reason a switch is greyed rides on the row itself. */}
      {option.type === 'boolean' ? (
        <MenuToggle
          label={option.label}
          hint={option.disabled ?? option.description}
          checked={option.currentValue}
          disabled={option.disabled}
          onChange={(next) => ask(option, next, () => void store.setOption(option.id, next))}
        />
      ) : (
        <>
          <MenuLabel>{option.label}</MenuLabel>
          {option.disabled && <MenuNote>{option.disabled}</MenuNote>}
          <ChoiceRows option={option} />
        </>
      )}
      {dialog}
    </>
  )
}

/**
 * A select with a type-ahead when the list is long. Sixty model rows are a
 * scroll hunt; three typed letters are not. The input also gives stray
 * keystrokes somewhere harmless to land while the menu is open, and Enter
 * picks the top match.
 */
const FilterableChoices = ({ option, close }: { option: SelectOption; close: () => void }) => {
  const store = useStore()
  const [query, setQuery] = useState('')
  if (option.choices.length <= 8) return <ChoiceRows option={option} />
  const needle = query.trim().toLowerCase()
  const filtered = needle
    ? option.choices.filter(
        (choice) =>
          choice.label.toLowerCase().includes(needle) || choice.value.toLowerCase().includes(needle),
      )
    : option.choices
  return (
    <>
      <input
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        className={styles.filterInput}
        placeholder={`Type to filter ${option.choices.length} choices…`}
        value={query}
        spellCheck={false}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          const first = filtered.find((choice) => !choice.disabled)
          if (first) {
            void store.setOption(option.id, first.value)
            close()
          }
        }}
      />
      {filtered.length === 0 ? (
        <MenuNote>Nothing matches “{query}”.</MenuNote>
      ) : (
        <ChoiceRows option={option} choices={filtered} />
      )}
    </>
  )
}

const currentLabel = (option: SelectOption): string =>
  selectedChoice(option)?.label ?? option.currentValue

/** Permissions and approvals, plus saved presets that set several at once. */
export const PermissionControl = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  const { ref, narrow } = useNarrowToolbar()
  const all = useComposerOptions()
  const options = optionsIn(all, '_permissions')
  if (options.length === 0) return null

  const presets = presetsFor(snapshot.activeRuntime, snapshot.customPresets)
  const preset = matchPreset(snapshot.activeRuntime ?? '', all, presets)
  const tone = riskTone(options)
  const first = options[0]
  const current = first?.type === 'select' ? currentLabel(first) : first?.label

  return (
    <InToolbar refer={ref}>
      <Popover
        title={narrow && current ? `${current} — what the agent may do` : 'What the agent may do'}
        drop="up"
        align="left"
        tone={tone}
        label={
          <>
            {shieldFor(tone)}
            {!narrow && current}
            <Chevron />
          </>
        }
      >
        {(close) => (
          <Menu close={close}>
            {presets.length > 0 && (
              <>
                <MenuLabel>Preset</MenuLabel>
                {presets.map((entry) => (
                  <MenuItem
                    key={entry.id}
                    icon={<PresetIcon size={14} />}
                    selected={entry.id === preset?.id}
                    label={entry.name}
                    hint={entry.description}
                    onSelect={() => void store.applyPreset(entry)}
                  />
                ))}
              </>
            )}
            {options.map((option) => (
              <OptionRows key={option.id} option={option} />
            ))}
          </Menu>
        )}
      </Popover>
    </InToolbar>
  )
}

/**
 * How many models sit on the first level before the rest fold into "More
 * models" — and the fold only happens when it hides at least two, since a
 * submenu holding one row is longer than the row.
 */
const FEATURED_MODELS = 4
const FOLD_FROM = FEATURED_MODELS + 2

/**
 * Model and reasoning in one control, on more than one level.
 *
 * The first level is the short list — the handful of models most turns
 * use, each with the line its runtime wrote about it — and the current one
 * is always among them, even when it lives in the long tail. Below a line,
 * one row per way the runtime lets the model think harder: a select opens
 * beside the menu with its choices, a switch flips in place. The long tail
 * of models, and the model routes a draft may start on, each open beside
 * the menu too. Three questions, one place, no level more than a hover away.
 *
 * Every row is declared by the runtime: a model list with no effort makes a
 * menu with no effort row, not a greyed one. Nothing here names a vendor.
 */
export const ModelControl = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  const { ref, narrow } = useNarrowToolbar()
  const session = useActiveSession()
  const agent = brandForRuntime(useRuntime())
  const all = useComposerOptions()
  const { ask, dialog } = useOptionConfirm()
  const runtime = useRuntime()?.id
  const models = optionsIn(all, 'model')
  const levels = optionsIn(all, 'thought_level')
  // The picker offers what Settings left in it. The model a session is
  // already on is never hidden from its own control — a row you cannot see
  // is a setting you cannot read back.
  const hidden = runtime ? (snapshot.hiddenModels[runtime] ?? []) : []
  const first = models[0]
  const model =
    first && first.type === 'select' && hidden.length > 0
      ? {
          ...first,
          choices: first.choices.filter(
            (choice) => !hidden.includes(choice.value) || choice.value === first.currentValue,
          ),
        }
      : first
  if (!model) return null
  const levelSelects = levels.filter((option): option is SelectOption => option.type === 'select')
  const levelToggles = levels.filter((option) => option.type === 'boolean')
  const firstLevel = levelSelects[0]

  // Routes are a start-time decision: they appear before a session exists and
  // ride `session/create`; a live session keeps whatever it started on.
  const routes = !session ? snapshot.routes : []
  const activeRoute = snapshot.routes.find((route) => route.id === snapshot.draftRouteId)

  // The short list: the first few the runtime offers, plus the current one.
  const featured: OptionChoice[] = []
  const rest: OptionChoice[] = []
  if (model.type === 'select') {
    const current = selectedChoice(model)
    const fold = model.choices.length >= FOLD_FROM
    const lead = fold ? model.choices.slice(0, FEATURED_MODELS) : [...model.choices]
    if (fold && current && !lead.includes(current)) lead.pop()
    for (const choice of model.choices) {
      const isLead = lead.includes(choice) || choice === current
      ;(isLead ? featured : rest).push(choice)
    }
  }

  return (
    <InToolbar refer={ref}>
      {dialog}
      <Popover
        title="Model and reasoning"
        drop="up"
        label={
          <>
            {!session && activeRoute ? (
              <RouteIcon size={13} />
            ) : model.type === 'select' && selectedChoice(model) ? (
              <ModelMark
                model={`${selectedChoice(model)?.value ?? ''} ${currentLabel(model)}`}
                agent={agent}
                size={13}
              />
            ) : (
              <ModelIcon size={13} />
            )}
            <span className={styles.strong}>
              {!session && activeRoute
                ? activeRoute.name
                : model.type === 'select'
                  ? currentLabel(model)
                  : model.label}
            </span>
            {firstLevel && !activeRoute && !narrow && <span className={styles.dim}>{currentLabel(firstLevel)}</span>}
            <Chevron />
          </>
        }
      >
        {(close) => (
          <Menu close={close}>
            {model.type === 'select' ? (
              <>
                {model.disabled && <MenuNote>{model.disabled}</MenuNote>}
                {/* What the runtime wants said about this list — a configured
                    model it cannot serve, say — sits above the list it explains. */}
                {!model.disabled && model.description && <MenuNote>{model.description}</MenuNote>}
                <ChoiceRows option={model} choices={featured} />
              </>
            ) : (
              <OptionRows option={model} />
            )}
            {/* Other model selects a runtime might declare — rare, but declared is declared. */}
            {models.slice(1).map((option) => (
              <OptionRows key={option.id} option={option} />
            ))}

            {(levels.length > 0 || rest.length > 0 || routes.length > 0) && <MenuSeparator />}

            {levelSelects.map((option, index) => (
              <Submenu
                key={option.id}
                icon={<BrainIcon size={14} />}
                label={option.label}
                value={currentLabel(option)}
                disabled={option.disabled}
                width={280}
              >
                {option.description && <MenuNote>{option.description}</MenuNote>}
                <ChoiceRows option={option} />
                {/* Switches about thinking ride with the first effort select. */}
                {index === 0 && levelToggles.length > 0 && <MenuSeparator />}
                {index === 0 &&
                  levelToggles.map((toggle) =>
                    toggle.type === 'boolean' ? (
                      <MenuToggle
                        key={toggle.id}
                        label={toggle.label}
                        hint={toggle.description}
                        checked={toggle.currentValue}
                        disabled={toggle.disabled}
                        onChange={(next) =>
                          ask(toggle, next, () => void store.setOption(toggle.id, next))
                        }
                      />
                    ) : null,
                  )}
              </Submenu>
            ))}
            {levelSelects.length === 0 &&
              levelToggles.map((toggle) =>
                toggle.type === 'boolean' ? (
                  <MenuToggle
                    key={toggle.id}
                    label={toggle.label}
                    hint={toggle.description}
                    checked={toggle.currentValue}
                    disabled={toggle.disabled}
                    onChange={(next) => ask(toggle, next, () => void store.setOption(toggle.id, next))}
                  />
                ) : null,
              )}

            {/* Cursor's own picker ends in "Add Models"; this is the same
                door. It is the only honest answer when the model you want is
                not on the list — the list is a setting, not the catalogue. */}
            {runtime && (
              <MenuItem
                icon={<SlidersIcon size={14} />}
                label="Manage models…"
                title="Choose which of this agent's models the picker offers."
                onSelect={() => store.askSettings('models')}
              />
            )}
            {rest.length > 0 && model.type === 'select' && (
              <Submenu icon={<ModelIcon size={14} />} label="More models" value={`${rest.length}`} width={300}>
                <FilterableChoices option={{ ...model, choices: rest }} close={close} />
              </Submenu>
            )}

            {routes.length > 0 && (
              <Submenu
                icon={<RouteIcon size={14} />}
                label="Model route"
                value={activeRoute ? activeRoute.name : 'Direct'}
                width={300}
              >
                <MenuItem
                  selected={snapshot.draftRouteId === null}
                  label="Direct"
                  hint="The backend's own provider and account."
                  onSelect={() => store.setDraftRoute(null)}
                />
                {routes.map((route) => (
                  <MenuItem
                    key={route.id}
                    selected={snapshot.draftRouteId === route.id}
                    label={route.name}
                    hint={route.usable === false ? route.reason : route.endpoint}
                    disabled={route.usable === false ? route.reason : false}
                    onSelect={() => store.setDraftRoute(route.id)}
                  />
                ))}
                <MenuNote>
                  On another provider the agent loses web search, subagent fan-out and
                  reasoning display, and its system prompt is tuned for its own models.
                  Expect rougher results.
                </MenuNote>
              </Submenu>
            )}

            <RuntimeBuildNote />
          </Menu>
        )}
      </Popover>
    </InToolbar>
  )
}

/**
 * Which build this list came from, at the foot of the menu — and, when a
 * newer one is published, the fact and the command. The list is whatever the
 * running agent declared; a model that is "missing" is nearly always an agent
 * that is behind, and this is the one place a person looks when they notice.
 */
const RuntimeBuildNote = () => {
  const store = useStore()
  const refreshing = useSnapshot().catalogRefreshing
  const runtime = useRuntime()
  const version = describeVersion(runtime)
  const checked = describeChecked(runtime)
  const update = describeUpdate(runtime)
  if (!version && !update) return null
  return (
    <>
      <MenuSeparator />
      <MenuItem
        icon={<RetryIcon size={14} />}
        label={refreshing ? 'Refreshing models…' : 'Refresh models'}
        title="Ask the agent again what it offers; picks up models added since."
        disabled={refreshing}
        onSelect={() => void store.refreshCatalog()}
      />
      <MenuNote>
        {version && (
          <div data-testid="runtime-build">
            {version}
            {checked && <span className={styles.dim}> · {checked}</span>}
          </div>
        )}
        {update && (
          <div className={styles.updateNote} data-testid="runtime-update">
            {update.text}
            {update.command && (
              <>
                {' '}
                <code>{update.command}</code>
              </>
            )}
          </div>
        )}
      </MenuNote>
    </>
  )
}

/** The runtime's collaboration modes — plan first, act directly, whatever it offers. */
export const ModeControl = () => {
  const { ref, narrow } = useNarrowToolbar()
  const all = useComposerOptions()
  const modes = optionsIn(all, 'mode')
  const mode = modes[0]
  if (!mode) return null
  const current = mode.type === 'select' ? selectedChoice(mode) : undefined
  const label = mode.type === 'select' ? currentLabel(mode) : mode.label

  return (
    <InToolbar refer={ref}>
      <Popover
        title={narrow ? `${label} — ${mode.description ?? mode.label}` : mode.description ?? mode.label}
        drop="up"
        align="left"
        label={
          <>
            {current ? choiceIcon(mode, current) : <ZapIcon size={13} />}
            {!narrow && label}
            <Chevron />
          </>
        }
      >
        {(close) => (
          <Menu close={close}>
            {modes.map((option) => (
              <OptionRows key={option.id} option={option} />
            ))}
          </Menu>
        )}
      </Popover>
    </InToolbar>
  )
}

/** Everything the runtime declared that has no dedicated place. */
export const MoreControl = () => {
  const { ref, narrow } = useNarrowToolbar()
  const all = useComposerOptions()
  const others = optionsIn(all, 'other')
  if (others.length === 0) return null

  return (
    <InToolbar refer={ref}>
      <Popover
        title="More options"
        drop="up"
        label={
          <>
            <SlidersIcon size={13} />
            {!narrow && 'More'}
            <Chevron />
          </>
        }
      >
        {(close) => (
          <Menu close={close}>
            {others.map((option) => (
              <OptionRows key={option.id} option={option} />
            ))}
          </Menu>
        )}
      </Popover>
    </InToolbar>
  )
}

/**
 * Who reads this message. For a conversation, that is the agent it belongs
 * to — every vendor owns its own threads — and the menu offers to hand the
 * conversation to another agent instead. For a draft, it is the agent the
 * draft will start with, and the menu simply switches it.
 */
export const AgentControl = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  const { ref, narrow } = useNarrowToolbar()
  const session = useActiveSession()
  const [handoff, setHandoff] = useState<RuntimeId | null>(null)
  const ownerId = session ? session.runtime : snapshot.activeRuntime
  const owner = snapshot.runtimes.find((entry) => entry.id === ownerId)
  if (!owner || snapshot.runtimes.length < 2) return null
  const others = snapshot.runtimes.filter((entry) => entry.id !== owner.id)
  const target = handoff ? snapshot.runtimes.find((entry) => entry.id === handoff) ?? null : null
  // Two accounts of one agent are two entries here, and the agent's name
  // names neither on its own — so the account rides along when there is one.
  const label = (entry: RuntimeInfo): string =>
    runtimeLabel(entry, snapshot.runtimes, snapshot.accountsByRuntime, snapshot.accountPrefs)

  return (
    <InToolbar refer={ref}>
      <Popover
        title={session ? `This conversation is with ${owner.presentation.name}` : 'Which agent starts this conversation'}
        drop="up"
        align="left"
        label={
          <>
            <RuntimeMark runtime={owner} size={13} />
            {!narrow && <span className={styles.strong}>{brandOf(owner.presentation.name)}</span>}
            <Chevron />
          </>
        }
      >
        {(close) => (
          <Menu close={close}>
            {session ? (
              <>
                <MenuItem
                  icon={<RuntimeMark runtime={owner} />}
                  selected
                  label={`Reply here with ${owner.presentation.name}`}
                  title="This conversation belongs to it; replies continue it."
                  onSelect={() => undefined}
                />
                {/* What a hand-off does is said once, over the group, rather
                    than repeated under every agent in it: the sentence is the
                    same for all of them, so N copies of it are N times the
                    height and none of the information. */}
                <MenuLabel>Hand off</MenuLabel>
                <MenuNote>Starts a new conversation there with what happened here.</MenuNote>
                {others.map((entry) => (
                  <MenuItem
                    key={entry.id}
                    icon={<RuntimeMark runtime={entry} />}
                    label={`Hand off to ${label(entry)}…`}
                    onSelect={() => setHandoff(entry.id)}
                  />
                ))}
              </>
            ) : (
              <>
                <MenuLabel>Start with</MenuLabel>
                {snapshot.runtimes.map((entry) => {
                  // A dead agent stays selectable — selecting it is how you
                  // reach the screen that says what to fix — but it must not
                  // sit here looking normal.
                  const down = snapshot.healthByRuntime[entry.id]?.state === 'unavailable'
                  return (
                    <MenuItem
                      key={entry.id}
                      icon={<RuntimeMark runtime={entry} />}
                      selected={entry.id === owner.id}
                      label={down ? `${label(entry)} — unavailable` : label(entry)}
                      // A dead agent's state is a consequence and stays on
                      // screen. A tagline is not: these are brand names the
                      // reader arrived knowing, the blurb cannot change which
                      // one they pick, and only some agents declare one — so
                      // on screen it is a ragged menu rather than a column
                      // worth reading. Settings and first-run still show it,
                      // where choosing is the whole task.
                      hint={down ? 'This agent cannot start right now. Selecting it shows what to fix.' : undefined}
                      title={down ? undefined : entry.presentation.tagline}
                      onSelect={() => {
                        if (entry.id !== owner.id) void store.selectRuntime(entry.id)
                      }}
                    />
                  )
                })}
              </>
            )}
          </Menu>
        )}
      </Popover>
      {target && session && (
        <HandoffSheet
          from={owner.presentation.name}
          to={target.presentation.name}
          onCancel={() => setHandoff(null)}
          onConfirm={(carry) => {
            setHandoff(null)
            void store.handOff(target.id, carry)
          }}
        />
      )}
    </InToolbar>
  )
}

/** What to carry across — the one decision a hand-off needs from the user. */
const HandoffSheet = ({
  from,
  to,
  onCancel,
  onConfirm,
}: {
  from: string
  to: string
  onCancel: () => void
  onConfirm: (carry: Carry) => void
}) => {
  const [carry, setCarry] = useState<Carry>('summary')

  return (
    <Dialog
      title={`Hand off to ${to}`}
      icon={<HandoffIcon size={16} />}
      onClose={onCancel}
      footer={
        <>
          <Btn variant="primary" onClick={() => onConfirm(carry)}>
            Hand off to {to}
          </Btn>
          <Btn onClick={onCancel}>Stay here</Btn>
        </>
      }
    >
      <p>
        {to} cannot read {from}'s thread, so HarnessDesk writes what happened into a new
        conversation there. Choose how much travels.
      </p>
      <div className={sheet.choices} role="radiogroup" aria-label="What to carry">
        {CARRY_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={carry === option.id}
            className={sheet.choice}
            {...(carry === option.id ? { 'data-selected': '' } : {})}
            onClick={() => setCarry(option.id)}
          >
            <span className={sheet.choiceMark} aria-hidden="true" />
            <span>
              <div className={sheet.choiceLabel}>
                {option.id === 'summary' ? (
                  <SummaryIcon size={13} />
                ) : option.id === 'transcript' ? (
                  <TranscriptIcon size={13} />
                ) : (
                  <DiffIcon size={13} />
                )}
                {option.label}
              </div>
              <div className={sheet.choiceHint}>{option.hint}</div>
            </span>
          </button>
        ))}
      </div>
    </Dialog>
  )
}

/**
 * Where the conversation being written will run: the open folder, or a
 * worktree of it.
 *
 * Codex and Claude both put this beside the composer, and here it was made
 * invisibly. The header's git control already says where a *session* runs —
 * the branch, the changes, the worktree tag — and says it better than a chip
 * could. What it cannot do is let a draft choose, because until the first
 * message there is no session to be anywhere; the only door to a worktree
 * was a bare glyph in the sidebar that made one the moment it was pressed.
 * So this control exists exactly as long as the choice does: on a draft,
 * never on a conversation.
 *
 * "Local" is the word both apps use and the one a person asks the question
 * in. A folder that is itself a linked worktree is never called that — it
 * wears its branch and a worktree tag, because "Local" on a worktree is the
 * exact confusion this control is here to end. A worktree armed here is
 * drawn in the primary ink: it is something that will happen on send, not a
 * description of a folder, and nothing exists on disk until that message
 * goes.
 *
 * Each place has a glyph of its own — a laptop, a branch, a branch with a
 * plus — because a narrow toolbar keeps the glyph and drops the word, and
 * an armed worktree used to differ from an existing one by colour alone.
 */
export const PlaceControl = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  const session = useActiveSession()
  const { ref, narrow } = useNarrowToolbar()
  const workspace = snapshot.workspace
  if (session || !workspace) return null

  const place = snapshot.draftPlace
  const folder = workspace.path.split('/').filter(Boolean).at(-1) ?? workspace.path
  const branch = workspace.git?.branch ?? null
  const linked = workspace.repo?.worktree === true
  const armed = place?.kind === 'worktree' ? place : null
  const chosen = place?.kind === 'existing' ? place : null
  const armedBranch = armed ? worktreeBranch(armed.name) : null
  // HarnessDesk's own worktrees of this project, the ones a conversation is
  // started in from here and from the sidebar alike. The folder already open
  // is the first row, not one of these.
  const others = snapshot.worktrees.filter((entry) => entry.managed && entry.path !== workspace.path)

  const title = armed
    ? `Starts in a new worktree on ${armedBranch}, made when you send`
    : chosen
      ? `Starts in the worktree on ${chosen.branch ?? 'a detached HEAD'}`
      : linked
        ? `Starts in this worktree${branch ? `, on ${branch}` : ''}`
        : `Starts in ${folder}${branch ? `, on ${branch}` : ''}`
  // A branch by its last segment: the prefix is a namespace a person's
  // worktrees share (`claude/…`, `harnessdesk/…`) and the end is what tells
  // them apart. Written whole, a long one squeezed the agent and the model
  // off the row, and the ellipsis cut the very end that differs. The whole
  // name is on hover and in the menu.
  const leaf = (name: string | null): string => name?.split('/').filter(Boolean).at(-1) ?? 'Worktree'
  const word = armed ? 'New worktree' : chosen ? leaf(chosen.branch) : linked ? leaf(branch) : 'Local'
  const tagged = !armed && (chosen !== null || linked)

  return (
    <InToolbar refer={ref}>
      <Popover
        title={title}
        drop="up"
        align="left"
        onOpenChange={(open) => open && void store.loadWorktrees()}
        label={
          <>
            {armed ? (
              <NewWorktreeIcon size={13} className={sheet.armed} />
            ) : tagged ? (
              <BranchIcon size={13} />
            ) : (
              <LocalIcon size={13} />
            )}
            {!narrow && <span className={`${sheet.word} ${armed ? sheet.armed : styles.strong}`}>{word}</span>}
            {!narrow && tagged && <Badge variant="secondary">worktree</Badge>}
            <Chevron />
          </>
        }
      >
        {(close) => (
          <Menu close={close}>
            <MenuLabel>Work in</MenuLabel>
            <MenuItem
              icon={linked ? <BranchIcon size={14} /> : <LocalIcon size={14} />}
              label={linked ? 'This worktree' : 'Local'}
              value={branch ?? undefined}
              title={branch ? `${branch} — ${workspace.path}` : workspace.path}
              selected={place === null}
              onSelect={() => store.startDraftIn(null)}
            />
            <MenuItem
              icon={<NewWorktreeIcon size={14} />}
              label={armed ? 'New worktree' : 'New worktree…'}
              value={armedBranch ?? undefined}
              hint={armed ? `Made when you send, from ${armed.base ?? 'HEAD'}.` : undefined}
              title={armedBranch ?? 'A checkout of its own, on a branch of its own.'}
              selected={armed !== null}
              disabled={branch ? false : 'Worktrees need a git repository. This folder is not one.'}
              onSelect={() => {
                close()
                store.askNewWorktree(workspace.path)
              }}
            />
            {others.length > 0 && (
              <>
                <MenuLabel>Worktrees</MenuLabel>
                {others.map((entry) => (
                  <MenuItem
                    key={entry.path}
                    icon={<BranchIcon size={14} />}
                    label={entry.branch ?? '(detached)'}
                    title={`${entry.branch ?? '(detached)'} — ${entry.path}`}
                    selected={chosen?.path === entry.path}
                    onSelect={() =>
                      store.startDraftIn({ kind: 'existing', path: entry.path, branch: entry.branch ?? null })
                    }
                  />
                ))}
              </>
            )}
          </Menu>
        )}
      </Popover>
    </InToolbar>
  )
}
