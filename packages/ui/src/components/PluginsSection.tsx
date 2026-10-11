import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

import {
  describePermissions,
  splitSessionKey,
  type CapabilityContribution,
  type PluginInstance,
  type PluginState,
} from '@harnessdesk/protocol'

import { DestinationBar, DestinationPageScope, useDestinationPage } from '../panels/destination-page'
import { livePlugins, supersededPlugins } from '../lib/plugins'
import { useRuntime, useSnapshot, useStore } from '../state/context'
import { Slot } from '../slots/registry'
import {
  AgentIcon,
  BranchIcon,
  CheckAllIcon,
  FolderIcon,
  GlobeIcon,
  HistoryIcon,
  HookIcon,
  MobileIcon,
  PanelIcon,
  PaperclipIcon,
  PlanIcon,
  PluginIcon,
  ResourceIcon,
  ResponsiveIcon,
  RetryIcon,
  SearchIcon,
  ShieldIcon,
  SlashIcon,
  ToolIcon,
  TrashIcon,
} from './Icons'
import { InstallPlugin } from './InstallPlugin'
import {
  Button,
  MenuItem,
  PageExplanation,
  PageOptions,
  Section,
  Card,
  CardContent,
  Chip,
  CodeText,
  EmptyState,
  Row,
  RowValue,
  RowButton,
  Rows,
  Switch,
  Text,
} from '../design'
import { SchemaForm } from './SchemaForm'

/**
 * Plugins: a list, and a destination per plugin.
 *
 * A row is a sentence about something a plugin lets an agent do. A tool's wire
 * name — `browser_open` — is what you need to write a permission rule and not
 * what you need to read a list, so it lives behind a disclosure on this page
 * and on Permissions, the two places it is the answer, and nowhere else.
 */

/** The glyph for a contribution's kind — what it adds, at a glance. */
export const contributionIcon = (kind: CapabilityContribution['kind'], size = 14): ReactNode => {
  switch (kind) {
    case 'tool':
      return <ToolIcon size={size} />
    case 'command':
      return <SlashIcon size={size} />
    case 'context':
      return <PaperclipIcon size={size} />
    case 'hook':
      return <HookIcon size={size} />
    case 'ui':
      return <PanelIcon size={size} />
    case 'agent':
      return <AgentIcon size={size} />
    case 'resource':
      return <ResourceIcon size={size} />
  }
}

/** The wire name: what an agent actually calls, and what a rule is written against. */
export const describeContribution = (contribution: CapabilityContribution): string => {
  switch (contribution.kind) {
    case 'tool':
      return `${contribution.namespace.replace(/#\d+$/, '')}/${contribution.name}`
    case 'command':
      return `/${contribution.name}`
    case 'context':
      return contribution.label
    case 'hook':
      return `${contribution.event}${contribution.match ? ` · ${contribution.match.join(', ')}` : ''}`
    case 'ui':
      return `${contribution.slot} · ${contribution.label}`
    case 'agent':
      return contribution.displayName
    case 'resource':
      return contribution.label
  }
}

/**
 * The same contribution as a sentence a person reads.
 *
 * A plugin that wrote a description gets to keep it. One that did not gets its
 * own identifier turned back into words — `browser_open` becomes "Browser
 * open" — which is a poor sentence but a better row than a symbol.
 */
