import { RuntimeSkillRows } from './RuntimeSkills'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import {
  runtimeId,
  entryHasProblem,
  isReachProblem,
  summarise,
  type AgentEntry,
  type AgentOrigin,
  type Library,
  type LibraryEntry,
  type LibraryKind,
  type LibraryUsage,
  type ReachState,
  type RuntimeId,
  type RuntimeInfo,
  type SkillInfo,
} from '@harnessdesk/protocol'

import { runtimeLabel } from '../lib/accounts'
import { isPathInside } from '../lib/paths'
import { useLibraryView, useSnapshot, useStore } from '../state/context'
import { type LibraryViewFilter, emptyLibraryView, type LibraryViewState } from '../state/library-views'
import { RuntimeMark } from './BrandIcons'
import {
  AlertIcon,
  CrossIcon,
  DiffIcon,
  FileIcon,
  LibraryIcon,
  SearchIcon,
  TodoPendingIcon,
  TrashIcon,
} from './Icons'
import {
  ActionError,
  CompactBoardCardGrid,
  Banner,
  Chip,
  CodeText,
  Dot,
  MetaList,
  Text,
  Toolbar,
  showToast,
} from '../design'
import {
  Button,
  EmptyState,
} from '../design'
import {
  installSource,
  LibraryFlows,
  type LibraryColumn,
  type LibraryFlow,
} from './LibraryActions'
import { chipFor, SkillList, SkillRow, type SkillChip } from './SkillRow'
import { SkillCard } from './SkillCard'
import { LibrarySkillsControls } from '../panels/library-skills-controls'
import { McpSheet } from './McpSheet'
import { SkillPage } from './SkillPage'
import { DestinationBar } from '../panels/destination-page'
import { shortPath } from '../lib/paths'
import { REACH_NAME } from '../lib/reach-states'
import { LibraryBar } from '../panels/library-bar'
import { useDestinationPage } from '../panels/destination-page'
import { LibraryMatrix, PageExplanation, FormStack, Row, Rows, SectionHead, type PageOption } from '../design'

/**
 * The library: every skill and MCP server on this machine, and which agents
 * can actually see each one.
 *
 * Every other page in Settings is scoped to one agent, because every agent
 * owns its own configuration. That scoping is right, and it is also why no
 * page could answer the only question worth asking about a machine with four
 * agents on it: *does this skill reach all of them?* One list per agent cannot
 * be compared by reading it four times.
 *
 * **The page is also where anything changes** — and every verb keeps the
 * reading discipline that came first: an action opens a plan, the plan shows
 * diffs, and only a confirmation writes. The management lives *on* the
 * matrix rather than in a wizard of its own, because the matrix is the
 * evidence — "install to Cursor" belongs one click from the cell that says
 * Cursor lacks it, and after the write the same cells show whether it
 * landed. What happened here has its own Changes made here page, from the
 * audit log, with the backups each change kept.
 *
 * The design decision that shapes everything below: **a cell is not a
 * checkbox.** Five of the six states would render as an empty box, and each
 * asks for something different. A skill that is absent is fine. A skill whose
 * directory is empty is broken. A skill sitting in a directory the agent does
 * not read looks installed and is not, which is the failure this page was
 * built after finding 43 instances of on one machine.
 *
 * So `reaches` is drawn *quietly* — a small dot — and the four problem states
 * are drawn loudly. A page of green ticks is a page nobody reads; the eye
 * should land on the four rows that need attention, not on the hundred that
 * do not.
 */

/**
 * What this runtime build can do with a Seat's declared attachments — never
 * this file's own concept, and never confused with `reach`: a column can
 * measure a skill reaching it while still being unable to scope which of an
 * Agent's declared names actually load. Surfaced only as the column's own
 * hover text, alongside the runtime's plain name, so a healthy desk stays
 * exactly as quiet as it always was.
 */
const attachmentSupportWords = (info?: RuntimeInfo): string | null => {
  const support = info?.attachments
  if (!support) return null
  return `Skills ${support.skills === 'scoped' ? 'scoped' : 'unscoped'} · Servers ${support.mcp === 'scoped-gated' ? 'gated' : 'unscoped'}`
}

type Filter = LibraryViewFilter

/**
 * The mark for one state.
 *
 * Shape carries the meaning and colour only reinforces it, so the table reads
 * the same to anyone who does not separate red from green. `absent` is the
 * table's own no-value dash, not a glyph: nothing is wrong, and a symbol there
 * would compete with the ones that mean something.
 *
 * Every mark is a part the app already has, set in the meta role's ink — the
 * warning ink where the copy needs mending, the muted one everywhere else: a
 * problem is its icon, a copy no agent has read is the task list's pending
 * ring, a copy that loads is the readiness light, one not loaded yet the
 * neutral light, and "switched off" is the same light struck through (the
 * shared `Dot`'s `struck`).
 */
const ReachMark = ({
  state,
  label,
  placement = 'inline',
}: {
  state: ReachState
  label: string
  placement?: 'inline' | 'cell'
}) => {
  let mark: ReactNode
  if (state === 'hollow' || state === 'rejected') mark = <AlertIcon size={13} />
  else if (state === 'differs') mark = <DiffIcon size={13} />
  else if (state === 'unhostable') mark = <CrossIcon size={13} />
  else if (state === 'reaches') mark = <Dot state="ready" />
  else if (state === 'unscanned') mark = <TodoPendingIcon size={10} />
  else if (state === 'stale') mark = <Dot />
  else if (state === 'off') mark = <Dot struck />
  else mark = '—'
  const warning = state === 'hollow' || state === 'rejected' || state === 'differs' || state === 'unscanned'
  return (
    <Text
      role="meta"
      {...(warning ? { tone: 'warning' as const } : { ink: 'muted' as const })}
      data-reach={state}
      data-placement={placement}
    >
      {/* The mark is a picture of its label; `Text`'s own `role` is its type role. */}
      <span role="img" aria-label={label}>{mark}</span>
    </Text>
  )
}

/**
 * What the marks in the table mean — the ones actually on screen, and no
 * others.
 *
 * The table had a `<caption>` and the caption was `position: absolute` at one
 * pixel: a legend for screen readers and nothing at all for everybody else.
 * So the one view in this app that no other app has — eight distinct marks
 * against a grid of agents — asked a first-time reader to hover every cell to
 * find out what it was looking at, and a reader who does not hover simply
 * never learns.
 *
 * Built from the rows on screen rather than from the eight states, because a
 * key that explains five things absent from the table is furniture. On a
 * healthy machine this is two entries wide.
 */
