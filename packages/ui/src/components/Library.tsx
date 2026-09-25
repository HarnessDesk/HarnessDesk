import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
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
} from '@harnessdesk/protocol'

import { runtimeLabel } from '../lib/accounts'
import { isPathInside } from '../lib/paths'
import { useSnapshot, useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import {
  AlertIcon,
  CrossIcon,
  DiffIcon,
  FileIcon,
  FilterIcon,
  ImportIcon,
  LibraryIcon,
  MatrixIcon,
  PlusIcon,
  RetryIcon,
  RowsLooseIcon,
  SearchIcon,
  TrashIcon,
} from './Icons'
import {
  ActionError,
  Alert,
  Chip,
  CodeText,
  LibraryReachMark,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MetaList,
  PageHead,
  PanelPill,
  Popover,
  Search,
  Segmented,
  Submenu,
  Text,
  Toolbar,
} from '../design'
import {
  Button,
  EmptyState,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '../design'
import {
  installSource,
  LibraryFlows,
  LibraryHistory,
  type LibraryColumn,
  type LibraryFlow,
} from './LibraryActions'
import { SkillList, SkillRow } from './SkillRow'
import { SkillSheet } from './SkillSheet'
import { shortPath } from '../lib/paths'
import { REACH_NAME } from '../lib/reach-states'
import styles from './Library.module.css'

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
 * landed. What happened here is listed at the foot of the page, from the
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

type Filter =
  | 'all'
  | 'problems'
  | 'partial'
  | 'hollow'
  | 'differs'
  | 'unreachable'
  | 'unused'
  | 'off'


/**
 * The mark for one state.
 *
 * Shape carries the meaning and colour only reinforces it, so the table reads
 * the same to anyone who does not separate red from green. `absent` is a rule,
 * not a glyph: nothing is wrong, and a symbol there would compete with the
 * ones that mean something.
 */
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
      <Text as="p" role="meta" className={styles.legend}>
        {present.map((state) => (
          <span key={state} className={styles.legendItem}>
            <LibraryReachMark state={state} label={REACH_NAME[state]} />
            {REACH_NAME[state]}
          </span>
        ))}
      </Text>
    </div>
  )
}

/*
 * The kind switcher and the list/matrix switch are the system's `Segmented`,
 * the same control as the import dialog's agent pickers: a `ToggleGroup`
 * underneath, because a Base UI tab activates on `mousedown`, which a plain
 * `element.click()` never fires, and these have to answer to tests and
 * keyboards alike.
 */

/**
 * One count, which is also the filter that isolates it.
 *
 * Five shapes, in order. Six dashboard tiles, which promised a *metric* when
 * every one of them is a filter; outlined pills; the app's outlined `Button`;
 * then the inspectors' filter pill, a second line of controls under a toolbar
 * that already wrapped its own view switch onto a line of its own — three
 * rows of controls before the first skill.
 *
 * Now each is a row of the toolbar's one Filter menu: its words, and its count
 * where a menu keeps a value, on tabular figures. A count of none is not
 * offered — a row that would empty the list is not a choice — except the one
 * that is on, which stays so it can be seen and left. The set is one answer
 * (radio rows). Amber stays on the number of a problem, never the row.
 */
const FilterRow = ({
  value,
  label,
  tone,
  title,
  active,
  onSelect,
}: {
  value: number
  label: string
  tone?: 'warn'
  title?: string
  active: boolean
  onSelect: () => void
}) =>
  value === 0 && !active ? null : (
    <MenuItem
      label={label}
      {...(title ? { title } : {})}
      selected={active}
      value={(
        <Text role="meta" numeric {...(tone === 'warn' && value > 0 ? { tone: 'warning' as const } : {})}>
          {value}
        </Text>
      )}
      onSelect={onSelect}
    />
  )

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