const contributionSentence = (contribution: CapabilityContribution): string => {
  const described =
    'description' in contribution && typeof contribution.description === 'string'
      ? contribution.description.trim()
      : ''
  if (described) return described
  const bare =
    contribution.kind === 'tool' || contribution.kind === 'command'
      ? contribution.name
      : describeContribution(contribution)
  const words = bare.replace(/[_/-]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const KIND_LABEL: Record<CapabilityContribution['kind'], [string, string]> = {
  tool: ['tool', 'tools'],
  command: ['command', 'commands'],
  context: ['context source', 'context sources'],
  hook: ['hook', 'hooks'],
  ui: ['panel', 'panels'],
  agent: ['agent', 'agents'],
  resource: ['resource', 'resources'],
}

const kindLabel = (kind: CapabilityContribution['kind'], count: number): string =>
  `${count} ${KIND_LABEL[kind][count === 1 ? 0 : 1]}`

/** What each kind is called as a heading — what the plugin lets someone do. */
const KIND_HEADING: Record<CapabilityContribution['kind'], string> = {
  tool: 'Tools',
  command: 'Commands',
  context: 'Context added to every turn',
  hook: 'Hooks',
  ui: 'Panels',
  agent: 'Agents',
  resource: 'Resources',
}

export const stateLabel = (state: PluginState): string => {
  switch (state.type) {
    case 'pending':
      return state.waitingFor.length > 0 ? `waiting for ${state.waitingFor.join(', ')}` : 'waiting'
    case 'failed':
      return 'Failed'
    default:
      return state.type
  }
}

/**
 * The glyph for a built-in plugin.
 *
 * Twelve identical puzzle pieces is a list you have to read every row of. A
 * plugin that draws what it does is findable at a glance, and the puzzle piece
 * goes back to meaning what it should: something that came from outside.
 */
const PLUGIN_GLYPH: Record<string, (props: { size?: number }) => ReactNode> = {
  android: (props) => <MobileIcon {...props} />,
  browser: (props) => <GlobeIcon {...props} />,
  checkpoint: (props) => <HistoryIcon {...props} />,
  files: (props) => <FolderIcon {...props} />,
  git: (props) => <BranchIcon {...props} />,
  guardrails: (props) => <ShieldIcon {...props} />,
  search: (props) => <SearchIcon {...props} />,
  simulator: (props) => <ResponsiveIcon {...props} />,
  tests: (props) => <CheckAllIcon {...props} />,
  todo: (props) => <PlanIcon {...props} />,
  web: (props) => <GlobeIcon {...props} />,
}

const pluginGlyph = (plugin: PluginInstance, size: number): ReactNode => {
  const draw = PLUGIN_GLYPH[plugin.identity.id]
  return draw ? draw({ size }) : <PluginIcon size={size} />
}

const originLabel = (plugin: PluginInstance): string =>
  plugin.identity.source.kind === 'builtin'
    ? 'Built in'
    : plugin.identity.source.kind === 'npm'
      ? 'npm'
      : 'Installed'

/** What a plugin contributes, counted by kind, in a stable order. */
const contributionCounts = (plugin: PluginInstance): [CapabilityContribution['kind'], number][] => {
  const counts = new Map<CapabilityContribution['kind'], number>()
  for (const contribution of plugin.contributions) {
    counts.set(contribution.kind, (counts.get(contribution.kind) ?? 0) + 1)
  }
  const order: CapabilityContribution['kind'][] = ['tool', 'command', 'context', 'hook', 'ui', 'agent', 'resource']
  return order.filter((kind) => counts.has(kind)).map((kind) => [kind, counts.get(kind) ?? 0])
}

const PluginToggle = ({ plugin }: { plugin: PluginInstance }) => {
  const store = useStore()
  return (
    <span onClick={(event) => event.stopPropagation()}>
      <Switch
        aria-label={plugin.enabled ? `Disable ${plugin.identity.name}` : `Enable ${plugin.identity.name}`}
        checked={plugin.enabled}
        onCheckedChange={(next) => void store.setPluginEnabled(plugin.identity.id, next)}
      />
    </span>
  )
}

/**
 * A copy on disk that the app now ships itself.
 *
 * It carries no toggle: turning it on is not a thing the user should be able
 * to do, because the built-in of the same id would then be shadowed by an
 * older revision. The one honest action is to remove it, and the row says why
 * it is here so that removing it does not feel like guesswork.
 */
const SupersededRow = ({ plugin, marked }: { plugin: PluginInstance; marked: boolean }) => {
  const store = useStore()
  const [busy, setBusy] = useState(false)
  const where = plugin.identity.source.kind === 'local' ? plugin.identity.source.path : null
  return (
    <Row
      mark={marked ? pluginGlyph(plugin, 16) : undefined}
      kind="record"
      title={plugin.identity.name}
      desc={`Superseded by the built-in ${plugin.identity.name}, which does the same job. This copy is switched off${
        where ? ` and still on disk, installed from ${where}` : ''
      }.`}
      control={
        <>
          <RowValue>Superseded</RowValue>
          <Button variant="outline" size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void store.uninstallPlugin(plugin.identity.id).finally(() => setBusy(false))
            }}
          >
            {busy ? 'Removing…' : 'Remove'}
          </Button>
        </>
      }
    />
  )
}

