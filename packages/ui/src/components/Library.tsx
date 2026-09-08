import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  entryHasProblem,
  isReachProblem,
  summarise,
  type Library,
  type LibraryEntry,
  type LibraryKind,
  type LibraryUsage,
  type ReachState,
  type RuntimeId,
} from '@harnessdesk/protocol'

import { runtimeLabel } from '../lib/accounts'
import { useSnapshot, useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import {
  AlertIcon,
  CrossIcon,
  DiffIcon,
  FileIcon,
  ImportIcon,
  LibraryIcon,
  MatrixIcon,
  PlusIcon,
  RetryIcon,
  RowsLooseIcon,
  SearchIcon,
  TrashIcon,
} from './Icons'
import { PageHead, kit } from '../design/primitives/Kit'
import {
  Button,
  EmptyState,
  Label,
  Switch,
  ToggleGroup,
  ToggleGroupItem,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  Input,
} from '../design/ui'
import {
  installSource,
  LibraryFlows,
  LibraryHistory,
  SWITCH_ITEM,
  SWITCH_TRACK,
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
const ReachMark = ({ state }: { state: ReachState }) => {
  // `rejected` wears `hollow`'s glyph, and deliberately: both mean *there is
  // something here and nothing loads*, both are the person's to fix, and a
  // ninth shape would be a ninth thing to learn for a distinction the note
  // already draws in the agent's own words.
  if (state === 'hollow' || state === 'rejected') return <AlertIcon size={13} />
  if (state === 'differs') return <DiffIcon size={13} />
  if (state === 'unhostable') return <CrossIcon size={13} />
  if (state === 'unscanned') return <span className={styles.ring} />
  // `stale` is the dot it is about to be, drawn as an outline and in the
  // neutral ink: the difference from `unscanned` has to be a *shape* and not
  // two rings three percent apart, because the two states mean opposite
  // things — one is in the right place, the other never will be.
  if (state === 'stale') return <span className={styles.soon} />
  if (state === 'reaches') return <span className={styles.here} />
  // Switched off draws as the dot it would have, struck through: the shape
  // says "this one is present" and the bar says "and not loading". Drawing
  // it as `absent` would hide the difference between a skill you do not have
  // and one you turned off, which is the whole reason it has a state.
  if (state === 'off') return <span className={styles.off} />
  return <span className={styles.none} />
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
    <p className={styles.legend} data-slot="library-legend">
      {present.map((state) => (
        <span key={state} className={styles.legendItem}>
          <span className={styles.legendMark} data-state={state}>
            <ReachMark state={state} />
          </span>
          {REACH_NAME[state]}
        </span>
      ))}
    </p>
  )
}

/*
 * The kind switcher, and the list/matrix switch below it, wear shadcn `Tabs`'
 * own clothes without being tabs: a Base UI tab activates on `mousedown`,
 * which a plain `element.click()` never fires, and these have to answer to
 * tests and keyboards alike. So the mechanism is a `ToggleGroup` and the
 * appearance is `tabsListVariants` — now named once, in `LibraryActions`,
 * where the agent pickers use it too.
 */

/**
 * One count, which is also the filter that isolates it.
 *
 * Three shapes, in order. First six dashboard tiles, which promised a
 * *metric* — something you came to read — when every one of them is a filter
 * nobody opens this page to admire. Then outlined pills, which fixed the
 * weight and introduced a shape the app does not have anywhere else, drawn
 * with a bare `border` that Tailwind painted in ink (see the note in
 * shadcn.css).
 *
 * Now it is the app's own `Button`. A filter is a thing you press, the app
 * already has a component for things you press, and using it means the
 * height, the radius, the border token, the hover and the focus ring all
 * arrive correct and stay correct — none of them is a number in this file to
 * drift from the button beside it. The set is single-select, so the active
 * one takes `secondary`, the app's spelling of "this one is on".
 */
const Count = ({
  value,
  label,
  tone,
  title,
  active,
  onClick,
}: {
  value: number
  label: string
  tone?: 'warn'
  title?: string
  active: boolean
  onClick: () => void
}) => (
  <Button
    type="button"
    data-slot="library-count"
    {...(active ? { 'data-active': '' } : {})}
    variant={active ? 'secondary' : 'outline'}
    size="sm"
    {...(title ? { title } : {})}
    disabled={value === 0 && !active}
    onClick={onClick}
  >
    {/* Amber on the number, never the whole control: a filter row wearing
        five warning colours is five warnings, and the count is the only part
        that is news. */}
    <span
      className={`font-semibold tabular-nums ${tone === 'warn' && value > 0 ? 'text-(--hd-warning-ink)' : ''}`}
    >
      {value}
    </span>
    <span className="font-normal text-(--hd-muted-foreground)">{label}</span>
  </Button>
)

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
  }, [searched, filter, usage])

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

  const toggle = (next: Filter) => setFilter((current) => (current === next ? 'all' : next))

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

      {failed !== null && (
        <p className={styles.failed}>The library could not be read: {failed}</p>
      )}

      {kind === 'skill' && (hollowCopies.length > 0 || overloaded.length > 0) && (
        <div
          data-slot="library-attention"
          className="mb-4 flex flex-col gap-1 rounded-lg border bg-card px-3 py-2"
        >
          {hollowCopies.length > 0 && (
            <p className="m-0 flex items-center gap-2 text-sm text-(--hd-secondary-foreground) [&>svg]:flex-none [&>svg]:text-(--hd-warning-ink)">
              <AlertIcon size={13} />
              <span className="min-w-0 flex-1">
                {hollowCopies.length} {hollowCopies.length === 1 ? 'directory holds' : 'directories hold'} a
                skill’s name and no definition — an agent that scans them lists the name and loads
                nothing.
              </span>
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
            <p
              key={column.id}
              className="m-0 flex items-center gap-2 text-sm text-(--hd-secondary-foreground) [&>svg]:flex-none [&>svg]:text-(--hd-warning-ink)"
            >
              <AlertIcon size={13} />
              <span className="min-w-0 flex-1">
                ≈{total.toLocaleString()} tokens of skill catalogue ride every {column.label} turn
                {neverFired !== null && neverFired > 0
                  ? ` — ${neverFired} of its skills never fired in a conversation this desk stores.`
                  : '.'}
              </span>
              {neverFired !== null && neverFired > 0 && (
                <Button variant="outline" size="sm" className="flex-none" onClick={() => setFilter('unused')}>
                  Show never fired
                </Button>
              )}
            </p>
          ))}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        {/* A ToggleGroup rather than radix Tabs, dressed as one: a tab
            trigger activates on mousedown, which a plain click() never
            fires — and this switcher has to answer to tests and keyboards
            alike. Ignoring the empty value is what stops a second press
            from deselecting both. */}
        <ToggleGroup
          type="single"
          value={kind}
          aria-label="What the library is listing"
          className={SWITCH_TRACK}
          onValueChange={(next) => {
            if (next !== 'skill' && next !== 'mcp') return
            setKind(next)
            setOpen(null)
          }}
        >
          <ToggleGroupItem value="skill" className={SWITCH_ITEM}>
            Skills · {kindCounts.skill}
          </ToggleGroupItem>
          <ToggleGroupItem value="mcp" className={SWITCH_ITEM}>
            MCP servers · {kindCounts.mcp}
          </ToggleGroupItem>
        </ToggleGroup>
        {/* Wide enough to type a skill name into, and capped: at the width
            the settings pane actually is, `flex-1` gave the search box four
            hundred pixels of empty field and pushed nothing useful anywhere
            — a text input's size is a claim about how much you type in it. */}
        <Input
          className="min-w-0 flex-1 basis-44 md:max-w-64"
          value={query}
          placeholder={kind === 'skill' ? 'Search skills' : 'Search servers'}
          aria-label="Filter the library by name"
          onChange={(event) => setQuery(event.target.value)}
        />
        <Label className="gap-1.5 text-sm font-normal whitespace-nowrap text-(--hd-secondary-foreground)">
          <Switch
            checked={filter === 'problems'}
            onCheckedChange={() => toggle('problems')}
            aria-label="Show only entries with something wrong"
          />
          Only problems
        </Label>
        {/*
         * Two ways to read the same list, and the switch says which by
         * drawing it. Icons rather than words: the shapes are the standard
         * ones, the tooltips carry the names, and two more words in a
         * toolbar this busy would push the search box onto its own line at
         * the width the settings pane actually is.
         */}
        <ToggleGroup
          type="single"
          value={view}
          aria-label="How to show the library"
          className={SWITCH_TRACK}
          onValueChange={(next) => {
            if (next !== 'list' && next !== 'matrix') return
            setView(next)
            setOpen(null)
          }}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <ToggleGroupItem
                value="list"
                aria-label="Show each entry as a row"
                className={SWITCH_ITEM}
              >
                <RowsLooseIcon size={13} />
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent>List — read what each one does</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <ToggleGroupItem
                value="matrix"
                aria-label="Show every entry against every agent"
                className={SWITCH_ITEM}
              >
                <MatrixIcon size={13} />
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent>Matrix — every entry against every agent</TooltipContent>
          </Tooltip>
        </ToggleGroup>
      </div>

      {counts && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {/*
           * "All" rather than the everywhere-count this used to show. In a
           * row of tiles a count that does not filter reads as a statistic;
           * in a row of *chips* it reads as a filter, and pressing it to see
           * the entries that reach every agent — which is what its label
           * promised — showed the whole list instead. How many reach
           * everything is legible from the cards; a control that lies about
           * what it does is not repairable by a tooltip.
           */}
          <Count
            value={counts.total}
            label="in all"
            active={filter === 'all'}
            onClick={() => setFilter('all')}
          />
          <Count
            value={counts.partial}
            label="reach some"
            active={filter === 'partial'}
            onClick={() => toggle('partial')}
          />
          <Count
            value={counts.unreachable}
            label="reach none"
            tone="warn"
            active={filter === 'unreachable'}
            onClick={() => toggle('unreachable')}
          />
          <Count
            value={counts.hollow}
            label="empty on disk"
            tone="warn"
            active={filter === 'hollow'}
            onClick={() => toggle('hollow')}
          />
          <Count
            value={counts.differs}
            label="copies differ"
            tone="warn"
            active={filter === 'differs'}
            onClick={() => toggle('differs')}
          />
          {/* No warn tone: a switch somebody threw is not a defect, and the
              chip beside four amber ones would be read as a fifth. */}
          <Count
            value={counts.off}
            label="switched off"
            title="Installed in an agent and turned off in its own settings, so nothing loads it there."
            active={filter === 'off'}
            onClick={() => toggle('off')}
          />
          {kind === 'skill' &&
            (usage !== null ? (
              <Count
                value={unusedCount}
                label="never fired"
                title={`Reaches at least one agent, and none of the ${usage.sessionsScanned} conversations this desk stores shows it loading. What ran elsewhere is not counted.`}
                active={filter === 'unused'}
                onClick={() => toggle('unused')}
              />
            ) : (
              /* The first usage read walks every stored conversation, so this
                 tile arrives late. Holding its place is what keeps the strip
                 from jumping when it does. */
              <Button
                type="button"
                data-slot="library-count"
                variant="outline"
                size="sm"
                disabled
                title="Counting activations in the stored conversations…"
              >
                <span className="font-semibold tabular-nums">…</span>
                <span className="font-normal text-(--hd-muted-foreground)">never fired</span>
              </Button>
            ))}
        </div>
      )}

      {loading && library === null ? (
        <p className={styles.empty}>Reading every agent’s directories…</p>
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
        <div className={styles.scroll}>
          <table className={styles.grid}>
            <caption className={styles.caption}>
              Each row is one entry; each column is one agent. A dot means the agent loads it.
              {kind === 'skill' &&
                usage !== null &&
                ` Fired-counts come from the ${usage.sessionsScanned} conversations this desk stores — what ran elsewhere is not counted.`}
            </caption>
            <thead>
              <tr>
                <th scope="col" className={styles.nameHead}>
                  Name
                </th>
                {columns.map((column) => (
                  <th scope="col" key={column.id} className={styles.agentHead}>
                    <span className={styles.agentName} title={column.label}>
                      {column.info && <RuntimeMark runtime={column.info} size={13} />}
                      {column.head}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            {kind === 'skill' && (
              <tfoot>
                <tr className={styles.foot}>
                  {/* Summed over the rows on screen, so the number under a
                      filtered table is true of that table — the tile lesson,
                      applied before it is relearned. */}
                  <th
                    scope="row"
                    className={styles.footHead}
                    title="Name and description at ≈3.6 characters per token — the catalogue line an agent carries for every skill it loads, fired or not. How each agent advertises varies; this prices the standard line."
                  >
                    Advertised each turn{filter !== 'all' || query.trim() !== '' ? ' (these rows)' : ''}
                  </th>
                  {columns.map((column, index) => {
                    const total = rows.reduce(
                      (sum, entry) =>
                        entry.reach[index]?.state === 'reaches' && entry.catalogTokens
                          ? sum + entry.catalogTokens
                          : sum,
                      0,
                    )
                    return (
                      <td key={column.id} className={styles.footCell}>
                        {total > 0 ? `≈${total.toLocaleString()} tok` : '—'}
                      </td>
                    )
                  })}
                </tr>
                {usage !== null && (
                  <tr className={styles.foot}>
                    <th
                      scope="row"
                      className={styles.footHead}
                      title="Of the rows on screen, how many this agent loaded in a conversation this desk stores. Conversations held elsewhere are not counted."
                    >
                      Fired here, ever
                    </th>
                    {columns.map((column) => {
                      const fired = rows.filter(
                        (entry) => usage.skills[entry.name]?.byRuntime?.[column.id] !== undefined,
                      ).length
                      return (
                        <td key={column.id} className={styles.footCell}>
                          {fired > 0 ? `${fired} of ${rows.length}` : '—'}
                        </td>
                      )
                    })}
                  </tr>
                )}
              </tfoot>
            )}
            <tbody>
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
            </tbody>
          </table>
        </div>
        </>
      )}

      {gaps.length > 0 && gaps.length <= 2 && (
        <div className={styles.gaps}>
          {gaps.map((gap, index) => {
            const runtime = columns.find((one) => one.id === gap.runtime)
            return (
              <p key={`${gap.runtime}:${gap.kind}:${index}`} className={styles.gap}>
                <strong>{runtime?.label ?? gap.runtime}</strong> {gap.reason}
              </p>
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
          <summary className={styles.gapsFold}>
            {gaps.length} columns are read from disk rather than from their agents — show why
          </summary>
          {gaps.map((gap, index) => {
            const runtime = columns.find((one) => one.id === gap.runtime)
            return (
              <p key={`${gap.runtime}:${gap.kind}:${index}`} className={styles.gap}>
                <strong>{runtime?.label ?? gap.runtime}</strong> {gap.reason}
              </p>
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
      const hit = candidates.find((copy) => copy.path === root || copy.path.startsWith(`${root}/`))
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
    <tr className={styles.row} {...(open ? { 'data-open': '' } : {})}>
      <th scope="row" className={styles.name}>
        <button type="button" className={styles.nameButton} onClick={onToggle} aria-expanded={open}>
          <span className={styles.title}>{entry.title ?? entry.name}</span>
          {entry.description && <span className={styles.desc}>{entry.description}</span>}
        </button>
      </th>
      {entry.reach.map((reach, index) => {
        const runtime = columns[index]
        const label = `${entry.name} — ${runtime?.label ?? reach.runtime}: ${REACH_NAME[reach.state]}`
        return (
          <td
            key={reach.runtime}
            className={styles.cell}
            data-state={reach.state}
            {...(isReachProblem(reach.state) ? { 'data-problem': '' } : {})}
            title={reach.note ? `${REACH_NAME[reach.state]} — ${reach.note}` : REACH_NAME[reach.state]}
          >
            <span className={styles.mark} aria-label={label} role="img">
              <ReachMark state={reach.state} />
            </span>
          </td>
        )
      })}
    </tr>
    {open && (
      <tr>
        <td className={styles.detail} colSpan={columns.length + 1}>
          <div className={styles.detailBody}>
            <p className={styles.detailHead}>
              {entry.copies.length === 1 ? 'One copy on disk' : `${entry.copies.length} copies on disk`}
            </p>
            <ul className={styles.copies}>
              {entry.copies.map((copy) => {
                const order = orderOf(copy)
                return (
                  <li key={copy.path} className={styles.copy}>
                    <span className={styles.copyLine}>
                      <code className={kit.mono}>{shortPath(copy.path, home)}</code>
                      {order.wins.length > 0 && (
                        <span
                          className={styles.orderChip}
                          data-wins=""
                          title="More than one copy sits where this agent looks; by scan order — project scope over user, per this build’s location table — this one loads. The agent itself was not asked."
                        >
                          loads for {order.wins.join(', ')}
                        </span>
                      )}
                      {order.shadowed.length > 0 && (
                        <span
                          className={styles.orderChip}
                          title="Another copy sits earlier in this agent’s scan order, so this one is never loaded there."
                        >
                          shadowed for {order.shadowed.join(', ')}
                        </span>
                      )}
                      {entry.kind === 'skill' && !copy.readOnly && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className={styles.copyRemove}
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
                          variant="ghost"
                          size="icon-sm"
                          className={styles.copyRemove}
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
                    <span className={styles.copyNote}>
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
                    </span>
                  </li>
                )
              })}
            </ul>
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
              <p className={styles.facts}>
                <span className={styles.fact}>
                  {entry.catalogTokens
                    ? `Catalogue ≈${entry.catalogTokens} tok/turn`
                    : 'No catalogue line to price'}
                </span>
                {usage !== null &&
                  (() => {
                    const fired = usage.skills[entry.name]
                    if (!fired) {
                      return (
                        <span className={styles.fact}>
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
                        <span className={styles.fact}>
                          Fired {fired.activations}×{' '}
                          {`in ${fired.sessions} ${fired.sessions === 1 ? 'conversation' : 'conversations'}`}
                          {parts.length > 0 ? ` (${parts.join(', ')})` : ''}
                        </span>
                        {fired.lastAt > 0 && (
                          <span className={styles.fact}>
                            Last {new Date(fired.lastAt).toLocaleDateString()}
                          </span>
                        )}
                      </>
                    )
                  })()}
              </p>
            )}
            {entry.reach.some((reach) => reach.note) && (
              <ul className={styles.notes}>
                {entry.reach
                  .filter((reach) => reach.note)
                  .map((reach) => (
                    <li key={reach.runtime}>
                      <strong>
                        {columns[entry.reach.indexOf(reach)]?.label ?? reach.runtime}
                      </strong>
                      {' \u2014 '}
                      {reach.note}
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </td>
      </tr>
    )}
  </>
  )
}