const Legend = ({ rows }: { rows: readonly LibraryEntry[] }) => {
  const present = useMemo(() => {
    const order: readonly ReachState[] = [
      'reaches',
      'stale',
      'off',
      'absent',
      'unscanned',
      'hollow',
      'rejected',
      'differs',
      'unhostable',
    ]
    const seen = new Set(rows.flatMap((entry) => entry.reach.map((one) => one.state)))
    return order.filter((state) => seen.has(state))
  }, [rows])
  if (present.length < 2) return null
  return (
    <div data-slot="library-legend">
      <Toolbar>
        {present.map((state) => (
          <Text key={state} role="meta">
            <ReachMark state={state} label={REACH_NAME[state]} />
            {REACH_NAME[state]}
          </Text>
        ))}
      </Toolbar>
    </div>
  )
}

/** The words a filter goes by, in its menu row and on its pill while it is on. */
const FILTER_WORDS: Record<Filter, string> = {
  all: 'Everything',
  problems: 'Problems',
  partial: 'Reach some',
  unreachable: 'Reach none',
  hollow: 'Empty on disk',
  differs: 'Copies differ',
  off: 'Switched off',
  unused: 'Never fired',
}

interface LibrarySectionProps { readonly id?: string; readonly section: LibraryKind; readonly onSection: (kind: LibraryKind) => void; readonly importIntent: number }
export const LibrarySection = (props: LibrarySectionProps) => <LibraryBody {...props} />
const LibraryBody = ({ id, section: kind, onSection: setKind, importIntent }: LibrarySectionProps) => {
  const { active } = useDestinationPage()
  const alive = useRef(active)
  alive.current = active
  const generation = useRef(0)
  const checkGeneration = useRef(0)
  const store = useStore()
  const snapshot = useSnapshot()
  const [library, setLibrary] = useState<Library | null>(null)
  const [usage, setUsage] = useState<LibraryUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkFailed, setCheckFailed] = useState<string | null>(null)
  /**
   * The section's view choices, held by the store so leaving for Changes and
   * returning keeps them (`state/library-views`). The old guard stays: a
   * filter the skills view does not offer never survives the switch to it.
   */
  const section = kind === 'mcp' ? 'mcp' : 'skill'
  /**
   * A store that does not implement the view memory — a preview proxy, or a
   * fixture — answers with a placeholder rather than a view; only a real
   * answer is kept, and anything else starts from the empty view.
   */
  const storedView = useLibraryView(section)
  const [localScreen, setLocalScreen] = useState<LibraryViewState>(emptyLibraryView)
  const [screenSection, setScreenSection] = useState(section)
  // The real store is authoritative, including writes from Settings while this
  // page is retained. Preview proxies without view memory keep a local fallback.
  const heldScreen = storedView && typeof storedView.query === 'string' ? storedView : localScreen
  const screen = section === 'skill' && heldScreen.filter === 'problems' ? { ...heldScreen, filter: 'all' as const } : heldScreen
  const latest = useRef(screen)
  latest.current = screen
  if (screenSection !== section) {
    setScreenSection(section)
    setLocalScreen(emptyLibraryView())
  }
  const patchScreen = useCallback((patch: Partial<LibraryViewState>) => {
    const next = { ...latest.current, ...patch }
    latest.current = next
    store.setLibraryView?.(section, next)
    setLocalScreen(next)
  }, [store, section])
  const [open, setOpen] = useState<string | null>(null)
  /**
   * The entry whose sheet is open (the reading surface, by name) and the plan
   * that is open, held with the detail that opened them: `owner` is that
   * detail's id. A route change to another id reads what another id holds as
   * cleared in the render that carries the new id, so the previous skill's
   * plan never stands over the next one; the effect below then drops it for
   * good, so coming back to the first id does not revive it.
   */
  const [held, setHeld] = useState<{ readonly owner: string | undefined; readonly reading: string | null; readonly flow: LibraryFlow | null }>({ owner: id, reading: null, flow: null })
  const reading = held.owner === id ? held.reading : null
  const flow = held.owner === id ? held.flow : null
  const setReading = useCallback((next: string | null) => setHeld(prev => ({ owner: id, reading: next, flow: prev.owner === id ? prev.flow : null })), [id])
  const setFlow = useCallback((next: LibraryFlow | null) => setHeld(prev => ({ owner: id, reading: prev.owner === id ? prev.reading : null, flow: next })), [id])
  const lastImport = useRef(0)
  useEffect(() => {
    if (!active) setHeld(prev => ({ ...prev, reading: null, flow: null }))
  }, [active])
  // Plans belong to the detail that opened them, including within this destination.
  useEffect(() => { setHeld({ owner: id, reading: null, flow: null }) }, [id])
  useEffect(() => {
    if (!active || importIntent === 0 || importIntent === lastImport.current) return
    lastImport.current = importIntent
    setFlow({ type: 'import' })
  }, [active, importIntent])
  /** `''` is every Agent; otherwise `${origin}:${id}` of one on the current roster. */
  const [agentFilter, setAgentFilter] = useState('')
  /** `${kind}:${name}` -> every Agent (winner, never a shadowed origin) that declared it. Bounded to the visible roster — never a background scan of every repository. */
  const [declaredBy, setDeclaredBy] = useState<ReadonlyMap<string, readonly { readonly id: string; readonly origin: AgentOrigin; readonly label: string }[]> | null>(null)

  const cwd = snapshot.workspace?.path
  useEffect(() => () => { checkGeneration.current++ }, [active, cwd])

  const load = useCallback(async () => {
    if (!alive.current) return
    const ticket = ++generation.current
    const current = () => alive.current && ticket === generation.current
    setLoading(true)
    setFailed(null)
    try {
      const next = await store.transport.request('library/read', cwd ? { cwd } : {})
      if (!current()) return
      setLibrary(next)
      void store.transport.request('library/usage', {}).then(value => { if (current()) setUsage(value) })
        .catch(() => { if (current()) setUsage(null) })
    } catch (error) {
      if (current()) setFailed(error instanceof Error ? error.message : String(error))
    } finally {
      if (current()) setLoading(false)
    }
  }, [cwd, store])
  useEffect(() => {
    if (active) void load()
    return () => { generation.current++ }
  }, [active, load])

  const checkUpdates = async () => {
    if (!library || checking) return
    const ticket = checkGeneration.current
    const current = () => alive.current && ticket === checkGeneration.current
    setChecking(true)
    setCheckFailed(null)
    try {
      const updates = await store.transport.request('library/sources/check', {})
      if (!current()) return
      await load()
      if (!current()) return
      const unavailable = updates.filter(one => one.status === 'gone' || one.status === 'unreachable')
      const behind = updates.filter(one => one.status === 'behind')
      showToast({ id: 'library-updates', ...(unavailable.length > 0
        ? { tone: 'warning', title: unavailable.length === 1 ? '1 source could not be checked' : `${unavailable.length} sources could not be checked`, ...(unavailable[0]?.reason ? { body: unavailable[0].reason } : {}) }
        : behind.length > 0
          ? { tone: 'neutral', title: behind.length === 1 ? '1 update available' : `${behind.length} updates available` }
          : updates.length > 0
            ? { tone: 'success', title: 'Everything from a repository is up to date' }
            : { tone: 'neutral', title: 'No skill here came from a repository' }) })
    } catch (error) {
      if (current()) setCheckFailed(error instanceof Error ? error.message : String(error))
    } finally {
      setChecking(false)
    }
  }

  // The Agent filter's own roster — the same guarded, cached read every other
  // Agent picker in the app uses (`CommandPalette`), never a fresh load per
  // render of this page.
  useEffect(() => {
    if (active && snapshot.agents === null) void store.loadAgents()
  }, [active, store, snapshot.agents])

  /**
   * What each Agent on the visible roster declares, resolved once per
   * roster change — never per keystroke or per filter press, and never a
   * scan of every repository this machine has ever opened. A shadowed
   * origin never contributes here: `snapshot.agents` already names only the
   * winner for each id, the same roster the Agents window itself lists.
   */
  useEffect(() => {
    if (!active) return
    const roster = snapshot.agents
    if (!roster) {
      setDeclaredBy(null)
      return
    }
    let live = true
    Promise.all(
      roster.map(async (entry: AgentEntry) => {
        try {
          return { entry, view: await store.readAgentAttachments(entry.id, entry.origin) }
        } catch {
          return null
        }
      }),
    ).then((results) => {
      if (!live) return
      const map = new Map<string, { id: string; origin: AgentOrigin; label: string }[]>()
      for (const result of results) {
        // `readAgentAttachments` is typed to always resolve a full view or
        // reject — the `catch` above already turns a rejection into `null`.
        // A `view` that is still missing here (a store that does not honor
        // that contract) is the same "nothing declared" state as an empty
        // `declarations` array, never a reason to lose every other Agent's
        // roster read.
        if (!result || !result.view) continue
        const label = result.entry.definition?.name ?? result.entry.id
        for (const declaration of result.view.declarations) {
          const compositeKey = `${declaration.kind}:${declaration.name}`
          const list = map.get(compositeKey) ?? []
          list.push({ id: result.entry.id, origin: result.entry.origin, label })
          map.set(compositeKey, list)
        }
      }
      setDeclaredBy(map)
    })
    return () => {
      live = false
    }
  }, [active, store, snapshot.agents])

  /**
   * Column headings, named the way the rest of the interface names an agent:
   * from its own presentation. One column per agent, never per account — the
   * host answers that way, because two accounts of one harness share every
   * directory but the credential, and a person asking "does this skill reach
   * Codex?" is not asking it once per sign-in.
   */
  const columns = useMemo(
    () =>
      (library?.runtimes ?? []).map((id: RuntimeId) => {
        const info = snapshot.runtimes.find((runtime) => runtime.id === id)
        const label = info
          ? runtimeLabel(info, snapshot.runtimes, snapshot.accountsByRuntime, snapshot.accountPrefs)
          : id
        // `runtimeLabel` may say "Agent · account" where an agent has more
        // than one signed in. The column speaks for the agent, whichever
        // account holds the session, so the head keeps the name and drops the
        // account half.
        const [name] = label.split(' \u00b7 ')
        return { id, label: name ?? label, head: name ?? label, ...(info ? { info } : {}) }
      }),
    [library, snapshot.runtimes, snapshot.accountsByRuntime, snapshot.accountPrefs],
  )

  // A Settings link may select an installed runtime before its first scan.
  // Keep that selection named and clearable rather than claiming an unscoped view.
  const runtimeItems = [{ value: '', label: 'All runtimes' }, ...snapshot.runtimes.map(info => ({ value: info.id, label: info.presentation.name }))]
  for (const column of columns) if (!runtimeItems.some(item => item.value === column.id)) runtimeItems.push({ value: column.id, label: column.label })
  if (screen.runtime && !runtimeItems.some(item => item.value === screen.runtime)) runtimeItems.push({ value: screen.runtime, label: 'Selected runtime (unavailable)' })

  /** Hide reserved and wholly hollow skills, retaining mixed copies for repair. */
  const listedEntries = useMemo(() => (library?.entries ?? []).filter(entry =>
    entry.kind !== 'skill' || (!entry.name.startsWith('_') &&
      (entry.copies.length === 0 || entry.copies.some(copy => !copy.hollow)))), [library])

  const searched = useMemo(() => {
    if (!library) return []
    const needle = screen.query.trim().toLowerCase()
    return listedEntries.filter(
      (entry) =>
        entry.kind === kind &&
        (kind !== 'skill' || !screen.runtime || entry.reach.some(reach => reach.runtime === screen.runtime && reach.state !== 'absent')) &&
        (needle === '' || `${entry.name} ${entry.title ?? ''} ${entry.description ?? ''}`.toLowerCase().includes(needle)),
    )
  }, [library, listedEntries, kind, screen.query, screen.runtime])

  // State counts match the chip and search; chip counts cover the whole inventory.
  const chipEntries = useMemo(() => searched.filter(entry =>
    kind !== 'skill' || screen.chip === 'all' || chipFor(entry, columns) === screen.chip), [searched, kind, screen.chip, columns])

  /**
   * The Declared by filter, once.
   *
   * Declarations, not measured reach: a name this Agent declared stays in the
   * set even when no runtime has resolved it yet (decision: "retain unresolved
   * rows"). Reach is a separate column, read from `entry.reach` exactly as it
   * always was. Every count on the page is read through this, so a chip or a
   * filter row shows the number of cards choosing it will leave.
   */
  const declared = useCallback((entry: LibraryEntry) => {
    if (!agentFilter) return true
    const refs = declaredBy?.get(`${entry.kind}:${entry.name}`) ?? []
    return refs.some((ref) => `${ref.origin}:${ref.id}` === agentFilter)
  }, [agentFilter, declaredBy])

  const scopedEntries = useMemo(() => chipEntries.filter(declared), [chipEntries, declared])
  const counts = useMemo(
    () => (library ? summarise({ ...library, entries: scopedEntries }) : null),
    [library, scopedEntries],
  )

  const rows = useMemo(() => {
    return scopedEntries.filter((entry) => {
      if (screen.filter === 'problems') return entryHasProblem(entry)
      if (screen.filter === 'partial') {
        const reaching = entry.reach.filter((one) => one.state === 'reaches').length
        return reaching> 0 && reaching < entry.reach.length
      }
      if (screen.filter === 'hollow') return entry.copies.some((copy) => copy.hollow)
      if (screen.filter === 'differs') {
        const digests = new Set(entry.copies.filter((one) => !one.hollow).map((one) => one.digest))
        return digests.size> 1
      }
      if (screen.filter === 'unreachable') return entry.reach.every((one) => one.state !== 'reaches')
      if (screen.filter === 'off') return entry.reach.some((one) => one.state === 'off')
      if (screen.filter === 'unused') {
        return (
          usage !== null &&
          entry.reach.some((one) => one.state === 'reaches') &&
          usage.skills[entry.name] === undefined
        )
      }
      return true
    })
  }, [scopedEntries, screen.filter, usage])

  // Cards always sort by name. Matrix retains the existing cost order for
  // Never fired, and MCP retains its own list/matrix ordering.
  const ordered = useMemo(
    () =>
      (kind === 'mcp' || screen.skillView === 'matrix') && screen.filter === 'unused'
        ? [...rows].sort(
            (a, b) => (b.catalogTokens ?? 0) - (a.catalogTokens ?? 0) || a.name.localeCompare(b.name),
          )
        : kind === 'skill' && screen.skillView !== 'matrix' ? [...rows].sort((a, b) => a.name.localeCompare(b.name)) : rows,
    [rows, screen.filter, kind, screen.skillView],
  )

  /**
   * Skills that reach at least one agent and have never fired in a stored
   * conversation. The join the whole page builds to: advertised is paid for
   * every turn, and this is the set paying for nothing — as far as this
   * desk's own record can see, which is what the tile's label says.
   */
  const unusedCount = useMemo(() => {
    // While usage is still loading, every reaching skill is a candidate rather
    // than a count: `undefined` leaves the chip without a number while its row
    // waits, disabled, for the answer.
    if (usage === null) return undefined
    return scopedEntries.filter(
      (entry) =>
        entry.kind === 'skill' &&
        entry.reach.some((one) => one.state === 'reaches') &&
        usage.skills[entry.name] === undefined,
    ).length
  }, [scopedEntries, usage])

  // snapshot.skills belongs only to the active runtime. Name its owner and
  // never project its commands into another runtime's scope or disk diagnostics.
  const commandRuntime = snapshot.runtimes.find(info => info.id === snapshot.activeRuntime)
  const nativeSkills = useMemo(() => {
    if (kind !== 'skill' || !commandRuntime || (screen.runtime && screen.runtime !== commandRuntime.id)) return []
    const covered = new Set(listedEntries.filter(entry => entry.kind === 'skill').map(entry => entry.name))
    return snapshot.skills.filter(skill => !covered.has(skill.name))
  }, [kind, commandRuntime, screen.runtime, listedEntries, snapshot.skills])
  const searchedNativeSkills = screen.chip === 'all' && !agentFilter ? nativeSkills.filter(skill => {
    const needle = screen.query.trim().toLowerCase()
    return !needle || `${skill.name} ${skill.displayName ?? ''} ${skill.description ?? ''} ${skill.shortDescription ?? ''}`.toLowerCase().includes(needle)
  }) : []
  const visibleNativeSkills: readonly SkillInfo[] = screen.filter === 'all' ? searchedNativeSkills
    : screen.filter === 'off' ? searchedNativeSkills.filter(skill => !skill.enabled) : []

  /**
   * Each agent's scanned skill directories in the order a name conflict is
   * resolved: project scope over user, then the location table's own order.
   * This is what the table says, not what the agent was asked — the drawer's
   * tooltip admits exactly that.
   */
  const scanOrder = useMemo(() => {
    const map = new Map<RuntimeId, readonly string[]>()
    for (const id of library?.runtimes ?? []) {
      const ordered = (library?.locations ?? [])
        .filter((one) => one.runtime === id && one.kind === 'skill' && one.scanned)
        .sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'project' ? -1 : 1))
      map.set(
        id,
        ordered.map((one) => one.path),
      )
    }
    return map
  }, [library])

  /**
   * Where anything can actually land, by kind: the agents whose location
   * table declares an MCP configuration file, and the ones with a skills
   * directory to write into. Nothing can go anywhere else, and the plan
   * would refuse each attempt with a reason — but a button that always ends
   * in a refusal is noise, so the Install offers and the bulk import both
   * stop at these sets. An agent registered before its brand joins the
   * location table is exactly the case this catches.
   */
  const hosts = useMemo(() => {
    const skill = new Set<RuntimeId>()
    const mcp = new Set<RuntimeId>()
    for (const one of library?.locations ?? []) {
      ;(one.kind === 'mcp' ? mcp : skill).add(one.runtime)
    }
    return { skill, mcp }
  }, [library])

  /**
   * What the page can detect on its own — the lines that carry an action, as
   * opposed to the tiles, which carry a filter. Two detections today:
   * every hollow copy on disk (one click files and removes them all), and an
   * agent paying an outsized catalogue every turn, most of it for skills
   * that have never fired here.
   */
  const hollowCopies = useMemo(
    () =>
      (library?.entries ?? [])
        .filter((entry) => entry.kind === 'skill')
        .flatMap((entry) =>
          entry.copies
            .filter((copy) => copy.hollow && !copy.readOnly)
            .map((copy) => ({ name: entry.name, path: copy.path })),
        ),
    [library],
  )

  // Two-thirds of what one real machine was measured to pay (≈6.8k tokens of
  // catalogue per turn) — high enough that a modest setup never sees the
  // warning, low enough that it fires well before the measured pathology.
  const OVERLOAD_TOKENS = 4000
  const overloaded = useMemo(
    () =>
      columns.flatMap((column, index) => {
        const skillEntries = (library?.entries ?? []).filter((entry) => entry.kind === 'skill')
        const total = skillEntries.reduce(
          (sum, entry) =>
            entry.reach[index]?.state === 'reaches' && entry.catalogTokens
              ? sum + entry.catalogTokens
              : sum,
          0,
        )
        if (total < OVERLOAD_TOKENS) return []
        const neverFired =
          usage === null
            ? null
            : skillEntries.filter(
                (entry) =>
                  entry.reach[index]?.state === 'reaches' && usage.skills[entry.name] === undefined,
              ).length
        return [{ column, total, neverFired }]
      }),
    [columns, library, usage],
  )

  const chipCounts = useMemo(() => {
    const result: Record<SkillChip, number> = { all: 0, 'needs-you': 0, 'one-runtime': 0, nobody: 0 }
    const attention = new Set<string>()
    for (const entry of listedEntries.filter(one => one.kind === 'skill' && declared(one) && (!screen.runtime || one.reach.some(reach => reach.runtime === screen.runtime && reach.state !== 'absent')))) {
      result.all++
      const group = chipFor(entry, columns)
      if (group === 'needs-you') attention.add(entry.name)
      else if (group !== 'all') result[group]++
    }
    // Cleanup includes wholly hollow skills, which have no card. Count each
    // affected skill once, plus each catalogue warning, so its action stays reachable.
    for (const copy of hollowCopies) attention.add(copy.name)
    result['needs-you'] = attention.size + overloaded.length
    if (!agentFilter) result.all += nativeSkills.length
    return result
  }, [listedEntries, declared, columns, screen.runtime, nativeSkills, agentFilter, hollowCopies, overloaded])
  const showingCatalogueAttention = kind === 'skill' && screen.chip === 'needs-you' && (hollowCopies.length > 0 || overloaded.length > 0)

  /**
   * The entry the sheet is showing, looked up by name every render rather
   * than held as an object. An apply re-reads the library; a sheet holding
   * the old object would keep showing the state from before the write it
   * just made, which is the one moment its facts most need to be current.
   */
  const readingEntry = useMemo(
    () => listedEntries.find(one => one.kind === kind && one.name === reading) ?? null,
    [listedEntries, kind, reading],
  )

  /** Only the gaps that apply to what is on screen; the rest are noise here. */
  const gaps = (library?.gaps ?? []).filter((gap) => gap.kind === kind)

  /** Over `searched` within the Declared by scope, like every count in the menu. */
  const problemCount = useMemo(() => searched.filter(entry => declared(entry) && entryHasProblem(entry)).length, [searched, declared])
  const agentName = agentFilter
    ? (snapshot.agents?.find((entry) => `${entry.origin}:${entry.id}` === agentFilter)?.definition?.name ?? null)
    : null

  const filterData: PageOption['items'] = [
    { value: 'all', label: FILTER_WORDS.all, count: counts ? counts.total + searchedNativeSkills.length : undefined },
    { value: 'problems', label: FILTER_WORDS.problems, count: problemCount, title: 'Anything wrong: reaches no runtime, empty on disk, or copies that differ.' },
    { value: 'partial', label: FILTER_WORDS.partial, count: counts?.partial },
    { value: 'unreachable', label: FILTER_WORDS.unreachable, count: counts?.unreachable },
    { value: 'hollow', label: FILTER_WORDS.hollow, count: counts?.hollow },
    { value: 'differs', label: FILTER_WORDS.differs, count: counts?.differs },
    { value: 'off', label: FILTER_WORDS.off, count: counts ? counts.off + searchedNativeSkills.filter(skill => !skill.enabled).length : undefined, title: 'Installed in a runtime and turned off in its own settings, so nothing loads it there.' },
    ...(kind === 'skill' ? [{ value: 'unused', label: FILTER_WORDS.unused, count: unusedCount,
      disabled: usage === null ? 'Counting activations in the stored conversations…' : false as const,
      title: usage === null ? undefined : `Reaches at least one runtime, and none of the ${usage.sessionsScanned} conversations this desk stores shows it loading. What ran elsewhere is not counted.` }] : []),
  ]
  const libraryChoices: readonly PageOption[] = [
    { id: 'view', label: 'How to show the library', value: screen.view,
      items: [{ value: 'list', label: 'List' }, { value: 'matrix', label: 'Matrix' }],
      mode: 'menu',
      change: value => { patchScreen({ view: value as 'list' | 'matrix' }); setOpen(null) } },
    { id: 'filter', label: 'Filter the library', value: screen.filter, mode: 'menu',
      items: filterData.filter(item => counts === null || item.value === 'all' || item.value === screen.filter || (item.count ?? 0)> 0).map(item => ({ ...item, disabled: counts === null ? 'Reading every runtime’s directories…' : item.disabled })),
      change: value => patchScreen({ filter: value as Filter }) },
    { id: 'agent', label: 'Declared by', value: agentFilter, mode: 'menu',
      items: [{ value: '', label: 'Any agent' }, ...(snapshot.agents ?? []).map(entry => ({ value: `${entry.origin}:${entry.id}`, label: entry.definition?.name ?? entry.id }))], change: setAgentFilter },
  ]
  const openEntry = (entry: LibraryEntry) => entry.kind === 'skill'
    ? store.openDestination({ kind: 'library', section: 'skill', id: entry.name })
    : setReading(entry.name)
  if (id !== undefined) {
    const entry = library?.entries.find(one => one.kind === 'skill' && one.name === id)
    const back = () => store.openDestination({ kind: 'library', section: 'skill' })
    return <>
      {failed !== null && <ActionError>The library could not be read: {failed}</ActionError>}
      {entry ? <SkillPage key={entry.name} entry={entry} columns={columns} hosts={hosts} cwd={cwd} usage={usage} home={library?.home}
        onBack={back} onChanged={() => void load()} onFlow={setFlow} /> : <>
        <DestinationBar place="Customize" />
        {loading ? <EmptyState variant="inline" title="Reading skills…" /> : failed !== null ? <Button variant="ghost" size="sm" onClick={back}>Back to Customize</Button> : <EmptyState title="Skill not found">
          <Button variant="ghost" size="sm" onClick={back}>Back to Customize</Button>
        </EmptyState>}
      </>}
      <LibraryFlows flow={active ? flow : null} setFlow={setFlow} library={library} columns={columns} cwd={cwd} onApplied={() => void load()} />
    </>
  }
  return (
    <>
      <LibraryBar kind={kind} change={next => { setKind(next); setOpen(null) }} loaded={library !== null} loading={loading}
        author={() => setFlow({ type: 'author' })} importing={() => setFlow({ type: 'import' })} github={() => setFlow({ type: 'github' })} checking={checking} check={() => void checkUpdates()} rescan={() => void load()}
        choices={kind === 'mcp' ? libraryChoices : []} search={kind === 'mcp' ? { label: 'Search servers', value: screen.query, change: value => patchScreen({ query: value }) } : undefined} />
      {/* MCP retains its PageOptions, list, matrix and filters; only skills use cards and chips. */}
      {kind === 'skill' ? <LibrarySkillsControls chip={screen.chip} counts={chipCounts} onChip={value => patchScreen({ chip: value })} view={screen.skillView} onView={next => { patchScreen({ skillView: next }); setOpen(null) }}
        runtime={{ id: 'runtime', label: 'Runtime', value: screen.runtime ?? '', items: runtimeItems, change: value => patchScreen({ runtime: value ? runtimeId(value) : '' }) }}
        filters={{ ...libraryChoices[1]!, items: filterData.filter(one => one.value !== 'problems' && (one.value === 'all' || one.value === screen.filter || Boolean(one.disabled) || (one.count ?? 0) > 0)).map(one => ({ ...one, disabled: counts === null ? 'Reading skills…' : one.disabled })) }}
        agent={libraryChoices[2]!} search={{ label: kind === 'skill' ? 'Search skills' : 'Search servers', value: screen.query, change: value => patchScreen({ query: value }) }} /> : null}
      {failed !== null && <ActionError>The library could not be read: {failed}</ActionError>}
      {checkFailed !== null && <ActionError>{checkFailed}</ActionError>}

      {showingCatalogueAttention && (
        <div data-slot="library-attention"><FormStack>
          {hollowCopies.length> 0 && <Banner
            tone="warning"
            measure="container"
            title="Empty skill directories"
            actions={<Button variant="outline" size="sm" onClick={() => setFlow({
              type: 'plan',
              title: 'Clean up empty skill directories',
              intents: hollowCopies.map(copy => ({ kind: 'removeCopy' as const, name: copy.name, path: copy.path })),
            })}>Clean up…</Button>}
          >
            {hollowCopies.length} {hollowCopies.length === 1 ? 'directory holds' : 'directories hold'} a
            skill’s name and no definition — a runtime that scans them lists the name and loads nothing.
          </Banner>}
          {overloaded.map(({ column, total, neverFired }) => <Banner
            key={column.id}
            tone="neutral"
            title={`${column.label} skill catalogue`}
            actions={neverFired !== null && neverFired> 0
              ? <Button variant="outline" size="sm" onClick={() => { patchScreen({ chip: 'all', filter: 'unused', runtime: column.id, query: '' }); setAgentFilter('') }}>Show never fired</Button>
              : undefined}
          >
            ≈{total.toLocaleString()} tokens of skill catalogue ride every {column.label} turn
            {neverFired !== null && neverFired> 0
              ? ` — ${neverFired} of its skills never fired in a conversation this desk stores.`
              : '.'}
          </Banner>)}
        </FormStack></div>
      )}

      {kind === 'mcp' && agentFilter && (
        <Text as="p" role="meta">
          {`${rows.length} of ${searched.length} declared by ${agentName ?? 'this Agent'}`}
        </Text>
      )}

      {loading && library === null ? (
        <EmptyState variant="inline" title={kind === 'skill' ? 'Reading skills…' : 'Reading every runtime’s directories…'} />
      ) : rows.length === 0 && (visibleNativeSkills.length > 0 || (showingCatalogueAttention && !screen.query.trim() && screen.filter === 'all' && !agentFilter)) ? null : rows.length === 0 ? (
        !listedEntries.some(entry => entry.kind === kind) && nativeSkills.length === 0 ? <EmptyState icon={<LibraryIcon size={16} />} title={kind === 'skill' ? 'No skills yet' : 'No MCP servers yet'}>
          {kind === 'skill' && <Toolbar>
            <Button size="sm" onClick={() => setFlow({ type: 'author' })}>Write a skill</Button>
            <Button variant="outline" size="sm" onClick={() => setFlow({ type: 'github' })}>From GitHub…</Button>
          </Toolbar>}
        </EmptyState> : kind === 'skill' && screen.chip === 'needs-you' && chipCounts['needs-you'] === 0 && !screen.query.trim() && screen.filter === 'all' && !agentFilter ? (
          <EmptyState tight title="Nothing needs you" />
        ) : <EmptyState tight icon={<SearchIcon size={16} />} title="Nothing matches">
          <Button variant="outline" size="sm" onClick={() => { patchScreen({ query: '', filter: 'all', chip: 'all', runtime: '' }); setAgentFilter('') }}>Clear the filters</Button>
        </EmptyState>
      ) : kind === 'skill' && screen.skillView === 'cards' ? (
        <CompactBoardCardGrid data-slot="skill-cards" layout="catalogue">
          {ordered.map(entry => <SkillCard key={entry.name} entry={entry} columns={columns} onOpen={() => openEntry(entry)} />)}
        </CompactBoardCardGrid>
      ) : kind === 'skill' && screen.skillView === 'list' ? (
        <Rows>{ordered.map(entry => <SkillCard key={entry.name} view="list" entry={entry} columns={columns} onOpen={() => openEntry(entry)} />)}</Rows>
      ) : kind === 'mcp' && screen.view === 'list' ? (
        <SkillList kind={kind}>
          {ordered.map((entry) => (
            <SkillRow
              key={`${entry.kind}:${entry.name}`}
              entry={entry}
              columns={columns}
              onOpen={() => openEntry(entry)}
            />
          ))}
        </SkillList>
      ) : (
        <>
          {/* Above the table, not below it. A seventeen-row grid is taller than
              any window, so a key underneath is a key nobody reaches — and the
              marks it explains are met at the top. */}
          <Legend rows={rows} />
          <LibraryMatrix
            caption={`Each row is one entry; each column is one runtime. A dot means the runtime loads it.${kind === 'skill' && usage !== null ? ` Fired-counts come from the ${usage.sessionsScanned} conversations this desk stores — what ran elsewhere is not counted.` : ''}`}
            columns={columns.map(column => ({ id: column.id, label: column.head, mark: column.info && <RuntimeMark runtime={column.info} size={13} />,
              help: [column.label, attachmentSupportWords(column.info)].filter(Boolean).join(' — ') }))}
            rows={ordered.map(entry => ({ id: `${entry.kind}:${entry.name}`, name: entry.title ?? entry.name, description: entry.description ?? undefined,
              open: () => setOpen(current => current === entry.name ? null : entry.name),
              cells: entry.reach.map((reach, index) => { const label = `${entry.name} — ${columns[index]?.label ?? reach.runtime}: ${REACH_NAME[reach.state]}`
                return { id: reach.runtime, state: reach.state, label, problem: isReachProblem(reach.state), help: reach.note ? `${REACH_NAME[reach.state]} — ${reach.note}` : REACH_NAME[reach.state], mark: <ReachMark state={reach.state} label={label} placement="cell" /> } }),
              expanded: open === entry.name ? <EntryDetail entry={entry} columns={columns} usage={usage} scanOrder={scanOrder} hosts={hosts} home={library?.home} onFlow={setFlow} onRead={() => openEntry(entry)} /> : undefined,
            }))}
            footer={kind === 'skill' ? { label: `Advertised each turn${screen.chip !== 'all' || screen.filter !== 'all' || screen.query.trim() !== '' ? ' (these rows)' : ''}`,
              title: 'Name and description at ≈3.6 characters per token — the catalogue line a runtime carries for every skill it loads, fired or not. How each runtime advertises varies; this prices the standard line.',
              values: Object.fromEntries(columns.map((column, index) => [column.id, rows.reduce((sum, entry) => entry.reach[index]?.state === 'reaches' ? sum + (entry.catalogTokens ?? 0) : sum, 0)])) } : undefined}
            fired={kind === 'skill' && usage !== null ? { label: 'Fired here, ever', title: 'Of the rows on screen, how many this runtime loaded in a conversation this desk stores. Conversations held elsewhere are not counted.',
              values: Object.fromEntries(columns.map(column => [column.id, rows.filter(entry => usage.skills[entry.name]?.byRuntime?.[column.id] !== undefined).length])) } : undefined}
          />
        </>
      )}

      {commandRuntime && visibleNativeSkills.length > 0 && <>
        <SectionHead name="Runtime commands" description={commandRuntime.presentation.name} />
        <RuntimeSkillRows skills={visibleNativeSkills} runtime={commandRuntime.id} onOpen={name => store.openDestination({ kind: 'settings', route: { kind: 'skill', name } })} />
      </>}

      {gaps.length> 0 && gaps.length <= 2 && (
        <div>
          {gaps.map((gap, index) => {
            const runtime = columns.find((one) => one.id === gap.runtime)
            return (
              <Text as="p" role="meta" key={`${gap.runtime}:${gap.kind}:${index}`}>
                <strong>{runtime?.label ?? gap.runtime}</strong> {gap.reason}
              </Text>
            )
          })}
        </div>
      )}
      {gaps.length> 2 && (
        /*
         * Ten agents can produce ten of these sentences, and a wall of
         * near-identical paragraphs teaches the eye to skip the whole block.
         * The fact survives the fold — how many columns are weaker, and one
         * click to read each agent's own reason.
         */
        <details>
          <Text as="summary" role="meta">
            {gaps.length} columns are read from disk rather than from their runtimes — show why
          </Text>
          {gaps.map((gap, index) => {
            const runtime = columns.find((one) => one.id === gap.runtime)
            return (
              <Text as="p" role="meta" key={`${gap.runtime}:${gap.kind}:${index}`}>
                <strong>{runtime?.label ?? gap.runtime}</strong> {gap.reason}
              </Text>
            )
          })}
        </details>
      )}



      {/*
       * The reading surface. Mounted from the page rather than from the card
       * so that a flow opened out of it (install, resolve, remove) unmounts
       * the sheet and leaves the previewed plan alone on screen — two
       * stacked dialogs would put the diff a person is confirming behind the
       * document they were reading.
       */}
      {active && readingEntry?.kind === 'mcp' && flow === null && (
        <McpSheet
          entry={readingEntry}
          columns={columns}
          hosts={hosts}
          cwd={cwd}
          home={library?.home}
          onFlow={(next) => {
            setReading(null)
            setFlow(next)
          }}
          onChanged={() => void load()}
          onClose={() => setReading(null)}
        />
      )}

      <LibraryFlows
        flow={active ? flow : null}
        setFlow={setFlow}
        library={library}
        columns={columns}
        cwd={cwd}
        onApplied={() => void load()}
      />
    </>
  )
}