/* --- one plugin ---------------------------------------------------------- */

const PluginPage = ({ plugin, onBack }: { plugin: PluginInstance; onBack: () => void }) => {
  const store = useStore()
  // The wire names are off until asked for. They are the answer on exactly two
  // screens; everywhere else they teach a vocabulary nobody needs.
  const [wire, setWire] = useState(false)
  const counts = contributionCounts(plugin)
  const grants = describePermissions(plugin.permissions)
  const byKind = useMemo(() => {
    const groups = new Map<CapabilityContribution['kind'], CapabilityContribution[]>()
    for (const contribution of plugin.contributions) {
      groups.set(contribution.kind, [...(groups.get(contribution.kind) ?? []), contribution])
    }
    return counts.map(([kind]) => [kind, groups.get(kind) ?? []] as const)
  }, [plugin.contributions, counts])

  return (
    <>
      <DestinationBar place={plugin.identity.name} mark={pluginGlyph(plugin, 16)}
        parents={[{ label: 'Plugins', run: onBack }]}
        more={close => <>
          {plugin.identity.source.kind === 'local' && plugin.identity.source.path && <MenuItem
            label="Update from source" icon={<RetryIcon size={16} />}
            title={`Reinstall from ${plugin.identity.source.path}`}
            onSelect={() => { void store.updatePluginFromSource(plugin); close() }} />}
          {plugin.identity.source.kind !== 'builtin' && <MenuItem label="Uninstall" icon={<TrashIcon size={16} />} danger
            onSelect={() => { void store.uninstallPlugin(plugin.identity.id); onBack(); close() }} />}
        </>} />
      {plugin.identity.description && <PageExplanation>{plugin.identity.description}</PageExplanation>}
      <Rows><Row title={stateLabel(plugin.state)} control={<PluginToggle plugin={plugin} />} /></Rows>
      <PageExplanation>{`${originLabel(plugin)}${plugin.identity.version ? ` · ${plugin.identity.version}` : ''}`}</PageExplanation>

      {plugin.state.type === 'failed' && (
        <Section title="Why it did not load">
          <Rows>
            <Row title={stateLabel(plugin.state)} desc={plugin.state.message} />
          </Rows>
        </Section>
      )}

      {byKind.some(([kind]) => kind === 'tool' || kind === 'command') && <Section title="Display">
        <Rows><Row title="Tool names" control={<Switch aria-label="Show tool names" checked={wire} onCheckedChange={setWire} />} /></Rows>
      </Section>}
      {byKind.map(([kind, entries]) => (
        <Section key={kind} title={KIND_HEADING[kind]}>
          <Rows>
            {entries.map((contribution) => (
              <Row
                key={contribution.id}
                title={contributionSentence(contribution)}
                control={
                  wire && (kind === 'tool' || kind === 'command') ? (
                    <Text role="meta"><CodeText>{describeContribution(contribution)}</CodeText></Text>
                  ) : undefined
                }
              />
            ))}
          </Rows>
        </Section>
      ))}

      <Section title="Access">
        <Rows>
          {/* `describePermissions` never answers with nothing — a plugin holding
              no grant gets the sentence saying so — so there is no empty case to
              carry here. The key takes the index because two identical lines are
              reachable: `secrets` is read off the manifest without deduplication,
              and a manifest may list one twice. */}
          {grants.map((grant, at) => (
            <Row key={`${at}-${grant}`} title={grant} />
          ))}
        </Rows>
      </Section>

      {plugin.configSchema && (
        <Section title="Configuration">
          <Card radius="lg">
            <CardContent>
              <SchemaForm
                schema={plugin.configSchema}
                value={plugin.config ?? {}}
                onSubmit={(next) => void store.configurePlugin(plugin.identity.id, next)}
              />
            </CardContent>
          </Card>
        </Section>
      )}

      <Section title="About">
        <Rows>
          <Row title="Identifier" control={<Text role="meta"><CodeText>{plugin.identity.id}</CodeText></Text>} />
          <Row
            title="Source"
            control={
              <RowValue>
                {originLabel(plugin)}
                {plugin.identity.source.kind === 'local' && plugin.identity.source.path
                  ? ` · ${plugin.identity.source.path}`
                  : ''}
              </RowValue>
            }
          />
        </Rows>
      </Section>
    </>
  )
}

