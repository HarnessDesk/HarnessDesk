import { useEffect, useMemo, useState, type ReactNode } from 'react'

import type {
  ConfigOption,
  OptionValue,
  RateLimits,
  RuntimeHealth,
  RuntimeId,
  RuntimeInfo,
  SkillInfo,
  UsageWindow,
  Worktree,
} from '@harnessdesk/protocol'

import { desktop, hasInlineBrowser } from '../lib/desktop'
import { useRuntime, useSnapshot, useStore } from '../state/context'
import { Slot } from '../slots/registry'
import {
  AppWindow,
  appWindow,
  WindowGroup,
  WindowNav,
  WindowNavEmpty,
  WindowNavItem,
  WindowPage,
} from './AppWindow'
import { dismissOverlays } from './Popover'
import {
  AgentIcon,
  ArchiveIcon,
  BellIcon,
  BranchIcon,
  CheckIcon,
  CrossIcon,
  DownloadIcon,
  ExtensionIcon,
  FolderIcon,
  GlobeIcon,
  HookIcon,
  KeyboardIcon,
  LibraryIcon,
  ModelIcon,
  RetryIcon,
  SearchIcon,
  PluginIcon,
  PlusIcon,
  PresetIcon,
  RouteIcon,
  ShieldIcon,
  SignInIcon,
  SignOutIcon,
  SlidersIcon,
  SparkIcon,
  ThemeSystemIcon,
  TrashIcon,
  UserIcon,
} from './Icons'
import { humanizeLabel } from '../lib/identity'
import { livePlugins } from '../lib/plugins'
import { brandForRuntime } from '../lib/brands'
import { ModelMark, RuntimeMark } from './BrandIcons'
import { describeLimits, formatReset } from '../lib/limits'
import { agentGroups } from '../lib/accounts'
import { describeUpdate, describeVersion } from '../lib/versions'
import { summarise } from '../lib/options'
import { presetsFor, snapshotValues, type AgentPreset } from '../state/presets'
import { ArchiveSection } from './Archive'
import { LibrarySection } from './Library'
import { AgentsSection, agentReadiness } from './SettingsAgents'
import { PluginsSection } from './PluginsSection'
import { ExtensionsSection } from './Extensions'
import { RemoveWorktree } from './RemoveWorktree'
import { isBlocking, worstReadiness, type Readiness } from '../lib/readiness'
import {
  BackLink,
  Btn,
  Chip,
  DetailHead,
  Dot,
  Field,
  FormStack,
  Input,
  kit as kitStyles,
  Note,
  PageHead,
  Row,
  RowButton,
  RowChoice,
  Rows,
  Search,
  SectionHead,
  Select,
  Toggle,
} from '../design/primitives/Kit'
import { Dialog } from '../design/primitives/Dialog'
import { ConfirmDialog } from '../design/patterns/ConfirmDialog'
import type { PolicyRule, RouteInfo } from '../state/store'
import { GeneralSection, AppearanceSection, NotificationsSection, ShortcutsSection } from './SettingsYou'
import { NewSessionDefaults } from './SettingsAgents'
import styles from './Settings.module.css'

/**
 * Settings.
 *
 * Read-mostly by design where the runtime is authoritative — Codex owns account,
 * MCP, and skills configuration, and duplicating those controls would create two
 * places that can disagree. What HarnessDesk owns outright is plugins, so that
 * section is fully interactive.
 */

export type Section =
  | 'general'
  | 'appearance'
  | 'notifications'
  | 'shortcuts'
  | 'workspaces'
  | 'archive'
  | 'agents'
  | 'models'
  | 'skills'
  | 'extensions'
  | 'library'
  | 'plugins'
  | 'permissions'
  | 'browser'

/**
 * The pages that used to exist, mapped to where their rows went.
 *
 * A route is a string other code holds — the composer's model menu, a saved
 * banner, a ⌘K entry written months ago — and a page that moves must keep
 * answering to its old name, or the link lands on an empty window.
 */
const MOVED: Readonly<Record<string, Section>> = {
  account: 'general',
  preferences: 'general',
  presets: 'models',
}
const SECTIONS: readonly Section[] = [
  'general', 'appearance', 'notifications', 'shortcuts', 'workspaces', 'archive',
  'agents', 'models', 'skills', 'extensions', 'library', 'plugins', 'permissions', 'browser',
]
export const resolveSection = (name: string | null | undefined, fallback: Section = 'agents'): Section =>
  name && (SECTIONS as readonly string[]).includes(name)
    ? (name as Section)
    : (name && MOVED[name]) || fallback

/** A section head with its count, the one way every page writes one. */
const withCount = (label: string, count: number): string => (count > 0 ? `${label} · ${count}` : label)


/**
 * A custom endpoint: this agent's conversations run against another
 * provider or proxy. The key goes to the keychain and comes back out as a
 * local gateway the agent is pointed at; the route stores only the reference.
 */
const AddRouteDialog = ({ onClose }: { onClose: () => void }) => {
  const store = useStore()
  const runtime = useRuntime()
  const [name, setName] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wireProtocol = runtime.supportedWireProtocols?.[0] ?? 'responses'
  const ready = name.trim() !== '' && endpoint.trim() !== '' && apiKey.trim() !== ''

  const save = async (): Promise<void> => {
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      const ref = await store.storeCredential(`${name.trim()} key`, apiKey.trim())
      if (!ref) {
        setError('The key could not be stored in the keychain.')
        return
      }
      await store.saveRoute({
        name: name.trim(),
        endpoint: endpoint.trim(),
        wireProtocol,
        credentialRef: ref,
        ...(model.trim() ? { model: model.trim() } : {}),
      })
      onClose()
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Add a custom endpoint"
      icon={<RouteIcon size={15} />}
      onClose={onClose}
      footer={
        <>
          <Btn variant="primary" disabled={busy || !ready} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Add endpoint'}
          </Btn>
          <Btn onClick={onClose}>Cancel</Btn>
        </>
      }
    >
      <FormStack>
        <Field label="Name" hint="How the composer lists it.">
          {(control) => (
            <Input
              {...control}
              value={name}
              placeholder="Claude via proxy"
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        <Field label="Endpoint">
          {(control) => (
            <Input
              {...control}
              value={endpoint}
              placeholder="https://proxy.example.com/v1"
              onChange={(event) => setEndpoint(event.target.value)}
            />
          )}
        </Field>
        <Field label="Model" hint="Optional. The model name that endpoint expects.">
          {(control) => <Input {...control} value={model} onChange={(event) => setModel(event.target.value)} />}
        </Field>
        <Field label="API key" hint="Kept in the keychain, never written to a file.">
          {(control) => (
            <Input
              {...control}
              type="password"
              value={apiKey}
              autoComplete="off"
              onChange={(event) => setApiKey(event.target.value)}
            />
          )}
        </Field>
      </FormStack>
      {error ? (
        <Note key="error" tone="bad">{error}</Note>
      ) : (
        <Note key="note">
          Web search, subagents and reasoning display need the agent’s own models. A custom
          endpoint runs plain conversations.
        </Note>
      )}
    </Dialog>
  )
}

/** The endpoints, as a section of the Models page. */
const RoutesRows = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  const runtime = useRuntime()
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<RouteInfo | null>(null)

  return (
    <>
      <SectionHead
        name={withCount('Custom endpoints', snapshot.routes.length)}
        action={
          <Btn variant="outline" small onClick={() => setAdding(true)}>
            <PlusIcon size={13} />
            Add endpoint
          </Btn>
        }
      />
      <Rows>
        {snapshot.routes.length === 0 && (
          <Row
            title="No custom endpoints"
            desc="Run conversations through a proxy, a gateway or another provider."
          />
        )}
        {snapshot.routes.map((route) => (
          <Row
            key={route.id}
            className={route.usable === false ? styles.rowUnusable : undefined}
            mark={<RouteIcon size={15} />}
            title={route.name}
            desc={
              route.usable === false && route.reason
                ? `Not available with ${runtime.presentation.name}: ${route.reason}.`
                : `${route.endpoint}${route.model ? ` · ${route.model}` : ''}`
            }
            control={
              <Btn small variant="quiet" onClick={() => setRemoving(route)}>
                Remove…
              </Btn>
            }
          />
        ))}
      </Rows>
      {adding && <AddRouteDialog onClose={() => setAdding(false)} />}
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          confirmLabel="Remove endpoint"
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            void store.deleteRoute(removing.id)
            setRemoving(null)
          }}
        >
          New sessions will no longer offer it. A conversation already running on it keeps going.
        </ConfirmDialog>
      )}
    </>
  )
}