export const LibrarySection = ({ initialFlow = null }: { initialFlow?: 'import' | null } = {}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [library, setLibrary] = useState<Library | null>(null)
  const [usage, setUsage] = useState<LibraryUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState<string | null>(null)
  const [kind, setKind] = useState<LibraryKind>('skill')
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  /**
   * List or matrix.
   *
   * The list is the default because the question people bring to this page is
   * "what can my agents do" — the question both Claude's and Codex's skills
   * pages are built entirely around, and the one this page could not answer
   * at all. The matrix answers the other question, the one no other app can
   * touch (*does this reach all four agents?*), and it stays one press away
   * rather than being the front door. Losing it was never on the table: at a
   * hundred skills across ten agents, a grid of cards is the wrong tool and
   * the table is the right one.
   */
  const [view, setView] = useState<'list' | 'matrix'>('list')
  /** The entry whose sheet is open — the reading surface, by name. */
  const [reading, setReading] = useState<string | null>(null)
  const [flow, setFlow] = useState<LibraryFlow | null>(
    initialFlow === 'import' ? { type: 'import' } : null,
  )
  /** `''` is every Agent; otherwise `${origin}:${id}` of one on the current roster. */
  const [agentFilter, setAgentFilter] = useState('')
  /** `${kind}:${name}` -> every Agent (winner, never a shadowed origin) that declared it. Bounded to the visible roster — never a background scan of every repository. */
  const [declaredBy, setDeclaredBy] = useState<ReadonlyMap<string, readonly { readonly id: string; readonly origin: AgentOrigin; readonly label: string }[]> | null>(null)

  const cwd = snapshot.workspace?.path

  const load = useCallback(async () => {
    setLoading(true)
    setFailed(null)
    try {
      setLibrary(await store.transport.request('library/read', cwd ? { cwd } : {}))
      // Usage arrives second and never blocks the matrix: the first read
      // walks every stored conversation, and the page has plenty to say
      // while it does.
      void store.transport
        .request('library/usage', {})
        .then(setUsage)
        .catch(() => setUsage(null))
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [cwd, store])

  useEffect(() => {
    void load()
  }, [load])

  // The Agent filter's own roster — the same guarded, cached read every other
  // Agent picker in the app uses (`CommandPalette`), never a fresh load per
  // render of this page.
  useEffect(() => {
    if (snapshot.agents === null) void store.loadAgents()
  }, [store, snapshot.agents])

  /**
   * What each Agent on the visible roster declares, resolved once per
   * roster change — never per keystroke or per filter press, and never a
   * scan of every repository this machine has ever opened. A shadowed
   * origin never contributes here: `snapshot.agents` already names only the
   * winner for each id, the same roster the Agents window itself lists.
   */
  useEffect(() => {
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
  }, [store, snapshot.agents])

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

  /**
   * The kind on screen, narrowed by what is typed in the search box — and
   * nothing else. Everything the strip counts and everything the list shows
   * is drawn from this one set.
   */
  const searched = useMemo(() => {
    if (!library) return []
    const needle = query.trim().toLowerCase()
    return library.entries.filter(
      (entry) =>
        entry.kind === kind &&
        (needle === '' || `${entry.name} ${entry.title ?? ''}`.toLowerCase().includes(needle)),
    )
  }, [library, kind, query])

  /**
   * Summarised over the kind on screen *and* the search, not the whole
   * library.
   *
   * The kind half was always right — a tile saying 86 above a table filtered
   * to 80 reads as a bug. The search half was not: with `db` typed, the strip
   * went on saying "2 reach none" from the whole library, and pressing that
   * chip — which is what a chip is for — narrowed to *nothing*, because the
   * two rows it counted were not among the ones the search had left. A count
   * that does not survive being pressed is the same defect the `everywhere`
   * tile was retired for, and a tooltip cannot repair it either.
   */
  const counts = useMemo(
    () => (library ? summarise({ ...library, entries: searched }) : null),
    [library, searched],
  )

  const rows = useMemo(() => {
    return searched.filter((entry) => {
      if (agentFilter) {
        // Declarations, not measured reach: a name this Agent declared stays
        // in the filtered set even when no runtime has resolved it yet
        // (decision: "retain unresolved rows"). Reach is a separate column,
        // read from `entry.reach` exactly as it always was.
        const refs = declaredBy?.get(`${entry.kind}:${entry.name}`) ?? []
        if (!refs.some((ref) => `${ref.origin}:${ref.id}` === agentFilter)) return false
      }
      if (filter === 'problems') return entryHasProblem(entry)
      if (filter === 'partial') {
        const reaching = entry.reach.filter((one) => one.state === 'reaches').length
        return reaching > 0 && reaching < entry.reach.length
      }
      if (filter === 'hollow') return entry.copies.some((copy) => copy.hollow)
      if (filter === 'differs') {
        const digests = new Set(entry.copies.filter((one) => !one.hollow).map((one) => one.digest))
        return digests.size > 1
      }
      if (filter === 'unreachable') return entry.reach.every((one) => one.state !== 'reaches')
      if (filter === 'off') return entry.reach.some((one) => one.state === 'off')
      if (filter === 'unused') {
        return (
          usage !== null &&
          entry.reach.some((one) => one.state === 'reaches') &&
          usage.skills[entry.name] === undefined
        )
      }
      return true
    })
  }, [searched, filter, usage, agentFilter, declaredBy])

  /**
   * The never-fired view is a to-do list, and a to-do list leads with what
   * matters most: the row paying the most tokens for nothing. Everywhere
   * else the order stays alphabetical, because those views are scanned by
   * name.
   */
  const ordered = useMemo(
    () =>
      filter === 'unused'
        ? [...rows].sort(
            (a, b) => (b.catalogTokens ?? 0) - (a.catalogTokens ?? 0) || a.name.localeCompare(b.name),
          )
        : rows,
    [rows, filter],
  )

  /**
   * Skills that reach at least one agent and have never fired in a stored
   * conversation. The join the whole page builds to: advertised is paid for
   * every turn, and this is the set paying for nothing — as far as this
   * desk's own record can see, which is what the tile's label says.
   */
  const unusedCount = useMemo(() => {
    if (!usage) return 0
    // Over `searched`, for the same reason the strip beside it is: this chip
    // is a filter, and a filter's number has to be the number of rows it
    // will leave on screen.
    return searched.filter(
      (entry) =>
        entry.kind === 'skill' &&
        entry.reach.some((one) => one.state === 'reaches') &&
        usage.skills[entry.name] === undefined,
    ).length
  }, [searched, usage])

  const kindCounts = useMemo(
    () => ({
      skill: library?.entries.filter((entry) => entry.kind === 'skill').length ?? 0,
      mcp: library?.entries.filter((entry) => entry.kind === 'mcp').length ?? 0,
    }),
    [library],
  )

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

  /**
   * The entry the sheet is showing, looked up by name every render rather
   * than held as an object. An apply re-reads the library; a sheet holding
   * the old object would keep showing the state from before the write it
   * just made, which is the one moment its facts most need to be current.
   */
  const readingEntry = useMemo(
    () => library?.entries.find((one) => one.kind === kind && one.name === reading) ?? null,
    [library, kind, reading],
  )

  /** Only the gaps that apply to what is on screen; the rest are noise here. */
  const gaps = (library?.gaps ?? []).filter((gap) => gap.kind === kind)

  const filterTrigger = useRef<HTMLButtonElement>(null)
  /** Over `searched`, like every count in the menu: the rows choosing it will leave. */
  const problemCount = useMemo(() => searched.filter(entryHasProblem).length, [searched])
  const agentName = agentFilter
    ? (snapshot.agents?.find((entry) => `${entry.origin}:${entry.id}` === agentFilter)?.definition?.name ?? null)
    : null

  return (
    <>
      <PageHead
        title="Library"
        /*
         * The blurb used to open on the safety machinery — previews, backups,
         * the audit log. All true, all reassuring, and all answers to a
         * question nobody has yet on their first read of a page. It now says
         * what the page is *for* first and keeps the guarantee as the second
         * clause, where a promise about writes belongs.
         */
        blurb="Every skill and MCP server your agents can load, wherever each one keeps them."
        actions={
          <>
            <Button variant="default" onClick={() => setFlow({ type: 'author' })} disabled={library === null}>
              <PlusIcon size={13} />
              New skill
            </Button>
            <Button variant="outline" onClick={() => setFlow({ type: 'import' })} disabled={library === null}>
              <ImportIcon size={13} />
              Import
            </Button>
            <Button variant="outline" onClick={() => void load()} disabled={loading}>
              <RetryIcon size={13} />
              Rescan
            </Button>
          </>
        }
      />

      {failed !== null && <ActionError>The library could not be read: {failed}</ActionError>}

      {kind === 'skill' && (hollowCopies.length > 0 || overloaded.length > 0) && (
        /* The page's callout: the system's neutral alert, one line per thing
           that needs a hand, each with its amber mark and its way out. */
        <Alert data-slot="library-attention" className="mb-4 flex-col gap-1">
          {hollowCopies.length > 0 && (
            <p className="m-0 flex w-full items-center gap-2">
              <Text tone="warning" className="flex-none">
                <AlertIcon size={13} />
              </Text>
              <Text role="muted" className="min-w-0 flex-1">
                {hollowCopies.length} {hollowCopies.length === 1 ? 'directory holds' : 'directories hold'} a
                skill’s name and no definition — an agent that scans them lists the name and loads
                nothing.
              </Text>
              <Button
                variant="outline"
                size="sm"
                className="flex-none"
                onClick={() =>
                  setFlow({
                    type: 'plan',
                    title: 'Clean up empty skill directories',
                    intents: hollowCopies.map((copy) => ({
                      kind: 'removeCopy' as const,
                      name: copy.name,
                      path: copy.path,
                    })),
                  })
                }
              >
                Clean up…
              </Button>
            </p>
          )}
          {overloaded.map(({ column, total, neverFired }) => (
            <p key={column.id} className="m-0 flex w-full items-center gap-2">
              <Text tone="warning" className="flex-none">
                <AlertIcon size={13} />
              </Text>
              <Text role="muted" className="min-w-0 flex-1">
                ≈{total.toLocaleString()} tokens of skill catalogue ride every {column.label} turn
                {neverFired !== null && neverFired > 0
                  ? ` — ${neverFired} of its skills never fired in a conversation this desk stores.`
                  : '.'}
              </Text>
              {neverFired !== null && neverFired > 0 && (
                <Button variant="outline" size="sm" className="flex-none" onClick={() => setFilter('unused')}>
                  Show never fired
                </Button>
              )}
            </p>
          ))}
        </Alert>
      )}

      {/*
       * One row: what is listed, a search, the filter menu and how to show it.
       * The view switch used to wrap onto a line of its own and six count
       * pills took a third; the counts are the Filter menu's rows now, and
       * the Agent picker is its submenu, so the toolbar fits the page.
       */}
      <Toolbar className="mb-3" data-slot="library-toolbar">
        <Segmented
          label="What the library is listing"
          value={kind}
          options={[
            { value: 'skill', label: `Skills · ${kindCounts.skill}` },
            { value: 'mcp', label: `MCP servers · ${kindCounts.mcp}` },
          ]}
          onChange={(next) => {
            setKind(next)
            setOpen(null)
          }}
        />
        {/* Wide enough to type a skill name into, and capped: a text input's
            size is a claim about how much you type in it. */}
        <Search
          className="min-w-0 flex-1 basis-44 md:max-w-64"
          value={query}
          placeholder={kind === 'skill' ? 'Search skills' : 'Search servers'}
          label="Filter the library by name"
          onChange={setQuery}
        />
        {/* The filters and the view travel together at the row's end. When
            the page is too narrow for one row, the pills wrap inside this
            group, and Filter and List | Matrix wrap as one pair — so the view
            switch is never left on a line of its own, and nothing is clipped. */}
        <Toolbar className="ml-auto min-w-0 justify-end">
          {/* What narrows the list right now, each a pressed pill that lets go
              of it — the inspectors' filter pill, so a filter that is on looks
              the same wherever it is on. Letting go hands the focus to Filter,
              where the next choice is made, rather than to the top of the page. */}
          {filter !== 'all' && (
            <PanelPill pressed title="Show everything again" onClick={() => { setFilter('all'); filterTrigger.current?.focus() }}>
              {FILTER_WORDS[filter]}
            </PanelPill>
          )}
          {agentName && (
            <PanelPill pressed title="Show what every Agent declares" onClick={() => { setAgentFilter(''); filterTrigger.current?.focus() }}>
              {agentName}
            </PanelPill>
          )}
          <Toolbar className="flex-nowrap">
            <Popover
              label={(
                <>
                  <FilterIcon size={13} />
                  <span>Filter</span>
                  {/* The one piece of news the menu holds, at rest: how many have a
                      problem, in the problem's amber, until a filter is chosen. */}
                  {filter === 'all' && problemCount > 0 && (
                    <Text role="meta" numeric tone="warning">{problemCount}</Text>
                  )}
                </>
              )}
              title={filter === 'all' && problemCount > 0 ? `Filter the library — ${problemCount} with a problem` : 'Filter the library'}
              align="right"
              triggerVariant={{ variant: 'outline' }}
              triggerRef={filterTrigger}
            >
              {(close) => (
                <Menu close={close}>
                  <MenuLabel>Show</MenuLabel>
                  {counts ? (
                    <>
                      <FilterRow value={counts.total} label={FILTER_WORDS.all} active={filter === 'all'} onSelect={() => setFilter('all')} />
                      <FilterRow value={problemCount} label={FILTER_WORDS.problems} tone="warn" title="Anything wrong: reaches no agent, empty on disk, or copies that differ." active={filter === 'problems'} onSelect={() => setFilter('problems')} />
                      <FilterRow value={counts.partial} label={FILTER_WORDS.partial} active={filter === 'partial'} onSelect={() => setFilter('partial')} />
                      <FilterRow value={counts.unreachable} label={FILTER_WORDS.unreachable} tone="warn" active={filter === 'unreachable'} onSelect={() => setFilter('unreachable')} />
                      <FilterRow value={counts.hollow} label={FILTER_WORDS.hollow} tone="warn" active={filter === 'hollow'} onSelect={() => setFilter('hollow')} />
                      <FilterRow value={counts.differs} label={FILTER_WORDS.differs} tone="warn" active={filter === 'differs'} onSelect={() => setFilter('differs')} />
                      {/* No warn tone: a switch somebody threw is not a defect. */}
                      <FilterRow
                        value={counts.off}
                        label={FILTER_WORDS.off}
                        title="Installed in an agent and turned off in its own settings, so nothing loads it there."
                        active={filter === 'off'}
                        onSelect={() => setFilter('off')}
                      />
                      {kind === 'skill' &&
                        (usage !== null ? (
                          <FilterRow
                            value={unusedCount}
                            label={FILTER_WORDS.unused}
                            title={`Reaches at least one agent, and none of the ${usage.sessionsScanned} conversations this desk stores shows it loading. What ran elsewhere is not counted.`}
                            active={filter === 'unused'}
                            onSelect={() => setFilter('unused')}
                          />
                        ) : (
                          /* The first usage read walks every stored conversation,
                             so this row arrives late; it holds its place. */
                          <MenuItem label={FILTER_WORDS.unused} disabled="Counting activations in the stored conversations…" onSelect={() => {}} />
                        ))}
                    </>
                  ) : (
                    <MenuItem label={FILTER_WORDS.all} disabled="Reading every agent’s directories…" onSelect={() => {}} />
                  )}
                  {snapshot.agents && snapshot.agents.length > 0 && (
                    <>
                      <MenuSeparator />
                      <Submenu label="Declared by" value={agentName ?? 'Any Agent'}>
                        <MenuItem label="Any Agent" selected={agentFilter === ''} onSelect={() => setAgentFilter('')} />
                        {snapshot.agents.map((entry) => (
                          <MenuItem
                            key={`${entry.origin}:${entry.id}`}
                            label={entry.definition?.name ?? entry.id}
                            selected={agentFilter === `${entry.origin}:${entry.id}`}
                            onSelect={() => setAgentFilter(`${entry.origin}:${entry.id}`)}
                          />
                        ))}
                      </Submenu>
                    </>
                  )}
                </Menu>
              )}
            </Popover>
            {/*
             * Two ways to read the same list, and the switch says which by
             * drawing it — and by naming it: a glyph with its name only in a
             * tooltip is a control you have to hover to read.
             */}
            <Segmented
              label="How to show the library"
              value={view}
              options={[
                { value: 'list', label: <><RowsLooseIcon size={13} />List</> },
                { value: 'matrix', label: <><MatrixIcon size={13} />Matrix</> },
              ]}
              onChange={(next) => {
                setView(next)
                setOpen(null)
              }}
            />
          </Toolbar>
        </Toolbar>
      </Toolbar>

      {agentFilter && (
        <Text as="p" role="meta" className="mb-2">
          {`${rows.length} of ${searched.length} declared by ${agentName ?? 'this Agent'}`}
        </Text>
      )}

      {loading && library === null ? (
        <EmptyState variant="inline" title="Reading every agent’s directories…" />
      ) : rows.length === 0 ? (
        /*
         * An empty list is two different situations and the old sentence
         * covered both with "Nothing matches." A filter that found nothing
         * wants its filter cleared; a machine with no skills on it wants to
         * be told how to get one. Answering the second with the first is how
         * a first run reads as a broken page.
         */
        query.trim() !== '' || filter !== 'all' ? (
          <EmptyState
            tight
            icon={<SearchIcon size={16} />}
            title="Nothing matches"
            /*
             * Which of the two narrowings emptied the list, said correctly
             * when both are on. Reading the query first blamed the search box
             * for a state filter's doing — with `db` typed and "reach none"
             * pressed, a page holding a skill called db-migrations announced
             * that nothing here is called db-migrations.
             */
            description={
              query.trim() !== '' && filter !== 'all'
                ? searched.length > 0
                  ? `${searched.length} ${searched.length === 1 ? 'entry matches' : 'entries match'} “${query.trim()}”, and none of them is in that state.`
                  : `No ${kind === 'skill' ? 'skill' : 'server'} here is called “${query.trim()}”.`
                : query.trim() !== ''
                  ? `No ${kind === 'skill' ? 'skill' : 'server'} here is called “${query.trim()}”.`
                  : 'No entry is in that state right now.'
            }
          >
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setQuery('')
                setFilter('all')
              }}
            >
              Clear the filters
            </Button>
          </EmptyState>
        ) : (
          <EmptyState
            icon={<LibraryIcon size={16} />}
            title={kind === 'skill' ? 'No skills on this machine yet' : 'No MCP servers declared yet'}
            description={
              kind === 'skill'
                ? 'A skill is a folder with a SKILL.md in it that an agent reads before it starts. Write one here, or bring across the ones an agent already has.'
                : 'Nothing was found in any configuration file this build knows how to read.'
            }
          >
            {kind === 'skill' && (
              <div className="flex flex-wrap justify-center gap-2">
                <Button size="sm" onClick={() => setFlow({ type: 'author' })}>
                  <PlusIcon size={13} />
                  Write a skill
                </Button>
                <Button variant="outline" size="sm" onClick={() => setFlow({ type: 'import' })}>
                  <ImportIcon size={13} />
                  Import
                </Button>
              </div>
            )}
          </EmptyState>
        )
      ) : view === 'list' ? (
        <SkillList>
          {ordered.map((entry) => (
            <SkillRow
              key={`${entry.kind}:${entry.name}`}
              entry={entry}
              columns={columns}
              onOpen={() => setReading(entry.name)}
            />
          ))}
        </SkillList>
      ) : (
        <>
          {/* Above the table, not below it. A seventeen-row grid is taller than
              any window, so a key underneath is a key nobody reaches — and the
              marks it explains are met at the top. */}
          <Legend rows={rows} />
          <Table variant="framed" containerClassName={styles.scroll} className={styles.grid}>
            <TableCaption variant="sr-only">
              Each row is one entry; each column is one agent. A dot means the agent loads it.
              {kind === 'skill' &&
                usage !== null &&
                ` Fired-counts come from the ${usage.sessionsScanned} conversations this desk stores — what ran elsewhere is not counted.`}
            </TableCaption>
            <TableHeader>
              <TableRow variant="matrix">
                <TableHead variant="matrix" pinned scope="col" className={styles.nameHead}>
                  <Text role="muted">Name</Text>
                </TableHead>
                {columns.map((column) => (
                  <TableHead
                    variant="matrix"
                    align="center"
                    scope="col"
                    key={column.id}
                    className={styles.agentHead}
                  >
                    <Text
                      role="muted"
                      className={styles.agentName}
                      title={[column.label, attachmentSupportWords(column.info)].filter(Boolean).join(' — ')}
                      truncate
                    >
                      {column.info && <RuntimeMark runtime={column.info} size={13} />}
                      {column.head}
                    </Text>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            {kind === 'skill' && (
              <TableFooter variant="plain">
                <TableRow variant="matrix">
                  {/* Summed over the rows on screen, so the number under a
                      filtered table is true of that table — the tile lesson,
                      applied before it is relearned. */}
                  <TableHead
                    variant="footer"
                    scope="row"
                    title="Name and description at ≈3.6 characters per token — the catalogue line an agent carries for every skill it loads, fired or not. How each agent advertises varies; this prices the standard line."
                  >
                    Advertised each turn{filter !== 'all' || query.trim() !== '' ? ' (these rows)' : ''}
                  </TableHead>
                  {columns.map((column, index) => {
                    const total = rows.reduce(
                      (sum, entry) =>
                        entry.reach[index]?.state === 'reaches' && entry.catalogTokens
                          ? sum + entry.catalogTokens
                          : sum,
                      0,
                    )
                    return (
                      <TableCell variant="footer" key={column.id}>
                        {total > 0 ? `≈${total.toLocaleString()} tok` : '—'}
                      </TableCell>
                    )
                  })}
                </TableRow>
                {usage !== null && (
                  <TableRow variant="matrix">
                    <TableHead
                      variant="footer"
                      scope="row"
                      title="Of the rows on screen, how many this agent loaded in a conversation this desk stores. Conversations held elsewhere are not counted."
                    >
                      Fired here, ever
                    </TableHead>
                    {columns.map((column) => {
                      const fired = rows.filter(
                        (entry) => usage.skills[entry.name]?.byRuntime?.[column.id] !== undefined,
                      ).length
                      return (
                        <TableCell variant="footer" key={column.id}>
                          {fired > 0 ? `${fired} of ${rows.length}` : '—'}
                        </TableCell>
                      )
                    })}
                  </TableRow>
                )}
              </TableFooter>
            )}
            <TableBody>
              {ordered.map((entry) => (
                <Entry
                  key={`${entry.kind}:${entry.name}`}
                  entry={entry}
                  columns={columns}
                  usage={usage}
                  scanOrder={scanOrder}
                  hosts={hosts}
                  home={library?.home}
                  onFlow={setFlow}
                  onRead={() => setReading(entry.name)}
                  open={open === entry.name}
                  onToggle={() => setOpen((current) => (current === entry.name ? null : entry.name))}
                />
              ))}
            </TableBody>
          </Table>
        </>
      )}

      {gaps.length > 0 && gaps.length <= 2 && (
        <div className={styles.gaps}>
          {gaps.map((gap, index) => {
            const runtime = columns.find((one) => one.id === gap.runtime)
            return (
              <Text as="p" role="meta" key={`${gap.runtime}:${gap.kind}:${index}`} className={styles.gap}>
                <strong>{runtime?.label ?? gap.runtime}</strong> {gap.reason}
              </Text>
            )
          })}
        </div>
      )}
      {gaps.length > 2 && (
        /*
         * Ten agents can produce ten of these sentences, and a wall of
         * near-identical paragraphs teaches the eye to skip the whole block.
         * The fact survives the fold — how many columns are weaker, and one
         * click to read each agent's own reason.
         */
        <details className={styles.gaps}>
          <Text as="summary" role="meta" className={styles.gapsFold}>
            {gaps.length} columns are read from disk rather than from their agents — show why
          </Text>
          {gaps.map((gap, index) => {
            const runtime = columns.find((one) => one.id === gap.runtime)
            return (
              <Text as="p" role="meta" key={`${gap.runtime}:${gap.kind}:${index}`} className={styles.gap}>
                <strong>{runtime?.label ?? gap.runtime}</strong> {gap.reason}
              </Text>
            )
          })}
        </details>
      )}

      <LibraryHistory
        refreshedAt={library?.generatedAt ?? 0}
        home={library?.home}
        onFlow={setFlow}
      />

      {/*
       * The reading surface. Mounted from the page rather than from the card
       * so that a flow opened out of it (install, resolve, remove) unmounts
       * the sheet and leaves the previewed plan alone on screen — two
       * stacked dialogs would put the diff a person is confirming behind the
       * document they were reading.
       */}
      {readingEntry && flow === null && (
        <SkillSheet
          entry={readingEntry}
          columns={columns}
          usage={usage}
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
        flow={flow}
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
const Entry = ({
  entry,
  columns,
  usage,
  scanOrder,
  hosts,
  home,
  onFlow,
  onRead,
  open,
  onToggle,
}: {
  entry: LibraryEntry
  columns: readonly LibraryColumn[]
  usage: LibraryUsage | null
  scanOrder: ReadonlyMap<RuntimeId, readonly string[]>
  hosts: { readonly skill: ReadonlySet<RuntimeId>; readonly mcp: ReadonlySet<RuntimeId> }
  /** The host's home directory, so a path prints the way it is written. */
  home: string | undefined
  onFlow: (flow: LibraryFlow) => void
  /** Open the full reading surface — the same sheet a card opens. */
  onRead: () => void
  open: boolean
  onToggle: () => void
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
    if (entry.kind === 'skill' && digests.size > 1) return false
    const state = entry.reach[index]?.state
    if (state !== 'absent' && state !== 'unscanned') return false
    // Anything can only go where the agent has somewhere to keep it — a
    // skills directory, or a config file for its servers.
    if (entry.kind === 'skill') return source !== null && hosts.skill.has(column.id)
    return entry.copies.length > 0 && hosts.mcp.has(column.id)
  })

  const mcpSource = entry.copies.find((copy) => copy.readBy.length > 0) ?? entry.copies[0]

  return (
    <>
      <TableRow variant="matrix" interactive {...(open ? { 'data-state': 'selected' } : {})}>
        <TableHead variant="row" pinned scope="row" className={styles.name}>
          <Button
            type="button"
            variant="link"
            size="content"
            className={styles.nameButton}
            onClick={onToggle}
            aria-expanded={open}
          >
            <Text role="navigation">{entry.title ?? entry.name}</Text>
            {entry.description && <Text role="meta" truncate>{entry.description}</Text>}
          </Button>
        </TableHead>
        {entry.reach.map((reach, index) => {
          const runtime = columns[index]
          const label = `${entry.name} — ${runtime?.label ?? reach.runtime}: ${REACH_NAME[reach.state]}`
          return (
            <TableCell
              variant="matrix"
              key={reach.runtime}
              data-state={reach.state}
              {...(isReachProblem(reach.state) ? { 'data-problem': '' } : {})}
              title={reach.note ? `${REACH_NAME[reach.state]} — ${reach.note}` : REACH_NAME[reach.state]}
            >
              <LibraryReachMark state={reach.state} label={label} placement="cell" />
            </TableCell>
          )
        })}
      </TableRow>
      {open && (
        <TableRow variant="matrix">
          <TableCell variant="detail" colSpan={columns.length + 1}>
            <div className={styles.detailBody}>
            <Text as="p" role="meta" ink="secondary" className={styles.detailHead}>
              {entry.copies.length === 1 ? 'One copy on disk' : `${entry.copies.length} copies on disk`}
            </Text>
            <div className={styles.copies} role="list">
              {entry.copies.map((copy) => {
                const order = orderOf(copy)
                return (
                  <div key={copy.path} role="listitem" className={`${styles.copy} group/copy`}>
                    <span className={styles.copyLine}>
                      <CodeText as="code">{shortPath(copy.path, home)}</CodeText>
                      {order.wins.length > 0 && (
                        <Chip
                          tone="neutral"
                          size="sm"
                          variant="outline"
                          emphasis
                          title="More than one copy sits where this agent looks; by scan order — project scope over user, per this build’s location table — this one loads. The agent itself was not asked."
                        >
                          loads for {order.wins.join(', ')}
                        </Chip>
                      )}
                      {order.shadowed.length > 0 && (
                        <Chip
                          tone="neutral"
                          size="sm"
                          variant="outline"
                          title="Another copy sits earlier in this agent’s scan order, so this one is never loaded there."
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
                    </span>
                    <Text role="meta">
                      {copy.hollow
                        ? 'No definition inside it — an agent that scans this directory lists the name and loads nothing.'
                        : copy.readBy.length === 0
                          ? entry.kind === 'mcp'
                            ? 'No agent reads this file.'
                            : 'No agent reads this directory.'
                          : `Read by ${copy.readBy
                              .map((id) => columns.find((one) => one.id === id)?.label ?? id)
                              .join(', ')}.`}
                      {copy.readOnly && ' Shipped by the agent.'}
                    </Text>
                  </div>
                )
              })}
            </div>
            <div className={styles.rowActions}>
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
            </div>
            {(installable.length > 0 || digests.size > 1 || hollowCopies.length > 0) && (
              <div className={styles.rowActions}>
                {/*
                  * One button per agent reads fine at four agents and turns
                  * into a keyboard row at ten. Past three targets the offer
                  * becomes one previewed plan with an op per agent — the
                  * preview still names every target, and apply is still
                  * per-op, so a refusal for one agent never blocks the rest.
                  */}
                {installable.length > 3 ? (
                  entry.kind === 'skill' && source !== null ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        onFlow({
                          type: 'plan',
                          title: `Install ${entry.name} for ${installable.length} agents`,
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
                          title: `Add ${entry.name} to ${installable.length} agents`,
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
                {entry.kind === 'skill' && digests.size > 1 && (
                  <Button variant="outline" size="sm" onClick={() => onFlow({ type: 'resolve', entry })}>
                    Resolve copies…
                  </Button>
                )}
                {entry.kind === 'skill' && hollowCopies.length > 0 && (
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
              </div>
            )}
            {entry.kind === 'skill' && (
              <MetaList className={styles.facts}>
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
                    if (rest > 0) parts.push(`${rest}× under earlier registrations`)
                    return (
                      <>
                        <span>
                          Fired {fired.activations}×{' '}
                          {`in ${fired.sessions} ${fired.sessions === 1 ? 'conversation' : 'conversations'}`}
                          {parts.length > 0 ? ` (${parts.join(', ')})` : ''}
                        </span>
                        {fired.lastAt > 0 && (
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
              <div className={styles.notes} role="list">
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
              </div>
            )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  )
}