/**
 * Every kind of contribution, once.
 *
 * The kind filter's options and the list of kinds asked of the host are the
 * same list, and were about to be two: a kind added to one and not the other
 * is a kind that quietly stops being listed under "here".
 */
const CAP_KINDS: readonly { readonly value: CapabilityContribution['kind']; readonly label: string }[] = [
  { value: 'tool', label: 'Tools' },
  { value: 'hook', label: 'Hooks' },
  { value: 'context', label: 'Context' },
  { value: 'command', label: 'Commands' },
  { value: 'ui', label: 'Panels' },
  { value: 'agent', label: 'Agents' },
  { value: 'resource', label: 'Resources' },
]

/** Where a contribution applies, as the words on the row. */
const scopeSentence = (scope: CapabilityContribution['scope']): string => {
  switch (scope.kind) {
    case 'global':
      return 'everywhere'
    case 'workspace':
      return `only in ${scope.root}`
    case 'agent':
      return `only for ${scope.runtime}`
    case 'session':
      return 'only in one conversation'
    case 'turn':
      return 'only for one turn'
  }
}

/* --- the page ------------------------------------------------------------ */

export interface PluginsSectionProps {
  readonly section: 'installed' | 'capabilities'
  readonly id: string | null
  readonly onSection: (section: 'installed' | 'capabilities') => void
  readonly onPlugin: (id: string | null) => void
}

/** Temporary no-prop adapter for the shared legacy window; retired by Task 9. */
const LegacyPluginsSection = () => {
  const [section, onSection] = useState<PluginsSectionProps['section']>('installed')
  const [id, onPlugin] = useState<string | null>(null)
  return <DestinationPageScope owner="settings" active>
    <PluginsBody section={section} id={id} onSection={onSection} onPlugin={onPlugin} />
  </DestinationPageScope>
}
export const PluginsSection = (props: PluginsSectionProps | Record<string, never>) =>
  'section' in props ? <PluginsBody {...props as PluginsSectionProps} /> : <LegacyPluginsSection />