/** What a rule applies to, as the words a person would use. */
const RULE_KINDS = [
  { value: '', label: 'Any request' },
  { value: 'command', label: 'Commands' },
  { value: 'fileChange', label: 'File changes' },
  { value: 'permission', label: 'Access requests' },
] as const

const kindWords = (type: string | undefined): string =>
  type === 'command'
    ? 'commands'
    : type === 'fileChange'
      ? 'file changes'
      : type === 'permission'
        ? 'access requests'
        : 'any request'

/**
 * A rule, written in a dialog rather than an always-open form. The pattern
 * is checked here: the host treats one that will not compile as matching
 * nothing, so a "Deny rm -rf" saved with a stray bracket would sit in the
 * list looking like protection and never fire.
 */
const AddRuleDialog = ({
  onAdd,
  onClose,
}: {
  onAdd: (rule: PolicyRule) => Promise<void>
  onClose: () => void
}) => {
  const [name, setName] = useState('')
  const [type, setType] = useState<(typeof RULE_KINDS)[number]['value']>('')
  const [pattern, setPattern] = useState('')
  const [action, setAction] = useState<'approve' | 'deny'>('deny')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const patternError = ((): string | null => {
    const raw = pattern.trim()
    if (!raw) return null
    try {
      new RegExp(raw)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : 'Not a valid pattern.'
    }
  })()
  const ready = name.trim() !== '' && !patternError

  const add = async (): Promise<void> => {
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      await onAdd({
        id: `rule_${Date.now().toString(36)}`,
        name: name.trim(),
        match: {
          ...(type ? { type } : {}),
          ...(pattern.trim() ? { pattern: pattern.trim() } : {}),
        },
        action,
      })
      onClose()
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Add a rule"
      icon={<ShieldIcon size={15} />}
      onClose={onClose}
      footer={
        <>
          <Btn variant="primary" disabled={busy || !ready} onClick={() => void add()}>
            {busy ? 'Adding…' : 'Add rule'}
          </Btn>
          <Btn onClick={onClose}>Cancel</Btn>
        </>
      }
    >
      <FormStack>
        <Field label="Name">
          {(control) => (
            <Input
              {...control}
              value={name}
              placeholder="Never delete recursively"
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        <Field label="Applies to">
          {(control) => (
            <Select {...control} label="Applies to" value={type} options={RULE_KINDS} onChange={setType} />
          )}
        </Field>
        <Field
          label="Matching"
          hint="Text the request must contain. Leave it empty to match every request of that kind."
          {...(patternError ? { error: `Not a valid pattern: ${patternError}` } : {})}
        >
          {(control) => (
            <Input
              {...control}
              value={pattern}
              placeholder="rm -rf"
              onChange={(event) => setPattern(event.target.value)}
            />
          )}
        </Field>
        <Field label="Then">
          {(control) => (
            <Select
              {...control}
              label="What the rule does"
              value={action}
              options={[
                { value: 'deny', label: 'Deny it' },
                { value: 'approve', label: 'Approve it without asking' },
              ]}
              onChange={setAction}
            />
          )}
        </Field>
      </FormStack>
      {error && <Note tone="bad">{error}</Note>}
      {action === 'approve' && (
        <Note tone="warn">
          Anything this matches runs without you seeing it. Keep the match narrow.
        </Note>
      )}
    </Dialog>
  )
}

/** An option is about access when its name says so. */
const isAccessOption = (option: ConfigOption): boolean =>
  /approv|sandbox|permission|network|access|trust|yolo|full/i.test(`${option.id} ${option.label}`)

/**
 * One permission policy, whichever agent asks. What each agent starts with
 * comes first, because that is what a person means by "permissions"; the
 * rules that answer for you come second, and are written in a dialog.
 */
const PermissionsSection = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [rules, setRules] = useState<readonly PolicyRule[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<PolicyRule | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    void store.loadPolicyRules().then(setRules)
  }, [store])

  /*
   * Optimistic, and honest about it: the list shows the new rules at once,
   * and a write that fails puts the old ones back and says so — a rule shown
   * as applied that was never persisted is the one lie this page must not
   * tell. The dialog that asked for the write sees the rejection too.
   */
  const save = async (next: readonly PolicyRule[]): Promise<void> => {
    const before = rules
    setRules(next)
    setSaveError(null)
    try {
      await store.savePolicyRules(next)
    } catch (thrown) {
      setRules(before)
      setSaveError(
        `The rules could not be saved: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
      )
      throw thrown
    }
  }

  const groups = agentGroups(snapshot.runtimes)

  return (
    <>
      <PageHead
        title="Permissions"
        blurb="What each agent may do without asking, and the rules that answer for you."
      />

      {groups.length > 0 && (
        <>
          <SectionHead name="Approvals" />
          <Note>What a new session starts with. An agent that decides this per conversation says so.</Note>
          {groups.map((group) => (
            <NewSessionDefaults
              key={group.info.id}
              info={group.info}
              heading={group.info.presentation.name}
              mark={<RuntimeMark runtime={group.info} size={13} />}
              only={isAccessOption}
              empty="Decided when a session starts"
            />
          ))}
        </>
      )}

      <SectionHead
        name={withCount('Rules', rules?.length ?? 0)}
        action={
          <Btn variant="outline" small onClick={() => setAdding(true)}>
            <PlusIcon size={13} />
            Add rule
          </Btn>
        }
      />
      <Note>
        A rule answers a request before it reaches you, for every agent alike. A question an
        agent asks you directly always comes through.
      </Note>
      {saveError && <Note tone="bad">{saveError}</Note>}
      <Rows>
        {rules === null ? (
          <Row title="Loading…" />
        ) : rules.length === 0 ? (
          <Row title="No rules yet" desc="Every request reaches you." />
        ) : (
          rules.map((rule) => (
            <Row
              key={rule.id}
              mark={<ShieldIcon size={15} />}
              title={rule.name}
              desc={`${rule.action === 'approve' ? 'Approves' : 'Denies'} ${kindWords(rule.match.type)}${
                rule.match.pattern ? ` containing “${rule.match.pattern}”` : ''
              }.`}
              control={
                <Btn small variant="quiet" onClick={() => setRemoving(rule)}>
                  Remove…
                </Btn>
              }
            />
          ))
        )}
      </Rows>
      {adding && (
        <AddRuleDialog onAdd={(rule) => save([...(rules ?? []), rule])} onClose={() => setAdding(false)} />
      )}
      {removing && (
        <ConfirmDialog
          title={`Remove “${removing.name}”?`}
          confirmLabel="Remove rule"
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            // The page reports a refused write; the dialog has already gone.
            void save((rules ?? []).filter((entry) => entry.id !== removing.id)).catch(() => null)
            setRemoving(null)
          }}
        >
          Requests it used to answer will reach you again.
        </ConfirmDialog>
      )}
    </>
  )
}

/** The current session's controls, saved under a name. */
const SavePresetDialog = ({
  options,
  onClose,
}: {
  options: readonly ConfigOption[]
  onClose: () => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = name.trim() !== '' && snapshot.activeRuntime !== null

  const save = async (): Promise<void> => {
    if (!ready || !snapshot.activeRuntime || busy) return
    const preset: AgentPreset = {
      id: `custom-${Date.now().toString(36)}`,
      name: name.trim(),
      description: summarise(options),
      runtime: snapshot.activeRuntime,
      values: snapshotValues(options),
    }
    setBusy(true)
    setError(null)
    try {
      await store.saveCustomPresets([...snapshot.customPresets, preset])
      onClose()
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Save as a preset"
      icon={<PresetIcon size={15} />}
      onClose={onClose}
      footer={
        <>
          <Btn variant="primary" disabled={!ready || busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save preset'}
          </Btn>
          <Btn onClick={onClose}>Cancel</Btn>
        </>
      }
    >
      <FormStack>
        <Field label="Name" hint={summarise(options) || 'The current session’s controls.'}>
          {(control) => (
            <Input
              {...control}
              value={name}
              placeholder="Careful reviewer"
              autoFocus
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void save()
              }}
            />
          )}
        </Field>
      </FormStack>
      {error && <Note tone="bad">{error}</Note>}
    </Dialog>
  )
}

/**
 * Presets, as a section of the Models page. A preset is a snapshot of one
 * session's controls under a name, so the section appears once there is a
 * session to snapshot or a preset to apply — and not before.
 */
const PresetsRows = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState<AgentPreset | null>(null)

  const session = snapshot.activeSessionKey
    ? snapshot.sessions.get(snapshot.activeSessionKey)
    : undefined
  const options = session?.options
  const presets = presetsFor(snapshot.activeRuntime, snapshot.customPresets)
  const elsewhere = snapshot.customPresets.length - presets.length

  if (presets.length === 0 && !options) return null

  return (
    <>
      <SectionHead
        name={withCount('Presets', presets.length)}
        action={
          <Btn variant="outline" small disabled={!options} onClick={() => setSaving(true)}>
            <PlusIcon size={13} />
            Save current session
          </Btn>
        }
      />
      <Note>A preset is a session’s model, effort and permissions saved under a name, for the composer to apply in one click.</Note>
      <Rows>
        {presets.length === 0 && (
          <Row title="No presets yet" desc="Set a session up the way you like, then save it here." />
        )}
        {presets.map((preset) => (
          <Row
            key={preset.id}
            mark={<PresetIcon size={15} />}
            title={preset.name}
            desc={preset.description || 'Saved preset'}
            control={
              <>
                <Btn small disabled={!session} onClick={() => void store.applyPreset(preset)}>
                  Apply
                </Btn>
                <Btn small variant="quiet" onClick={() => setRemoving(preset)}>
                  Remove…
                </Btn>
              </>
            }
          />
        ))}
      </Rows>
      {elsewhere > 0 && (
        <Note>
          {elsewhere} more saved for other agents; they appear when one of them is selected.
        </Note>
      )}
      {saving && options && <SavePresetDialog options={options} onClose={() => setSaving(false)} />}
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          confirmLabel="Remove preset"
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            void store.saveCustomPresets(
              snapshot.customPresets.filter((entry) => entry.id !== removing.id),
            )
            setRemoving(null)
          }}
        >
          Sessions it was applied to keep their settings.
        </ConfirmDialog>
      )}
    </>
  )
}

/**
 * Which models the composer offers, and the endpoints and presets that go
 * with them.
 *
 * The list is the agent's, whole: two hundred rows on a Cursor account, a
 * handful on Codex's. What the switch decides is which of them the composer's
 * picker shows — a picker is a choice you make in a second, a catalogue is a
 * search. Hiding is HarnessDesk's own bookkeeping and reaches no agent.
 */
const ModelsSection = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  const runtime = useRuntime()
  const agentBrand = brandForRuntime(runtime)
  const [query, setQuery] = useState('')

  const hidden = snapshot.hiddenModels[runtime.id] ?? []
  const needle = query.trim().toLowerCase()
  const listed = snapshot.models.filter(
    (model) =>
      needle === '' ||
      model.displayName.toLowerCase().includes(needle) ||
      model.id.toLowerCase().includes(needle),
  )
  const shown = snapshot.models.length - hidden.length
  const total = snapshot.models.length

  return (
    <>
      <PageHead
        title="Models"
        blurb={`Which of ${runtime.presentation.name}’s models the composer offers.`}
      />

      <SectionHead
        name={withCount('Models', total)}
        action={
          <>
            {total > 0 && (
              <span className={kitStyles.sectionToggle}>
                {shown === total ? 'All in the composer' : `${shown} of ${total} in the composer`}
              </span>
            )}
            {total > 4 && shown > 0 && (
              <Btn small variant="outline" onClick={() => store.setAllModelsHidden(runtime.id, true)}>
                Hide all
              </Btn>
            )}
            {hidden.length > 0 && (
              <Btn small variant="outline" onClick={() => store.setAllModelsHidden(runtime.id, false)}>
                Show all
              </Btn>
            )}
            <Btn
              small
              variant="outline"
              disabled={snapshot.catalogRefreshing}
              title="Ask the agent for its models again"
              onClick={() => void store.refreshCatalog()}
            >
              <RetryIcon size={13} />
              {snapshot.catalogRefreshing ? 'Refreshing…' : 'Refresh'}
            </Btn>
          </>
        }
      />

      {/* A handful of models is a list you read; a hundred is one you search. */}
      {total > 8 && (
        <Search
          className={styles.pageSearch}
          value={query}
          placeholder="Search models"
          onChange={setQuery}
        />
      )}

      <Rows>
        {total === 0 && (
          <Row
            title="No models yet"
            desc={`${runtime.presentation.name} has not reported any. Refresh once it is signed in.`}
          />
        )}
        {total > 0 && listed.length === 0 && (
          <Row title="No matches" desc={`Nothing ${runtime.presentation.name} offers matches “${query.trim()}”.`} />
        )}
        {listed.map((model) => (
          <Row
            key={model.id}
            // A model wears the mark of whoever trained it, not of the agent
            // reselling it: Cursor offers Claude and GPT and Grok side by
            // side, and its own cube beside "GPT-5.2" would say the wrong
            // thing. The generic glyph is what "we do not know this one"
            // looks like.
            mark={<ModelMark model={`${model.id} ${model.displayName}`} agent={agentBrand} size={15} />}
            title={
              <>
                {model.displayName}
                {model.isDefault && <span className={styles.inlineBadge}>Default</span>}
                {(model.reasoningLevels.length > 0 || model.thinking) && (
                  <span className={styles.efforts}>
                    {model.thinking && (
                      <span className={styles.effort} data-thinking>
                        {model.thinking === 'always' ? 'Always thinks' : 'Thinking'}
                      </span>
                    )}
                    {model.reasoningLevels.map((level) => (
                      <span key={level.id} className={styles.effort}>
                        {level.label}
                      </span>
                    ))}
                  </span>
                )}
              </>
            }
            desc={model.description}
            control={
              <Toggle
                label={`Show ${model.displayName} in the composer`}
                on={!hidden.includes(model.id)}
                onChange={(next) => store.setModelHidden(runtime.id, model.id, !next)}
              />
            }
          />
        ))}
      </Rows>

      <PresetsRows />
      <RoutesRows />
    </>
  )
}

/**
 * Runtime-wide options, drawn generically. Feature flags are the usual
 * occupant; the section knows only that an option is a toggle or a choice.
 */
/**
 * The runtime's configured hooks, read-only, with trust shown honestly: a
 * managed hook says so and cannot be toggled here, an untrusted or modified
 * one is flagged rather than hidden.
 */
const HooksList = () => {
  const store = useStore()
  const runtime = useRuntime()
  const snapshot = useSnapshot()
  const [hooks, setHooks] = useState<import('@harnessdesk/protocol').HookInfo[] | null>(null)

  useEffect(() => {
    if (!runtime.capabilities.hooks) return
    void store.loadHooks().then(setHooks)
  }, [store, runtime.capabilities.hooks, snapshot.workspace?.path])

  if (!runtime.capabilities.hooks || !hooks || hooks.length === 0) return null
  return (
    <>
      <SectionHead name={`Hooks · ${hooks.length}`} />
      <Note>Run by {runtime.presentation.name} around the agent’s work, configured on disk.</Note>
      <Rows>
        {hooks.map((hook) => (
          <Row
            key={hook.id}
            mark={<HookIcon size={15} />}
            title={hook.event}
            desc={`${hook.source}${hook.managed ? ' · managed' : ''}`}
            control={
              <Chip
                state={hook.trust === 'trusted' || hook.trust === 'managed' ? 'ready' : 'broken'}
                label={hook.trust.charAt(0).toUpperCase() + hook.trust.slice(1)}
              />
            }
          />
        ))}
      </Rows>
    </>
  )
}

/** A wire name as a sentence: `add-admin-task` → "Add Admin Task". */
const skillTitle = (skill: SkillInfo): string => {
  if (skill.displayName) return skill.displayName
  // Only an all-lowercase wire name is rewritten; a name someone cased on
  // purpose ("MixedCase", "v2 checks") is theirs to keep.
  if (!/^[a-z0-9]+([-_][a-z0-9]+)*$/.test(skill.name)) return skill.name
  return skill.name
    .split(/[-_]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/** The scope words runtimes use, as people words. Anything else shows as-is. */
const SKILL_SCOPE_LABEL: Readonly<Record<string, string>> = {
  user: 'Personal',
  repo: 'Project',
  system: 'Built in',
  admin: 'Managed',
}

const skillScopeLabel = (scope: string | undefined): string | null => {
  if (!scope) return null
  // Old snapshots carried the scanned folder here; a path is not a scope.
  if (scope.includes('/')) return null
  return SKILL_SCOPE_LABEL[scope] ?? scope
}

/**
 * The skill's own icon, its accent-coloured initial, or the generic spark.
 *
 * `iconUrl` is a `data:` URI inlined from the installed skill; the adapter
 * drops remote ones, so nothing here reaches the network.
 */
const SkillMark = ({ skill, size = 15 }: { skill: SkillInfo; size?: number }) => {
  const [broken, setBroken] = useState(false)
  if (skill.iconUrl && !broken) {
    return (
      <img
        src={skill.iconUrl}
        alt=""
        width={size + 5}
        height={size + 5}
        style={{ borderRadius: 5 }}
        onError={() => setBroken(true)}
      />
    )
  }
  if (skill.brandColor) {
    return (
      <span className={styles.skillTile} style={{ background: skill.brandColor }}>
        {skillTitle(skill).charAt(0).toUpperCase()}
      </span>
    )
  }
  return <SparkIcon size={size} />
}

const SkillToggle = ({ skill }: { skill: SkillInfo }) => {
  const store = useStore()
  return skill.toggleable === false ? (
    // Nothing to switch: the agent declares what it offers and keeps the
    // on/off to itself, so the row is a list entry.
    <span className={kitStyles.rowFixed}>Always on</span>
  ) : (
    <span onClick={(event) => event.stopPropagation()}>
      <Toggle
        label={skill.name}
        on={skill.enabled}
        onChange={(next) =>
          void store.setSkillEnabled({ name: skill.name, path: skill.path }, next)
        }
      />
    </span>
  )
}

/** One skill, in full: the list clamps its description, this page keeps it. */
const SkillPage = ({
  skill,
  listLabel,
  onBack,
  onUse,
}: {
  skill: SkillInfo
  listLabel: string
  onBack: () => void
  onUse: () => void
}) => {
  const runtime = useRuntime()
  const scope = skillScopeLabel(skill.scope)
  return (
    <>
      <BackLink to={listLabel} onClick={onBack} />
      <DetailHead
        mark={
          <span className={kitStyles.detailMark}>
            <SkillMark skill={skill} size={20} />
          </span>
        }
        name={skillTitle(skill)}
        owner={`${runtime.presentation.name}${scope ? ` · ${scope}` : ''}`}
        {...(skill.shortDescription ? { blurb: skill.shortDescription } : {})}
        actions={<SkillToggle skill={skill} />}
      />

      {skill.description && skill.description !== skill.shortDescription && (
        <>
          <SectionHead name="What it does" />
          <p className={styles.skillBody}>{skill.description}</p>
        </>
      )}

      <SectionHead name="About" />
      <Rows>
        <Row title="Identifier" control={<span className={kitStyles.wire}>{skill.name}</span>} />
        {skill.path && (
          <Row
            title="Where it lives"
            control={<span className={kitStyles.rowFixed}>{skill.path}</span>}
          />
        )}
      </Rows>

      <div className={styles.skillActions}>
        <Btn
          variant="primary"
          onClick={() => {
            window.dispatchEvent(
              new CustomEvent('harnessdesk:compose', { detail: `@${skill.name} ` }),
            )
            onUse()
          }}
        >
          Use in composer
        </Btn>
      </div>
    </>
  )
}

export const SkillsSection = ({ onUse }: { onUse: () => void }) => {
  const snapshot = useSnapshot()
  const runtime = useRuntime()
  const [query, setQuery] = useState('')
  const [openName, setOpenName] = useState<string | null>(null)
  const label = runtime.presentation.skillsLabel ?? 'Skills'

  const skills = useMemo(
    () =>
      snapshot.skills.filter((skill) =>
        `${skill.name} ${skillTitle(skill)} ${skill.shortDescription ?? ''} ${skill.description}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [snapshot.skills, query],
  )
  // An agent that only declares what it has gets the sentence that is true
  // of it: nothing here can be switched, and `@` does not summon one.
  const declared =
    snapshot.skills.length > 0 && snapshot.skills.every((skill) => skill.toggleable === false)

  const open = openName ? (snapshot.skills.find((skill) => skill.name === openName) ?? null) : null
  if (open) {
    return (
      <SkillPage
        skill={open}
        listLabel={label}
        onBack={() => setOpenName(null)}
        onUse={onUse}
      />
    )
  }

  return (
    <>
      <PageHead
        title={label}
        blurb={
          declared
            ? `What ${runtime.presentation.name} can be asked to run: its skills and its own commands.`
            : `Instruction bundles ${runtime.presentation.name} found for this project. Mention one with @, or let the agent choose.`
        }
      />

      {snapshot.skills.length === 0 ? (
        <Rows>
          <Row
            title="No skills found"
            desc={`${runtime.presentation.name} looks for them in the project${
              runtime.presentation.configLocation
                ? ` and in ${runtime.presentation.configLocation}`
                : ''
            }.`}
          />
        </Rows>
      ) : (
        <>
          <Search
            className={styles.pageSearch}
            value={query}
            placeholder={`Search ${label.toLowerCase()}`}
            onChange={setQuery}
          />
          <Rows>
            {skills.length === 0 && <Row title="Nothing matches" />}
            {skills.map((skill) => {
              const scope = skillScopeLabel(skill.scope)
              return (
                <RowButton
                  key={skill.name}
                  onClick={() => setOpenName(skill.name)}
                  mark={<SkillMark skill={skill} />}
                  title={skillTitle(skill)}
                  desc={
                    <span className={styles.skillDesc}>
                      {skill.shortDescription ?? skill.description}
                    </span>
                  }
                  control={
                    <>
                      {scope && <span className={kitStyles.rowFixed}>{scope}</span>}
                      <SkillToggle skill={skill} />
                    </>
                  }
                />
              )
            })}
          </Rows>
        </>
      )}

      {/* Outside the branch above on purpose. Hooks have nothing to do with
          whether any skills were found, and nesting them there hid every hook
          an agent had whenever it happened to have no skills. */}
      <HooksList />
    </>
  )
}


/**
 * Where an agent's pages open, and in which browser.
 *
 * Three placements, each with a real cost, so each is a row with a sentence.
 * The one thing this cannot offer is the browser the person actually uses,
 * signed in as themselves: Chrome refuses remote control of its normal
 * profile, so an agent's browser is always a profile of its own.
 */
const PLACEMENTS = [
  {
    value: 'pane',
    name: 'In HarnessDesk',
    why: 'Beside the conversation, where you can watch every click.',
  },
  {
    value: 'window',
    name: 'In a separate window',
    why: 'A window of its own. Agents can still read and click the page.',
  },
  {
    value: 'system',
    name: 'In your default browser',
    why: 'Agents can open a page there, but not read or click it.',
  },
] as const

const BrowserSection = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  const prefs = snapshot.browserPrefs
  const [found, setFound] = useState<readonly { name: string; path: string }[]>([])
  const [clearing, setClearing] = useState(false)

  useEffect(() => {
    void store.listBrowsers().then(setFound)
  }, [store])

  return (
    <>
      <PageHead title="Browser" blurb="Where the pages agents open appear, and what those pages may keep." />

      <SectionHead name="Pages open" />
      <Rows>
        {PLACEMENTS.map((option) => (
          <RowChoice
            key={option.value}
            title={option.name}
            desc={option.why}
            selected={prefs.placement === option.value}
            onClick={() => store.setBrowserPrefs({ placement: option.value })}
          />
        ))}
      </Rows>

      {prefs.placement === 'window' && (
        <>
          <SectionHead name="Which browser" />
          <Rows>
            <RowChoice
              title="Whichever is installed"
              desc={found[0] ? `Today that is ${found[0].name}.` : 'None found yet.'}
              selected={prefs.externalBinary === ''}
              onClick={() => store.setBrowserPrefs({ externalBinary: '' })}
            />
            {found.map((browser) => (
              <RowChoice
                key={browser.path}
                title={browser.name}
                desc={browser.path}
                selected={prefs.externalBinary === browser.path}
                onClick={() => store.setBrowserPrefs({ externalBinary: browser.path })}
              />
            ))}
            <Row
              title="Another Chromium browser"
              desc="Chrome, Chromium, Brave or Edge. Safari and Firefox cannot be driven."
              control={
                <Input
                  className={styles.pathField}
                  value={
                    found.some((browser) => browser.path === prefs.externalBinary)
                      ? ''
                      : prefs.externalBinary
                  }
                  placeholder="/Applications/…"
                  aria-label="Path to a browser"
                  onChange={(event) => store.setBrowserPrefs({ externalBinary: event.target.value })}
                />
              }
            />
            <Row
              title="Keep its profile between runs"
              desc={
                prefs.keepExternalProfile
                  ? 'Logins survive a restart. The profile is the agent’s own, never yours.'
                  : 'A fresh profile each time; nothing survives the session.'
              }
              control={
                <Toggle
                  label="Keep the agent’s browser profile"
                  on={prefs.keepExternalProfile}
                  onChange={(next) => store.setBrowserPrefs({ keepExternalProfile: next })}
                />
              }
            />
          </Rows>
        </>
      )}

      {prefs.placement === 'pane' && (
        <>
          <SectionHead name="The pane" />
          <Rows>
            <Row
              title="Open links in the pane"
              desc="Otherwise a page’s new windows go to your default browser."
              control={
                <Toggle
                  label="Open links in the pane"
                  on={prefs.linksInPane}
                  onChange={(next) => store.setBrowserPrefs({ linksInPane: next })}
                />
              }
            />
            <Row
              title="Keep logins between runs"
              desc={
                prefs.persistSession
                  ? 'Cookies and logins survive a restart.'
                  : 'Pages reload signed out.'
              }
              control={
                <Toggle
                  label="Keep sessions"
                  on={prefs.persistSession}
                  onChange={(next) => store.setBrowserPrefs({ persistSession: next })}
                />
              }
            />
            <Row
              title="Browsing data"
              desc="Cookies, storage and caches for the pane’s pages."
              control={
                <Btn
                  small
                  disabled={clearing || !hasInlineBrowser()}
                  onClick={() => {
                    setClearing(true)
                    void desktop()
                      ?.clearBrowserData?.()
                      .then(() =>
                        store.notice('info', 'The browser pane’s cookies and storage were cleared.'),
                      )
                      .catch((error: unknown) =>
                        store.notice('error', error instanceof Error ? error.message : String(error)),
                      )
                      .finally(() => setClearing(false))
                  }}
                >
                  {clearing ? 'Clearing…' : 'Clear'}
                </Btn>
              }
            />
          </Rows>
        </>
      )}
    </>
  )
}

/**
 * Every folder this desk has opened, and the worktrees it made for them.
 *
 * Forgetting a folder drops it from the list and touches nothing on disk;
 * removing a worktree goes through the dialog that lists what would be lost.
 */
const WorkspacesSection = () => {
  const store = useStore()
  const snapshot = useSnapshot()

  return (
    <>
      <PageHead
        title="Workspaces"
        blurb="Every folder HarnessDesk has opened. Forgetting one touches nothing on disk."
      />

      <SectionHead name={withCount('Folders', snapshot.workspaces.length)} />
      <Rows>
        {snapshot.workspaces.length === 0 && (
          <Row title="No folders opened yet" desc="Open one from File › Open Folder, or ⌘O." />
        )}
        {snapshot.workspaces.map((workspace) => {
          const isCurrent = workspace.path === snapshot.workspace?.path
          return (
            <Row
              key={workspace.path}
              mark={<FolderIcon size={15} />}
              title={workspace.name}
              desc={workspace.path}
              control={
                isCurrent ? (
                  <Chip state="ready" label="Current" />
                ) : (
                  <>
                    <Btn small onClick={() => store.openWorkspace(workspace.path)}>
                      Open
                    </Btn>
                    <Btn
                      small
                      variant="quiet"
                      title="Drop it from this list. The folder is untouched."
                      onClick={() => void store.forgetWorkspace(workspace.path)}
                    >
                      Forget
                    </Btn>
                  </>
                )
              }
            />
          )
        })}
      </Rows>
      <WorktreeRows />
    </>
  )
}

/**
 * What this copy of HarnessDesk keeps, and how to take it elsewhere.
 *
 * There is no HarnessDesk account, and this page says so by saying what is
 * true instead: everything lives on this Mac, a backup carries it, and a
 * diagnostics bundle is the way to ask for help.
 */
export const GeneralSectionRows = () => (
  <>
    <SectionHead name="Backup" />
    <BackupRows />

    <SectionHead name="Support" />
    <Rows>
      <Row
        title="Diagnostics"
        desc="Versions, agent health, plugin state and the recent log, with secrets and personal paths removed."
        control={<DiagnosticsButton />}
      />
    </Rows>
  </>
)

/**
 * Export and restore, side by side, with the two promises that make them
 * safe to press. Export never includes credentials — they live in the OS
 * keystore and would not decrypt elsewhere. Restore only adds: agents
 * already registered and conversations with a newer local copy are left
 * alone, and the sentence under the row afterwards counts what happened.
 */
const BackupRows = () => {
  const store = useStore()
  const [busy, setBusy] = useState<'export' | 'restore' | false>(false)
  const [outcome, setOutcome] = useState<string | null>(null)

  const exportBackup = async (): Promise<void> => {
    setBusy('export')
    try {
      const backup = await store.transport.request('backup/export', {})
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `harnessdesk-backup-${new Date().toISOString().slice(0, 10)}.json`
      anchor.click()
      URL.revokeObjectURL(url)
      setOutcome(
        `Exported ${backup.agents.length} ${backup.agents.length === 1 ? 'agent' : 'agents'} and ${backup.transcripts.length} ${backup.transcripts.length === 1 ? 'conversation' : 'conversations'}.`,
      )
    } catch (error) {
      setOutcome(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const restoreBackup = async (file: File): Promise<void> => {
    setBusy('restore')
    try {
      const backup: unknown = JSON.parse(await file.text())
      const report = await store.transport.request('backup/import', { backup })
      const skipped = report.agents.skipped + report.transcripts.skipped
      setOutcome(
        `Restored ${report.agents.restored} ${report.agents.restored === 1 ? 'agent' : 'agents'}, ${report.preferences} ${report.preferences === 1 ? 'preference' : 'preferences'} and ${report.transcripts.restored} ${report.transcripts.restored === 1 ? 'conversation' : 'conversations'}.${skipped > 0 ? ` ${skipped} already here or newer, left alone.` : ''}`,
      )
    } catch (error) {
      setOutcome(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Rows>
      <Row
        title="Back up this Mac’s HarnessDesk"
        desc="Agents, preferences and transcripts in one file. Sign-ins are not included; sign in again after restoring."
        control={
          <Btn small disabled={busy !== false} onClick={() => void exportBackup()}>
            <DownloadIcon size={13} />
            {busy === 'export' ? 'Exporting…' : 'Export…'}
          </Btn>
        }
      />
      <Row
        title="Restore from a backup"
        desc={outcome ?? 'Adds what the file holds. Nothing here is replaced or deleted.'}
        control={
          <label className={`${kitStyles.btn} ${kitStyles.btnSm}`} aria-disabled={busy !== false}>
            {busy === 'restore' ? 'Restoring…' : 'Restore…'}
            <input
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              disabled={busy !== false}
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void restoreBackup(file)
              }}
            />
          </label>
        }
      />
    </Rows>
  )
}

/** Assembles the bundle host-side and hands it over as a JSON file. */
const DiagnosticsButton = () => {
  const store = useStore()
  const [busy, setBusy] = useState(false)
  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const bundle = await store.transport.request('diagnostics/bundle', {})
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `harnessdesk-diagnostics-${new Date().toISOString().slice(0, 10)}.json`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (thrown) {
      // A row button has no dialog to speak in; the app's own toast does.
      store.notice(
        'error',
        `The diagnostics bundle could not be made: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <Btn small disabled={busy} onClick={() => void save()}>
      <DownloadIcon size={13} />
      {busy ? 'Collecting…' : 'Save bundle…'}
    </Btn>
  )
}

/**
 * The current workspace's managed worktrees: the disposable checkouts
 * HarnessDesk made for "new session in a worktree", and the one place to
 * clean them up. Nothing renders when there are none.
 */
const WorktreeRows = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [removing, setRemoving] = useState<Worktree | null>(null)
  const managed = snapshot.worktrees.filter((entry) => entry.managed)

  useEffect(() => {
    void store.loadWorktrees()
  }, [store, snapshot.workspace?.path])

  if (managed.length === 0) return null
  return (
    <>
      <SectionHead name={withCount('Worktrees', managed.length)} />
      <Note>
        Separate checkouts on their own branches, so agents can edit side by side. Branches are
        never deleted from here.
      </Note>
      <Rows>
        {managed.map((worktree) => (
          <Row
            key={worktree.path}
            mark={<BranchIcon size={15} />}
            title={worktree.branch ?? '(detached)'}
            desc={worktree.path}
            control={
              <Btn small variant="quiet" onClick={() => setRemoving(worktree)}>
                Remove…
              </Btn>
            }
          />
        ))}
      </Rows>
      {removing && <RemoveWorktree worktree={removing} onClose={() => setRemoving(null)} />}
    </>
  )
}

/**
 * Settings is a window, not a sheet.
 *
 * It takes the whole frame: the window's own traffic lights sit at the top of
 * its nav, "Back to app" is where a sidebar's first row would be, and there is
 * no dimmed backdrop, because this is somewhere you come to read rather than
 * a question to dismiss. The nav groups the pages by what a person is
 * thinking about — themselves, the work they have put away, the agents, what
 * those agents can do, and what they are allowed to reach.
 */
interface NavEntry {
  readonly id: Section
  readonly label: string
  readonly icon: ReactNode
  /** How many of the thing this page lists, when the number is worth knowing. */
  readonly count?: number
  /** The most urgent state among what this page lists, if any is worth showing. */
  readonly state?: Readiness
  /** After the count — the scope mark on a page that belongs to one agent. */
  readonly trail?: ReactNode
  /** Words that should find this page, beyond its own label. */
  readonly keywords?: readonly string[]
}

interface NavGroup {
  readonly label: string
  readonly entries: readonly NavEntry[]
}

/** Case- and punctuation-insensitive: "keyboard shortcuts" finds "Keyboard shortcuts". */
const matches = (entry: NavEntry, query: string): boolean => {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const hay = [entry.label, ...(entry.keywords ?? [])].join(' ').toLowerCase()
  return hay.includes(needle)
}

/**
 * Settings, with the page it is on owned by whoever opened it.
 *
 * The page is a route, and every part of the app can ask for one: the app
 * menu, ⌘K opened over this very window, the import banner, a deep
 * `askSettings` from a composer menu. Holding it here as well as there gave
 * two copies of one fact that could disagree, and a request that named the
 * page the parent already held — Library, then Plugins from the nav rail,
 * then Library again — died in the gap between them, because the parent's
 * state never changed and so neither did the prop.
 *
 * One copy, in the parent, and both halves of that stop being possible: a
 * repeat request either moves the window or was already where it asked for.
 * The nav rail's own clicks go up through `onSection` and come back down as
 * this prop, which is also what lets the page arrive in the same commit as
 * the props that belong with it — `libraryImport` is set beside the section
 * and read by `LibrarySection` on its own first render.
 */
export const Settings = ({
  section = 'agents',
  libraryImport = false,
  onSection,
  onClose,
  onSignIn,
}: {
  /** The page on show. Owned by the caller, so any route can redirect it. */
  section?: Section
  /** Open the Library with its import flow already up — the banner's route in. */
  libraryImport?: boolean
  /** The nav rail's clicks, and the redirect off a page an agent has lost. */
  onSection: (section: Section) => void
  onClose: () => void
  /** Opens the sign-in page on one agent — the flows that need a field live there. */
  onSignIn: (runtime: RuntimeId) => void
}) => {
  const runtime = useRuntime()
  const snapshot = useSnapshot()
  const [query, setQuery] = useState('')

  // A menu left open behind this would paint over it — floating panels
  // outrank the modal layer, because one opened *inside* a dialog has to.
  // Announcing the window closes them.
  useEffect(dismissOverlays, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const hasExtensions = runtime.capabilities.extensionStore || runtime.capabilities.mcp

  // Extensions is the one page that belongs to the agent rather than to the
  // app, so switching to an agent without one can pull it out from under you.
  // Before this, the nav item vanished and the page stayed selected: a blank
  // panel with nothing highlighted and no way to tell what had happened.
  useEffect(() => {
    if (section === 'extensions' && !hasExtensions) onSection('agents')
  }, [section, hasExtensions, onSection])

  // The Agents row carries the one state that stops a first session, so the
  // nav can say there is something to do without being opened.
  // Asked per agent, not per runtime, so the rail and the page it opens
  // cannot disagree: a second account added but never signed into is an
  // unfinished extra, and reading it as "this agent needs a sign-in" put a
  // dot on a nav row whose page said everything was fine.
  const agentsState = useMemo(() => {
    const worst = worstReadiness(
      agentGroups(snapshot.runtimes).map((group) => agentReadiness(group.siblings, snapshot)),
    )
    return isBlocking(worst) ? worst : undefined
  }, [snapshot.runtimes, snapshot.healthByRuntime, snapshot.accountsByRuntime, snapshot.usage])

  // One roster, three counts — the sidebar's, this nav's and the page's — so
  // a plugin a built-in has taken over cannot be counted in one and not another.
  const pluginCount = livePlugins(snapshot.plugins).length

  const accountCount = snapshot.runtimes.reduce(
    (total, info) => total + (snapshot.accountsByRuntime[info.id]?.accounts.length ?? 0),
    0,
  )

  const scoped = (page: string): ReactNode => (
    <span
      className={appWindow.winNavCount}
      title={`${page} belongs to ${runtime.presentation.name}, the agent the active conversation is with.`}
    >
      {runtime.presentation.name}
    </span>
  )

  const groups: readonly NavGroup[] = [
    {
      label: 'General',
      entries: [
        {
          id: 'general',
          label: 'General',
          icon: <SlidersIcon size={14} />,
          keywords: ['backup', 'restore', 'export', 'diagnostics', 'support', 'data', 'sync', 'account', 'transcripts', 'this mac'],
        },
        {
          id: 'appearance',
          label: 'Appearance',
          icon: <ThemeSystemIcon size={14} />,
          keywords: ['theme', 'dark', 'light', 'system', 'interface', 'desk', 'studio', 'palette', 'blueprint', 'editorial', 'accent', 'colour', 'color', 'corners', 'radius', 'font', 'text size', 'line numbers', 'wrap', 'indent', 'tab', 'density', 'sort', 'code editor'],
        },
        {
          id: 'notifications',
          label: 'Notifications',
          icon: <BellIcon size={14} />,
          // "Stop showing this" is the sentence on the menu that sends people
          // here, and "mute" is what they will type looking for it afterwards.
          keywords: ['banner', 'message', 'mute', 'silence', 'alert', 'stop showing', 'remind', 'finished turns', 'failures', 'approvals', 'needs you', 'quota', 'rate limit', 'macos'],
        },
        {
          id: 'shortcuts',
          label: 'Keyboard shortcuts',
          icon: <KeyboardIcon size={14} />,
          keywords: ['keys', 'bindings', 'command', 'new session', 'open folder', 'close pane', 'sidebar', 'changes', 'palette', 'send', 'new line'],
        },
      ],
    },
    {
      label: 'Conversations',
      entries: [
        {
          id: 'workspaces',
          label: 'Workspaces',
          icon: <FolderIcon size={14} />,
          keywords: ['folders', 'projects', 'worktrees', 'forget', 'open folder', 'checkout', 'branch'],
        },
        {
          id: 'archive',
          label: 'Archive',
          icon: <ArchiveIcon size={14} />,
          keywords: ['archived', 'history', 'restore', 'delete', 'trash', 'old sessions'],
        },
      ],
    },
    {
      label: 'Agents',
      entries: [
        {
          id: 'agents',
          label: 'Agents',
          icon: <AgentIcon size={14} />,
          ...(accountCount > 0 ? { count: accountCount } : {}),
          ...(agentsState ? { state: agentsState } : {}),
          keywords: ['accounts', 'sign in', 'sign out', 'add agent', 'registry', 'nickname', 'ring', 'usage', 'plan', 'new sessions', 'defaults', 'update', 'remove'],
        },
        {
          id: 'models',
          label: 'Models',
          icon: <RouteIcon size={14} />,
          keywords: ['endpoint', 'api', 'provider', 'proxy', 'gateway', 'route', 'presets', 'hide', 'composer', 'effort', 'thinking'],
        },
        {
          id: 'skills',
          // The page heads itself with the runtime's own word for these —
          // "Skills & commands" on an ACP agent — and the nav should not
          // promise a narrower page than the one it opens.
          label: runtime.presentation.skillsLabel ?? 'Skills',
          icon: <SparkIcon size={14} />,
          // No count beside the scope: a row has one trailing slot, and whose
          // page this is outranks how many are on it — which the page says in
          // its own heading anyway. Extensions, its neighbour, already reads
          // this way; carrying both was what wrapped this row onto two lines.
          trail: scoped(runtime.presentation.skillsLabel ?? 'Skills'),
          keywords: ['skills', 'commands', 'slash', 'hooks'],
        },
        ...(hasExtensions
          ? [
              {
                id: 'extensions' as const,
                label: 'Extensions',
                icon: <ExtensionIcon size={14} />,
                trail: scoped('Extensions'),
                keywords: ['mcp', 'servers', 'apps', 'connect', 'marketplace', 'install'],
              },
            ]
          : []),
      ],
    },
    {
      // The library leads because it is the overview — the page that says
      // which agent has what — then the desk's own plugins. (A group headed
      // by the agent's name was tried and rejected — an agent is not a
      // settings category — so the agent's own pages sit under Agents with
      // its name as their scope.)
      label: 'Capabilities',
      entries: [
        {
          id: 'library',
          label: 'Library',
          icon: <LibraryIcon size={14} />,
          keywords: ['skills', 'mcp', 'across', 'agents', 'reach', 'cost', 'fired', 'import', 'new skill'],
        },
        {
          id: 'plugins',
          label: 'Plugins',
          icon: <PluginIcon size={14} />,
          ...(pluginCount > 0 ? { count: pluginCount } : {}),
          keywords: ['tools', 'browser', 'git', 'capabilities', 'add plugin', 'install'],
        },
      ],
    },
    {
      label: 'Access',
      entries: [
        {
          id: 'permissions',
          label: 'Permissions',
          icon: <ShieldIcon size={14} />,
          keywords: ['approve', 'approval', 'sandbox', 'rules', 'deny', 'allow', 'commands', 'file changes', 'network'],
        },
        {
          id: 'browser',
          label: 'Browser',
          icon: <GlobeIcon size={14} />,
          keywords: ['pane', 'chrome', 'links', 'window', 'profile', 'cookies', 'logins', 'browsing data'],
        },
      ],
    },
  ]

  const filtered = groups
    .map((group) => ({ ...group, entries: group.entries.filter((entry) => matches(entry, query)) }))
    .filter((group) => group.entries.length > 0)

  return (
    <AppWindow label="Settings">
      <WindowNav
        onBack={onClose}
        search={{
          value: query,
          placeholder: 'Search settings…',
          label: 'Search settings',
          onChange: setQuery,
        }}
      >
        {filtered.map((group) => (
          <WindowGroup key={group.label} label={group.label}>
            {group.entries.map((entry) => (
              <WindowNavItem
                key={entry.id}
                icon={entry.icon}
                label={entry.label}
                selected={section === entry.id}
                onClick={() => onSection(entry.id)}
                {...(entry.count !== undefined ? { count: entry.count } : {})}
                {...(entry.state
                  ? { trail: <Dot state={entry.state} className={appWindow.winNavDot} /> }
                  : entry.trail
                    ? { trail: entry.trail }
                    : {})}
              />
            ))}
          </WindowGroup>
        ))}
        {filtered.length === 0 && (
          <WindowNavEmpty>Nothing in settings matches “{query.trim()}”.</WindowNavEmpty>
        )}
      </WindowNav>

      {/* The library is a grid of agent columns, not a column of sentences, so
          it takes the wide measure the usage dashboard uses. */}
      <WindowPage key={section} wide={section === 'library'}>
            {section === 'general' && <GeneralSection rows={<GeneralSectionRows />} />}
            {section === 'appearance' && <AppearanceSection />}
            {section === 'notifications' && <NotificationsSection />}
            {section === 'shortcuts' && <ShortcutsSection />}
            {section === 'workspaces' && <WorkspacesSection />}
            {section === 'archive' && <ArchiveSection />}
            {section === 'agents' && <AgentsSection onSignIn={onSignIn} />}
            {section === 'models' && <ModelsSection />}
            {section === 'plugins' && <PluginsSection />}
            {section === 'extensions' && hasExtensions && <ExtensionsSection />}
            {section === 'library' && <LibrarySection initialFlow={libraryImport ? 'import' : null} />}
            {section === 'skills' && <SkillsSection onUse={onClose} />}
            {section === 'permissions' && <PermissionsSection />}
            {section === 'browser' && <BrowserSection />}
      </WindowPage>
    </AppWindow>
  )
}
