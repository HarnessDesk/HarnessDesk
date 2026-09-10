import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

import { splitSessionKey, type CapabilityContribution, type PluginInstance, type PluginState } from '@harnessdesk/protocol'

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
  PlusIcon,
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
  BackLink,
  Btn,
  Chip,
  DetailHead,
  kit,
  PageHead,
  Row,
  RowButton,
  Rows,
  Search,
  SectionHead,
  Select,
  Toggle as KitToggle,
} from '../design/primitives/Kit'
import { Tabs, TabsList, TabsTrigger } from '../design/ui'
import { SchemaForm } from './SchemaForm'
import styles from './Plugins.module.css'

/**
 * Settings › Plugins: a list, and a page per plugin.
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
      return 'failed'
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

const grantsOf = (plugin: PluginInstance): string[] => {
  const out: string[] = []
  if (plugin.permissions.workspace.read && plugin.permissions.workspace.write) out.push('Read and write the workspace')
  else if (plugin.permissions.workspace.write) out.push('Write the workspace')
  else if (plugin.permissions.workspace.read) out.push('Read the workspace')
  if (plugin.permissions.shell) out.push('Run shell commands')
  for (const host of plugin.permissions.network.hosts) out.push(`Reach ${host}`)
  if (plugin.permissions.agents.invoke) out.push('Start agents')
  if (plugin.permissions.ui.contribute) out.push('Add to the interface')
  return out
}

const PluginToggle = ({ plugin }: { plugin: PluginInstance }) => {
  const store = useStore()
  return (
    <span onClick={(event) => event.stopPropagation()}>
      <KitToggle
        label={plugin.enabled ? `Disable ${plugin.identity.name}` : `Enable ${plugin.identity.name}`}
        on={plugin.enabled}
        onChange={(next) => void store.setPluginEnabled(plugin.identity.id, next)}
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
const SupersededRow = ({ plugin }: { plugin: PluginInstance }) => {
  const store = useStore()
  const [busy, setBusy] = useState(false)
  const where = plugin.identity.source.kind === 'local' ? plugin.identity.source.path : null
  return (
    <Row
      mark={pluginGlyph(plugin, 16)}
      title={plugin.identity.name}
      desc={`Superseded by the built-in ${plugin.identity.name}, which does the same job. This copy is switched off${
        where ? ` and still on disk, installed from ${where}` : ''
      }.`}
      control={
        <>
          <span className={kit.rowFixed}>Superseded</span>
          <Btn
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void store.uninstallPlugin(plugin.identity.id).finally(() => setBusy(false))
            }}
          >
            {busy ? 'Removing…' : 'Remove'}
          </Btn>
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
  const grants = grantsOf(plugin)
  const byKind = useMemo(() => {
    const groups = new Map<CapabilityContribution['kind'], CapabilityContribution[]>()
    for (const contribution of plugin.contributions) {
      groups.set(contribution.kind, [...(groups.get(contribution.kind) ?? []), contribution])
    }
    return counts.map(([kind]) => [kind, groups.get(kind) ?? []] as const)
  }, [plugin.contributions, counts])

  return (
    <>
      <BackLink to="Plugins" onClick={onBack} />
      <DetailHead
        mark={
          <span className={kit.detailMark}>{pluginGlyph(plugin, 22)}</span>
        }
        name={plugin.identity.name}
        owner={`${originLabel(plugin)}${plugin.identity.version ? ` · ${plugin.identity.version}` : ''}`}
        blurb={plugin.identity.description}
        actions={<PluginToggle plugin={plugin} />}
      />

      {plugin.state.type === 'failed' && (
        <>
          <SectionHead name="Why it did not load" />
          <Rows>
            <Row title={stateLabel(plugin.state)} desc={plugin.state.message} />
          </Rows>
        </>
      )}

      {byKind.map(([kind, entries]) => (
        <div key={kind}>
          <SectionHead
            name={KIND_HEADING[kind]}
            action={
              kind === 'tool' || kind === 'command' ? (
                <span className={kit.sectionToggle}>
                  Tool names
                  <KitToggle label="Show tool names" on={wire} onChange={setWire} />
                </span>
              ) : undefined
            }
          />
          <Rows>
            {entries.map((contribution) => (
              <Row
                key={contribution.id}
                title={contributionSentence(contribution)}
                control={
                  wire && (kind === 'tool' || kind === 'command') ? (
                    <span className={kit.wire}>{describeContribution(contribution)}</span>
                  ) : undefined
                }
              />
            ))}
          </Rows>
        </div>
      ))}

      <SectionHead name="Access" />
      <Rows>
        {grants.length === 0 ? (
          <Row title="Nothing beyond reading what the agent sends it" />
        ) : (
          grants.map((grant) => <Row key={grant} title={grant} />)
        )}
      </Rows>

      {plugin.configSchema && (
        <>
          <SectionHead name="Configuration" />
          <div className={styles.configCard}>
            <SchemaForm
              schema={plugin.configSchema}
              value={plugin.config ?? {}}
              onSubmit={(next) => void store.configurePlugin(plugin.identity.id, next)}
            />
          </div>
        </>
      )}

      <SectionHead name="About" />
      <Rows>
        <Row title="Identifier" control={<span className={kit.wire}>{plugin.identity.id}</span>} />
        <Row
          title="Source"
          control={
            <span className={kit.rowFixed}>
              {originLabel(plugin)}
              {plugin.identity.source.kind === 'local' && plugin.identity.source.path
                ? ` · ${plugin.identity.source.path}`
                : ''}
            </span>
          }
        />
      </Rows>

      {plugin.identity.source.kind !== 'builtin' && (
        <div className={styles.pageActions}>
          {plugin.identity.source.kind === 'local' && plugin.identity.source.path && (
            <Btn
              title={`Reinstall from ${plugin.identity.source.path}`}
              onClick={() => void store.updatePluginFromSource(plugin)}
            >
              <RetryIcon size={14} />
              Update from source
            </Btn>
          )}
          <Btn
            variant="danger"
            onClick={() => {
              void store.uninstallPlugin(plugin.identity.id)
              onBack()
            }}
          >
            <TrashIcon size={14} />
            Uninstall
          </Btn>
        </div>
      )}
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

export const PluginsSection = () => {
  const snapshot = useSnapshot()
  const [tab, setTab] = useState<'list' | 'capabilities'>('list')
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
  const [openId, setOpenId] = useState<string | null>(null)

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
        .sort((a, b) => a.identity.name.localeCompare(b.identity.name)),
    [snapshot.plugins, query],
  )
  const plugins = matching.filter((plugin) => !supersededIds.has(plugin.instanceId))
  const superseded = matching.filter((plugin) => supersededIds.has(plugin.instanceId))

  const open = openId ? (snapshot.plugins.find((plugin) => plugin.instanceId === openId) ?? null) : null
  // A plugin removed while its page is up goes back to the list.
  useEffect(() => {
    if (openId && !open) setOpenId(null)
  }, [openId, open])

  const runtime = useRuntime()
  const pluginToolsReach = runtime.capabilities.pluginTools

  /* The host's answer for "here", fetched when the question changes.
     `capability/list` takes one kind, so "all kinds" is a fan-out — these are
     local calls on a settings page, made when a filter moves rather than on
     every render, and one refusal must not leave the list looking empty. */
  const store = useStore()
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
  }, [store, capWhere, capKind, workspaceRoot, activeRuntime, activeSessionId])

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
      <PageHead
        title="Plugins"
        blurb={
          pluginToolsReach
            ? 'Tools, guardrails, context and panels for every agent in this workspace.'
            : `Tools, guardrails, context and panels. ${runtime.presentation.name} does not take them in the session request, so they reach it only through its own configuration.`
        }
        actions={
          <Btn variant="default" onClick={() => setInstalling(true)}>
            <PlusIcon size={14} />
            Add plugin
          </Btn>
        }
      />

      <div className={styles.listHead}>
        {/* Tabs rather than `Segmented`: this switches which list renders, so
            it is navigation, not a value. See the note in Extensions.tsx. */}
        <Tabs value={tab} onValueChange={(next) => setTab(next as typeof tab)}>
          <TabsList aria-label="What to list">
            <TabsTrigger value="list">
              Installed · {livePlugins(snapshot.plugins).length}
            </TabsTrigger>
            <TabsTrigger value="capabilities">
              Capabilities · {snapshot.contributions.length}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {tab === 'list' && (
          <Search className={styles.search} value={query} placeholder="Search plugins" onChange={setQuery} />
        )}
      </div>

      {installing && <InstallPlugin onClose={() => setInstalling(false)} />}

      {tab === 'list' ? (
        <Rows>
          {plugins.length === 0 ? (
            <Row title={query ? 'No plugin matches' : 'No plugins are loaded'} />
          ) : (
            plugins.map((plugin) => (
              <RowButton
                key={plugin.instanceId}
                onClick={() => setOpenId(plugin.instanceId)}
                mark={pluginGlyph(plugin, 16)}
                title={plugin.identity.name}
                {...(plugin.identity.description ? { desc: plugin.identity.description } : {})}
                control={
                  <>
                    {plugin.state.type === 'failed' && <Chip state="broken" label="failed" />}
                    <span className={kit.rowFixed}>{originLabel(plugin)}</span>
                    <PluginToggle plugin={plugin} />
                  </>
                }
              />
            ))
          )}
          {superseded.map((plugin) => (
            <SupersededRow key={plugin.instanceId} plugin={plugin} />
          ))}
        </Rows>
      ) : (
        <>
          <p className={styles.crossNote}>
            Everything plugins add right now.
            {!pluginToolsReach && (
              <>
                {' '}
                <strong>{runtime.presentation.name}</strong> does not take them in the session
                request; they reach it only through its own configuration.
              </>
            )}
          </p>
          <div className={styles.capFilters}>
            <Search
              className={styles.search}
              value={capQuery}
              placeholder="Search capabilities"
              onChange={setCapQuery}
            />
            <Select
              label="Filter by kind"
              value={capKind}
              options={[{ value: 'all', label: 'All kinds' }, ...CAP_KINDS]}
              onChange={setCapKind}
            />
            {/* The second question this list can answer, and the one it could
                not: a contribution's scope is evaluated by the host, so
                "what applies here" is a request rather than a filter. */}
            <Select
              label="Where it applies"
              value={capWhere}
              options={[
                { value: 'anywhere', label: 'Anywhere' },
                { value: 'here', label: 'Applies here' },
              ]}
              onChange={setCapWhere}
            />
          </div>
          {byKind.length === 0 && (
            <Rows>
              <Row
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
            <div key={kind}>
              <SectionHead name={kindLabel(kind, entries.length)} />
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
                    mark={contributionIcon(contribution.kind, 15)}
                    title={contributionSentence(contribution)}
                    /* Whose it is, and where it applies. The scope was on
                       every contribution the whole time and on no row: a tool
                       offered to one workspace read exactly like one offered
                       to all of them. Only said when it narrows something —
                       "everywhere" under every row is a word nobody reads. */
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
                          label={pluginToolsReach ? 'reaches agent' : 'own config only'}
                        />
                      ) : undefined
                    }
                  />
                ))}
              </Rows>
            </div>
          ))}
        </>
      )}
      <Slot name="settings.section" />
    </>
  )
}