const PluginsBody = ({ section, id: openId, onSection, onPlugin: setOpenId }: PluginsSectionProps) => {
  const { owner, active } = useDestinationPage()
  const store = useStore()
  const tab = section === 'installed' ? 'list' : 'capabilities'
  const setTab = (next: 'list' | 'capabilities'): void => onSection(next === 'list' ? 'installed' : 'capabilities')
  const snapshot = useSnapshot()
  const [query, setQuery] = useState('')
  const [capQuery, setCapQuery] = useState('')
  const [capKind, setCapKind] = useState<CapabilityContribution['kind'] | 'all'>('all')
  /**
   * Whether the list is everything plugins contribute or only what applies
   * where you are standing.
   *
   * Two different questions, and until now only the first had an answer. A
   * contribution carries a scope, and the renderer is pushed every one of
   * them without regard to it — so a tool a plugin offers to one conversation
   * has always been listed here as though every agent could call it. `here`
   * asks the host, which is the only thing that evaluates a scope.
   */
  const [capWhere, setCapWhere] = useState<'anywhere' | 'here'>('anywhere')
  const [capHere, setCapHere] = useState<readonly CapabilityContribution[] | null>(null)
  const [installing, setInstalling] = useState(false)
  useEffect(() => { if (!active) setInstalling(false) }, [active])

  // What the roster is, and what a built-in of the same id has taken over.
  // Both come from one place, so the count in the sidebar, the count in the
  // settings nav and the count on this tab cannot drift apart.
  const supersededIds = useMemo(
    () => new Set(supersededPlugins(snapshot.plugins).map((plugin) => plugin.instanceId)),
    [snapshot.plugins],
  )

  const matching = useMemo(
    () =>
      snapshot.plugins
        .filter((plugin) =>
          `${plugin.identity.name} ${plugin.identity.id} ${plugin.identity.description ?? ''}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        )
        .sort((a, b) => a.identity.name.localeCompare(b.identity.name, undefined, { numeric: true })),
    [snapshot.plugins, query],
  )
  const plugins = matching.filter((plugin) => !supersededIds.has(plugin.instanceId))
  const superseded = matching.filter((plugin) => supersededIds.has(plugin.instanceId))
  const marked = snapshot.plugins.some((plugin) => Boolean(PLUGIN_GLYPH[plugin.identity.id]))

  const open = openId ? (snapshot.plugins.find((plugin) => plugin.instanceId === openId) ?? null) : null
  // A plugin removed while its page is up goes back to the list.
  useEffect(() => {
    if (!active || !openId || open) return
    if (owner === 'destination:plugins') store.replaceDestination({ kind: 'plugins', section, id: null })
    else setOpenId(null)
  }, [active, owner, openId, open, section, store, setOpenId])

  const runtime = useRuntime()
  const pluginToolsReach = runtime.capabilities.pluginTools

  /* The host's answer for "here", fetched when the question changes.
     `capability/list` takes one kind, so "all kinds" is a fan-out — these are
     local calls on a settings page, made when a filter moves rather than on
     every render, and one refusal must not leave the list looking empty. */
  const workspaceRoot = snapshot.workspace?.path
  const activeRuntime = snapshot.activeRuntime
  /* From the key, not from the session map. A conversation is the active one
     before its session object has been read in, and the map's answer is
     `undefined` for that whole window — so the scope went to the host without
     a `sessionId` and session-scoped contributions were quietly left out of
     the answer. The key carries the id; splitting it cannot be early. */
  const activeSessionId = snapshot.activeSessionKey
    ? splitSessionKey(snapshot.activeSessionKey).id
    : undefined
  useEffect(() => {
    if (!active) return
    if (capWhere !== 'here') {
      setCapHere(null)
      return
    }
    let live = true
    const scope = {
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(activeRuntime ? { runtime: activeRuntime } : {}),
      ...(activeSessionId ? { sessionId: activeSessionId } : {}),
    }
    const wanted = capKind === 'all' ? CAP_KINDS.map((one) => one.value) : [capKind]
    void Promise.all(wanted.map((kind) => store.listCapabilities(kind, scope))).then((answers) => {
      if (live) setCapHere(answers.flat())
    })
    return () => {
      live = false
    }
  }, [active, store, capWhere, capKind, workspaceRoot, activeRuntime, activeSessionId])

  const filteredContributions = useMemo(() => {
    /* `here` is the host's list, already scoped and already of the right
       kind; `anywhere` is the pushed one, which has to be narrowed by kind
       here. A pending `here` shows nothing rather than the unscoped list —
       drawing the wrong answer while the right one is in flight is how a
       filter comes to be distrusted. */
    let list = capWhere === 'here' ? (capHere ?? []) : snapshot.contributions
    /* Filtered by kind either way. Skipping it under `here` on the grounds
       that the host had already filtered was true only once the answer
       landed: changing the kind leaves the *previous* kind's answer in hand
       until the new request returns, and for that window the list showed
       hooks and panels under "Tools". Both reviewers found it. Filtering
       again is a no-op on a fresh answer and the whole fix on a stale one. */
    if (capKind !== 'all') list = list.filter((c) => c.kind === capKind)
    if (capQuery.trim()) {
      const needle = capQuery.toLowerCase()
      list = list.filter((c) =>
        contributionSentence(c).toLowerCase().includes(needle)
        || ('name' in c && typeof c.name === 'string' && c.name.toLowerCase().includes(needle))
        || c.owner.toLowerCase().includes(needle),
      )
    }
    return list
  }, [snapshot.contributions, capHere, capWhere, capKind, capQuery])

  const byKind = useMemo(() => {
    const groups = new Map<CapabilityContribution['kind'], CapabilityContribution[]>()
    for (const contribution of filteredContributions) {
      groups.set(contribution.kind, [...(groups.get(contribution.kind) ?? []), contribution])
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [filteredContributions])

  const pluginName = useCallback(
    (owner: string) =>
      snapshot.plugins.find((plugin) => plugin.instanceId === owner)?.identity.name ?? owner,
    [snapshot.plugins],
  )

  if (open) return <PluginPage plugin={open} onBack={() => setOpenId(null)} />

  return (
    <>
      <DestinationBar place="Plugins" tab={section}
        tabs={[
          { value: 'installed', label: 'Installed', count: livePlugins(snapshot.plugins).length, run: () => setTab('list') },
          { value: 'capabilities', label: 'Capabilities', count: snapshot.contributions.length, run: () => setTab('capabilities') },
        ]}
        verb={tab === 'list' ? { label: 'Add plugin', run: () => setInstalling(true) } : undefined} />
      {tab === 'list'
        ? <PageOptions search={{ label: 'Search plugins', value: query, change: setQuery }} />
        : <PageOptions search={{ label: 'Search capabilities', value: capQuery, change: setCapQuery }} choices={[
            { id: 'kind', label: 'Filter by kind', value: capKind, items: [{ value: 'all', label: 'All kinds' }, ...CAP_KINDS],
              change: value => setCapKind(value as CapabilityContribution['kind'] | 'all') },
            { id: 'where', label: 'Where it applies', value: capWhere,
              items: [{ value: 'anywhere', label: 'Anywhere' }, { value: 'here', label: 'Applies here' }],
              change: value => setCapWhere(value as 'anywhere' | 'here') },
          ]} />}
      <PageExplanation>{pluginToolsReach
        ? 'Tools, guardrails, context and panels for every agent in this workspace.'
        : `Tools, guardrails, context and panels. ${runtime.presentation.name} does not take them in the session request, so they reach it only through its own configuration.`}</PageExplanation>

      {active && installing && <InstallPlugin onClose={() => setInstalling(false)} />}

      {tab === 'list' ? (
        <Rows>
          {plugins.length === 0 ? (
            <EmptyState variant="row" title={query ? 'No plugin matches' : 'No plugins are loaded'} />
          ) : (
            plugins.map((plugin) => (
              <RowButton
                key={plugin.instanceId}
                data-plugin-id={plugin.instanceId}
                data-plugin-name={plugin.identity.name}
                mark={marked ? pluginGlyph(plugin, 16) : undefined}
                onClick={() => setOpenId(plugin.instanceId)}
                kind="record"
                title={plugin.identity.name}
                {...(plugin.identity.description ? { desc: plugin.identity.description } : {})}
                control={
                  <>
                    {plugin.state.type === 'failed' && <Chip state="broken" label="Failed" />}
                    <RowValue>{originLabel(plugin)}</RowValue>
                    <PluginToggle plugin={plugin} />
                  </>
                }
              />
            ))
          )}
          {superseded.map((plugin) => (
            <SupersededRow key={plugin.instanceId} plugin={plugin} marked={marked} />
          ))}
        </Rows>
      ) : (
        <>
          <PageExplanation>Everything plugins add right now.</PageExplanation>
          {byKind.length === 0 && (
            <Rows>
              <EmptyState variant="row"
                title={
                  capWhere === 'here' && capHere === null
                    ? 'Asking the host…'
                    : capWhere === 'here'
                      ? 'Nothing applies here'
                      : capQuery || capKind !== 'all'
                        ? 'Nothing matches'
                        : 'Nothing is contributed'
                }
              />
            </Rows>
          )}
          {byKind.map(([kind, entries]) => (
            <Section key={kind} title={kindLabel(kind, entries.length)}>
              <Rows>
                {entries.map((contribution) => (
                  <RowButton
                    key={contribution.id}
                    onClick={() => {
                      const owner = snapshot.plugins.find(
                        (plugin) => plugin.instanceId === contribution.owner,
                      )
                      if (owner) setOpenId(owner.instanceId)
                    }}
                    kind="record"
                    mark={contributionIcon(contribution.kind, 15)}
                    title={contributionSentence(contribution)}
                    /* A narrowed scope varies; global rows only name their owner. */
                    desc={
                      contribution.scope.kind === 'global'
                        ? pluginName(contribution.owner)
                        : `${pluginName(contribution.owner)} · ${scopeSentence(contribution.scope)}`
                    }
                    control={
                      contribution.kind === 'tool' ? (
                        // 'available', not 'broken': an agent that refuses the
                        // session-request server may still load the bridge from
                        // its own configuration (DeepSeek Harness does), and the
                        // host cannot see inside that. The chip states what the
                        // host knows, without declaring the tool lost.
                        <Chip
                          state={pluginToolsReach ? 'ready' : 'available'}
                          label={pluginToolsReach ? 'Reaches agent' : 'Own config only'}
                        />
                      ) : undefined
                    }
                  />
                ))}
              </Rows>
            </Section>
          ))}
        </>
      )}
      <Slot name="settings.section" />
    </>
  )
}