/**
 * One row, and the detail underneath it.
 *
 * The detail is where the page earns being believed: every copy on disk, its
 * path, and which agents read the directory it is in. A state in the grid is a
 * claim; this is the evidence for it.
 */
const EntryDetail = ({
  entry,
  columns,
  usage,
  scanOrder,
  hosts,
  home,
  onFlow,
  onRead,
}: {
  entry: LibraryEntry
  columns: readonly LibraryColumn[]
  usage: LibraryUsage | null
  scanOrder: ReadonlyMap<RuntimeId, readonly string[]>
  hosts: { readonly skill: ReadonlySet<RuntimeId>; readonly mcp: ReadonlySet<RuntimeId> }
  /** The host's home directory, so a path prints the way it is written. */
  home: string | undefined
  onFlow: (flow: LibraryFlow) => void
  /** Open the full reading surface for this entry. */
  onRead: () => void
}) => {
  /**
   * Which copy an agent actually loads when more than one sits where it
   * looks — project scope over user, then the table's order. What the table
   * says, not what the agent was asked; the chip's tooltip admits it.
   */
  const winnerFor = (runtime: RuntimeId): string | null => {
    const candidates = entry.copies.filter((copy) => !copy.hollow && copy.readBy.includes(runtime))
    if (candidates.length < 2) return null
    for (const root of scanOrder.get(runtime) ?? []) {
      const hit = candidates.find((copy) => isPathInside(copy.path, root))
      if (hit) return hit.path
    }
    return null
  }

  /** For one copy: who loads it first, and whose scan order buries it. */
  const orderOf = (copy: LibraryEntry['copies'][number]): { wins: string[]; shadowed: string[] } => {
    const wins: string[] = []
    const shadowed: string[] = []
    for (const id of copy.readBy) {
      const winner = winnerFor(id)
      if (winner === null) continue
      const label = columns.find((one) => one.id === id)?.label ?? id
      if (winner === copy.path) wins.push(label)
      else shadowed.push(label)
    }
    return { wins, shadowed }
  }

  const hollowCopies = entry.copies.filter((copy) => copy.hollow && !copy.readOnly)
  const digests = new Set(entry.copies.filter((copy) => !copy.hollow).map((copy) => copy.digest))
  const source = installSource(entry)

  /**
   * The agents this entry could be brought to, straight from the cells —
   * unless the copies disagree, in which case *which* content would travel is
   * exactly the open question, and offering Install would answer it silently.
   * Resolve first; the buttons return when there is one truth to install.
   */
  const installable = columns.filter((column, index) => {
    if (entry.kind === 'skill' && digests.size> 1) return false
    const state = entry.reach[index]?.state
    if (state !== 'absent' && state !== 'unscanned') return false
    // Anything can only go where the agent has somewhere to keep it — a
    // skills directory, or a config file for its servers.
    if (entry.kind === 'skill') return source !== null && hosts.skill.has(column.id)
    return entry.copies.length> 0 && hosts.mcp.has(column.id)
  })

  const mcpSource = entry.copies.find((copy) => copy.readBy.length> 0) ?? entry.copies[0]

  return (
    <FormStack>
            <Text as="p" role="meta" ink="secondary">
              {entry.copies.length === 1 ? 'One copy on disk' : `${entry.copies.length} copies on disk`}
            </Text>
            <Rows role="list">
              {entry.copies.map((copy) => {
                const order = orderOf(copy)
                return (
                  <Row key={copy.path} role="listitem" title={<>
                    <Toolbar>
                      <CodeText as="code">{shortPath(copy.path, home)}</CodeText>
                      {order.wins.length> 0 && (
                        <Chip
                          tone="neutral"
                          size="sm"
                          variant="outline"
                          emphasis
                          title="More than one copy sits where this runtime looks; by scan order — project scope over user, per this build’s location table — this one loads. The runtime itself was not asked."
                        >
                          loads for {order.wins.join(', ')}
                        </Chip>
                      )}
                      {order.shadowed.length> 0 && (
                        <Chip
                          tone="neutral"
                          size="sm"
                          variant="outline"
                          title="Another copy sits earlier in this runtime’s scan order, so this one is never loaded there."
                        >
                          shadowed for {order.shadowed.join(', ')}
                        </Chip>
                      )}
                      {entry.kind === 'skill' && !copy.readOnly && (
                        <Button
                          variant="reveal"
                          size="icon-sm"
                          aria-label={`Remove the copy at ${copy.path}`}
                          title="Remove this copy — previewed first, backed up before it goes"
                          onClick={() =>
                            onFlow({
                              type: 'plan',
                              title: `Remove a copy of ${entry.name}`,
                              intents: [{ kind: 'removeCopy', name: entry.name, path: copy.path }],
                            })
                          }
                        >
                          <TrashIcon size={12} />
                        </Button>
                      )}
                      {entry.kind === 'mcp' && (
                        <Button
                          variant="reveal"
                          size="icon-sm"
                          aria-label={`Remove ${entry.name} from ${copy.path}`}
                          title="Remove this declaration — previewed first, backed up before it goes"
                          onClick={() =>
                            onFlow({
                              type: 'plan',
                              title: `Remove ${entry.name}`,
                              intents: [{ kind: 'removeMcp', name: entry.name, path: copy.path }],
                            })
                          }
                        >
                          <TrashIcon size={12} />
                        </Button>
                      )}
                    </Toolbar></>} desc={<Text role="meta">
                      {copy.hollow
                        ? 'No definition inside it — a runtime that scans this directory lists the name and loads nothing.'
                        : copy.readBy.length === 0
                          ? entry.kind === 'mcp'
                            ? 'No runtime reads this file.'
                            : 'No runtime reads this directory.'
                          : `Read by ${copy.readBy
                              .map((id) => columns.find((one) => one.id === id)?.label ?? id)
                              .join(', ')}.`}
                      {copy.readOnly && ' Shipped by the runtime.'}
                    </Text>} />
                )
              })}
            </Rows>
            <Toolbar>
              {/*
               * The drawer peeks — every copy and who reads it, without
               * losing your place in a table of a hundred rows. Reading the
               * definition is a different act and gets the surface built for
               * it, rather than the table growing a second, worse one.
               */}
              <Button variant="outline" size="sm" onClick={onRead}>
                <FileIcon size={13} />
                Read the definition
              </Button>
            </Toolbar>
            {(installable.length> 0 || digests.size> 1 || hollowCopies.length> 0) && (
              <Toolbar>
                {/*
                  * One button per agent reads fine at four agents and turns
                  * into a keyboard row at ten. Past three targets the offer
                  * becomes one previewed plan with an op per agent — the
                  * preview still names every target, and apply is still
                  * per-op, so a refusal for one agent never blocks the rest.
                  */}
                {installable.length> 3 ? (
                  entry.kind === 'skill' && source !== null ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        onFlow({
                          type: 'plan',
                          title: `Install ${entry.name} for ${installable.length} runtimes`,
                          intents: installable.map((column) => ({
                            kind: 'installSkill' as const,
                            name: entry.name,
                            sourcePath: source.path,
                            targetRuntime: column.id,
                          })),
                        })
                      }
                    >
                      Install to all {installable.length} missing…
                    </Button>
                  ) : entry.kind === 'mcp' && mcpSource ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        onFlow({
                          type: 'plan',
                          title: `Add ${entry.name} to ${installable.length} runtimes`,
                          intents: installable.map((column) => ({
                            kind: 'installMcp' as const,
                            name: entry.name,
                            sourcePath: mcpSource.path,
                            targetRuntime: column.id,
                          })),
                        })
                      }
                    >
                      Add to all {installable.length} missing…
                    </Button>
                  ) : null
                ) : (
                  installable.map((column) =>
                  entry.kind === 'skill' && source !== null ? (
                    <Button
                      key={column.id}
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        onFlow({
                          type: 'plan',
                          title: `Install ${entry.name} for ${column.label}`,
                          intents: [
                            {
                              kind: 'installSkill',
                              name: entry.name,
                              sourcePath: source.path,
                              targetRuntime: column.id,
                            },
                          ],
                        })
                      }
                    >
                      Install to {column.label}
                    </Button>
                  ) : entry.kind === 'mcp' && mcpSource ? (
                    <Button
                      key={column.id}
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        onFlow({
                          type: 'plan',
                          title: `Add ${entry.name} to ${column.label}`,
                          intents: [
                            {
                              kind: 'installMcp',
                              name: entry.name,
                              sourcePath: mcpSource.path,
                              targetRuntime: column.id,
                            },
                          ],
                        })
                      }
                    >
                      Add to {column.label}
                    </Button>
                  ) : null,
                  )
                )}
                {entry.kind === 'skill' && digests.size> 1 && (
                  <Button variant="outline" size="sm" onClick={() => onFlow({ type: 'resolve', entry })}>
                    Resolve copies…
                  </Button>
                )}
                {entry.kind === 'skill' && hollowCopies.length> 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      onFlow({
                        type: 'plan',
                        title: `Clean up empty copies of ${entry.name}`,
                        intents: hollowCopies.map((copy) => ({
                          kind: 'removeCopy' as const,
                          name: entry.name,
                          path: copy.path,
                        })),
                      })
                    }
                  >
                    Clean up empty {hollowCopies.length === 1 ? 'copy' : 'copies'}
                  </Button>
                )}
              </Toolbar>
            )}
            {entry.kind === 'skill' && (
              <MetaList>
                <span>
                  {entry.catalogTokens
                    ? `Catalogue ≈${entry.catalogTokens} tok/turn`
                    : 'No catalogue line to price'}
                </span>
                {usage !== null &&
                  (() => {
                    const fired = usage.skills[entry.name]
                    if (!fired) {
                      return (
                        <span>
                          Never fired in a conversation this desk stores
                        </span>
                      )
                    }
                    // The split names today's columns; what was recorded
                    // under a registration that no longer exists is shown as
                    // the remainder, never silently dropped — a per-agent
                    // number that omits part of the total is a lie shaped
                    // like precision.
                    const parts: string[] = []
                    let attributed = 0
                    for (const column of columns) {
                      const bucket = fired.byRuntime?.[column.id]
                      if (!bucket) continue
                      attributed += bucket.activations
                      parts.push(`${bucket.activations}× ${column.label}`)
                    }
                    const rest = fired.activations - attributed
                    if (rest> 0) parts.push(`${rest}× under earlier registrations`)
                    return (
                      <>
                        <span>
                          Fired {fired.activations}×{' '}
                          {`in ${fired.sessions} ${fired.sessions === 1 ? 'conversation' : 'conversations'}`}
                          {parts.length> 0 ? ` (${parts.join(', ')})` : ''}
                        </span>
                        {fired.lastAt> 0 && (
                          <span>
                            Last {new Date(fired.lastAt).toLocaleDateString()}
                          </span>
                        )}
                      </>
                    )
                  })()}
              </MetaList>
            )}
            {entry.reach.some((reach) => reach.note) && (
              <FormStack>
                {entry.reach
                  .filter((reach) => reach.note)
                  .map((reach) => (
                    <div role="listitem" key={reach.runtime}>
                      <Text role="meta" ink="secondary">
                        <strong>
                          {columns[entry.reach.indexOf(reach)]?.label ?? reach.runtime}
                        </strong>
                        {' \u2014 '}
                        {reach.note}
                      </Text>
                    </div>
                  ))}
              </FormStack>
            )}
    </FormStack>
  )
}
