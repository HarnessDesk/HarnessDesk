import {
  Button,
  DialogRoot,
  PopoverGroupLabel,
  Tabs,
  TabsList,
  TabsTrigger,
  Text,
  CommandPalettePanel,
  CommandPaletteSearch,
  CommandPaletteControls,
  CommandPaletteDivider,
  CommandPaletteResults,
  CommandPaletteResult,
  CommandPaletteEmpty,
  CommandPaletteFooter,
  CommandPaletteKeyHint,
} from '../design'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { FileMatch, SessionSummary, TranscriptHit } from '@harnessdesk/protocol'

import { runtimeLabel } from '../lib/accounts'
import { brandOf } from '../lib/identity'
import { firstReason, inForce, markFor, seatTaken } from '../lib/agents'
import { extractHit, highlightAll, type HighlightSpan } from '../lib/search-highlight'
import { sessionLabel } from '../lib/sessions'
import { availableCommands } from '../state/commands'
import { useSnapshot, useStore } from '../state/context'
import { sidebarPlacement } from '../state/workbench'
import {
  AgentIcon,
  ServerIcon,
  ArchiveIcon,
  FolderIcon,
  BranchIcon,
  DiffIcon,
  FileIcon,
  FilterIcon,
  FolderOpenIcon,
  LibraryIcon,
  PluginIcon,
  PlusIcon,
  SessionIcon,
  SidebarIcon,
  SlashIcon,
  SlidersIcon,
  TeamIcon,
  UsageIcon,
  UserIcon,
} from './Icons'
import { RuntimeMark } from './BrandIcons'
import { summonable } from '../panels/views'
import type { Section } from './Settings'

/**
 * Every settings page ⌘K can open, by the name on its nav row, except the
 * Archive, which the Actions group offers under its own name: people type what
 * they want back, not where it is filed. Profile's nav row carries your own
 * name rather than the page's, so here it is "Profile", found by the words
 * someone looking for their picture would type. The list used to hold four of
 * the fourteen, so "Appearance" typed into the palette found nothing while
 * "Settings › Preferences" opened a page nobody had called that. It is keyed by
 * section now, so a page added to Settings and left out here doesn't compile
 * (#104).
 */
const SETTINGS_PAGE: Record<Exclude<Section, 'archive'>, { label: string; icon: React.ReactNode; keywords: string }> = {
  runtimes: { label: 'Runtimes', icon: <ServerIcon size={14} />, keywords: 'runtimes installed agents accounts sign in' },
  profile: { label: 'Profile', icon: <UserIcon size={14} />, keywords: 'profile you name picture avatar photo face identity' },
  general: { label: 'General', icon: <SlidersIcon size={14} />, keywords: 'general backup restore diagnostics data' },
  appearance: { label: 'Appearance', icon: <SlidersIcon size={14} />, keywords: 'appearance theme dark light palette accent font code editor' },
  notifications: { label: 'Notifications', icon: <SlidersIcon size={14} />, keywords: 'notifications banners alerts mute' },
  shortcuts: { label: 'Keyboard shortcuts', icon: <SlidersIcon size={14} />, keywords: 'keyboard shortcuts keys bindings' },
  storage: { label: 'Storage', icon: <FolderIcon size={14} />, keywords: 'storage disk space clean up worktrees cache' },
  history: { label: 'History', icon: <ArchiveIcon size={14} />, keywords: 'history import other agents past conversations' },
  workspaces: { label: 'Workspaces', icon: <SlidersIcon size={14} />, keywords: 'workspaces folders projects worktrees' },
  models: { label: 'Models', icon: <SlidersIcon size={14} />, keywords: 'models endpoints presets routes' },
  skills: { label: 'Skills', icon: <SlidersIcon size={14} />, keywords: 'skills commands hooks' },
  extensions: { label: 'Extensions', icon: <SlidersIcon size={14} />, keywords: 'extensions mcp servers apps' },
  library: { label: 'Library', icon: <LibraryIcon size={14} />, keywords: 'library skills mcp servers import capabilities across agents' },
  plugins: { label: 'Plugins', icon: <PluginIcon size={14} />, keywords: 'plugins tools capabilities' },
  permissions: { label: 'Permissions', icon: <SlidersIcon size={14} />, keywords: 'permissions approvals sandbox rules deny allow' },
  browser: { label: 'Browser', icon: <SlidersIcon size={14} />, keywords: 'browser pane window profile cookies' },
}
const SETTINGS_PAGES = (Object.keys(SETTINGS_PAGE) as Exclude<Section, 'archive'>[]).map((section) => ({ section, ...SETTINGS_PAGE[section] }))

/**
 * ⌘K: everything the app can do, one keystroke away.
 *
 * Sessions, files, agents, commands, and the actions that otherwise live in
 * menus — found by typing, run with Enter. The point is speed without
 * chrome: nothing here is new capability, it is every existing one reachable
 * without hunting. Files come through the runtime's own search, the way `@`
 * in the composer does, so the palette ranks them as the agent would.
 */

export interface PaletteHost {
  readonly openSettings: (section: Section, focus?: string) => void
  readonly openUsage: () => void
  readonly chooseFolder: () => void
  /** Opens the Agents window — the left-menu screen, never Settings — on one Agent, or the overview. */
  readonly openAgents: (agent?: string) => void
  /** Opens the Teams destination. */
  readonly openTeams?: () => void
  /** Opens the front door on the given project — the same chooser `NewSessionChoice` opens, one call up. */
  readonly openFrontDoor: (root: string) => void
  readonly close: () => void
}

type PaletteFilter = 'All' | 'Sessions' | 'Teams' | 'Agents' | 'Files' | 'Commands'
type EntryFilter = Exclude<PaletteFilter, 'All'>
const PALETTE_FILTERS: readonly PaletteFilter[] = ['All', 'Sessions', 'Teams', 'Agents', 'Commands']
const FILES_PALETTE_FILTERS: readonly PaletteFilter[] = ['All', 'Sessions', 'Teams', 'Agents', 'Files', 'Commands']

interface Entry {
  readonly id: string
  readonly group: 'Actions' | 'Agents' | 'Runtimes' | 'Sessions' | 'Recents' | 'Teams' | 'Files' | 'Commands'
  readonly filter?: EntryFilter
  readonly label: string
  /** Query matches in the visible label, rather than a secondary transcript line. */
  readonly labelMatches?: readonly HighlightSpan[]
  readonly title?: string
  readonly disabled?: string
  readonly hint?: string
  /** Transcript match ranking remains useful when a title hit suppresses its duplicate snippet. */
  readonly contentMatch?: boolean
  /** A line from the content where the query matched, for inline display. */
  readonly matchLine?: string
  /** Start offset of the match within `matchLine`. */
  readonly matchStart?: number
  /** End offset of the match within `matchLine`. */
  readonly matchEnd?: number
  readonly icon: React.ReactNode
  readonly keywords?: string
  readonly run: () => void
}

const GROUP_FILTER: Record<Entry['group'], EntryFilter | null> = {
  Actions: null,
  Agents: 'Agents',
  Runtimes: 'Agents',
  Sessions: 'Sessions',
  Recents: 'Sessions',
  Teams: 'Teams',
  Files: 'Files',
  Commands: 'Commands',
}

const filterOf = (entry: Entry): EntryFilter | null => entry.filter ?? GROUP_FILTER[entry.group]

/**
 * How well an entry answers the query. A substring anywhere in the label,
 * keywords or hint counts, earliest best; a scattered subsequence counts
 * only in the label, and only when at least two letters sit together —
 * "pong" must not surface "Start with OPeNAI" by letters alone.
 */
const score = (query: string, label: string, extra: string): number => {
  if (!query) return 1
  const needle = query.toLowerCase()
  const inLabel = label.toLowerCase().indexOf(needle)
  if (inLabel === 0) return 100
  if (inLabel > 0) return 80 - Math.min(inLabel, 40)
  const inExtra = extra.toLowerCase().indexOf(needle)
  if (inExtra >= 0) return 30
  const haystack = label.toLowerCase()
  let at = 0
  let last = -2
  let pairs = 0
  for (const char of needle) {
    const found = haystack.indexOf(char, at)
    if (found === -1) return 0
    if (found === last + 1) pairs += 1
    last = found
    at = found + 1
  }
  return pairs > 0 ? 5 + pairs : 0
}

const compose = (text: string): void => {
  window.dispatchEvent(new CustomEvent('harnessdesk:compose', { detail: text }))
}

export const CommandPalette = ({ host }: { host: PaletteHost }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<PaletteFilter>('All')
  // The highlight is an entry, not an index. File and content results land
  // asynchronously and re-sort the list between the render the user read and
  // the Enter they pressed; an index would then run whatever slid under it —
  // which is how Enter on "Open settings" used to land "/settings " in the
  // composer. Keyed by id, the highlight follows the entry through every
  // reshuffle, and Enter runs the row that is actually highlighted.
  const [activeId, setActiveId] = useState<string | null>(null)
  const [files, setFiles] = useState<readonly FileMatch[]>([])
  const [searchResults, setSearchResults] = useState<readonly SessionSummary[]>([])
  // Transcript-content matches keyed by `${runtime}-${id}`: the backend's own
  // matching line, which beats re-deriving one from title and preview.
  const [contentHits, setContentHits] = useState<ReadonlyMap<string, TranscriptHit>>(new Map())
  const [includeTools, setIncludeTools] = useState(() => {
    try { return localStorage.getItem('hd-palette-tools-v1') === 'true' } catch { return false }
  })
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  // The roster, for "Start as" — read once if nothing has read it yet.
  useEffect(() => {
    if (store.getSnapshot().agents === null) void store.loadAgents()
  }, [store])

  // Content search, from both places content lives. The host's transcript
  // store covers every agent the same way — it is what the host watched — and
  // runtimes that search their own history (Codex greps its rollouts) cover
  // the conversations HarnessDesk never opened. Debounced the same way as
  // file search; either side failing leaves the other's results standing.
  useEffect(() => {
    const needle = query.trim()
    if (needle.length < 2) {
      setSearchResults([])
      setContentHits(new Map())
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      const runtimes = snapshot.runtimes.filter((entry) => entry.capabilities.searchHistory)
      void Promise.all(
        runtimes.map((entry) =>
          store.transport
            .request('session/search', { runtime: entry.id, query: needle })
            .then((result) => Array.isArray(result?.data) ? result.data : [])
            .catch(() => [] as SessionSummary[]),
        ),
      ).then((pages) => {
        if (!cancelled) {
          setSearchResults(pages.flat().sort((a, b) => b.updatedAt - a.updatedAt))
        }
      })
      void store.transport
        .request('transcripts/search', { query: needle, ...(includeTools ? { includeTools: true } : {}) })
        .then((hits) => {
          if (cancelled) return
          const matches = Array.isArray(hits) ? hits : []
          setContentHits(new Map(matches.map((hit) => [`${hit.summary.runtime}-${hit.summary.id}`, hit])))
        })
        .catch(() => {
          if (!cancelled) setContentHits(new Map())
        })
    }, 120)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, includeTools, snapshot.runtimes, store])

  // Files only when there is something to look for; the runtime's search
  // is a round trip and an empty query would list the world.
  useEffect(() => {
    const root = snapshot.workspace?.path
    const needle = query.trim()
    if (!root || needle.length < 2) {
      setFiles([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void store.transport
        .request('workspace/files', {
          root,
          query: needle,
          limit: 6,
          ...(snapshot.activeRuntime ? { runtime: snapshot.activeRuntime } : {}),
        })
        .then((found) => {
          if (!cancelled) setFiles(Array.isArray(found) ? found : [])
        })
        .catch(() => {
          if (!cancelled) setFiles([])
        })
    }, 80)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, snapshot.workspace?.path, snapshot.activeRuntime, store])

  const entries = useMemo((): Entry[] => {
    /* The Skills page is headed with the runtime's own word for it, "Skills &
       commands" on an ACP agent, and so is its row in the Settings nav. Offered
       under the fixed word alone, typing what the nav says found nothing (#219). */
    const skillsLabel = snapshot.runtimes.find((one) => one.id === snapshot.activeRuntime)?.presentation.skillsLabel ?? null
    const close = host.close
    const actions: Entry[] = [
      {
        id: 'new',
        group: 'Actions',
        label: 'New session',
        hint: '⌘N',
        icon: <PlusIcon size={14} />,
        run: () => {
          close()
          store.newDraft()
        },
      },
      {
        id: 'worktree',
        group: 'Actions',
        label: 'New worktree…',
        title: 'Its own checkout, on its own branch',
        icon: <BranchIcon size={14} />,
        run: () => {
          close()
          store.askNewWorktree(snapshot.workspace?.path ?? null)
        },
      },
      /*
       * A project is what the front door reads a catalogue from, so this row
       * has nothing to open without one — left out entirely rather than
       * shown to refuse, since typing "team" with no project open should
       * find nothing rather than a row this dispatch cannot honour.
       */
      ...(snapshot.workspace?.path
        ? [
            {
              id: 'start-team',
              group: 'Actions' as const,
              label: 'Start with a team',
              title: 'Choose a shape this project ships',
              icon: <TeamIcon size={14} />,
              run: () => {
                close()
                host.openFrontDoor(snapshot.workspace!.path)
              },
            },
          ]
        : []),
      {
        id: 'folder',
        group: 'Actions',
        label: 'Open a project folder…',
        hint: '⌘O',
        icon: <FolderOpenIcon size={14} />,
        run: () => {
          close()
          host.chooseFolder()
        },
      },
      /*
       * Every view a person can summon, from the registry that already knows
       * which those are — the same list the conversation header's View group
       * is built from.
       *
       * It was a hand-written list of five taken from `Details`, plus a
       * hand-written row each for the browser and the terminal, and it had
       * drifted exactly the way such a list does: the repository had no row at
       * all, and the five ran `openDetailsTab` while every other door to the
       * same view — the View menu's checkbox, ⇧⌘D, the slash command — runs
       * `showView`. So ⌘K listed *two* rows reading "Show trajectory" and
       * "/trajectory · Show Trajectory", and only one of them answered a second
       * press by putting the panel away. One door, one verb.
       */
      ...summonable().filter((definition) => definition.kind !== 'tasks').map(
        (definition): Entry => ({
          id: definition.kind,
          group: 'Actions',
          ...(definition.kind === 'room' ? { filter: 'Teams' as const } : {}),
          label: `Show ${definition.kind === 'room' ? 'Teams' : definition.kind === 'trajectory' ? 'Details' : definition.label}`,
          hint: definition.kind === 'changes' ? '⇧⌘D' : undefined,
          /* The view's own sentence, so "tokens" still finds Trajectory. */
          keywords: definition.hint,
          icon: definition.kind === 'agents' ? <AgentIcon size={14} /> : <definition.icon size={14} />,
          run: () => {
            close()
            if (definition.kind === 'room') host.openTeams?.()
            else store.showView(definition.kind)
          },
        }),
      ),
      {
        id: 'sidebar',
        group: 'Actions',
        label: sidebarPlacement(snapshot) === 'away' ? 'Show sidebar' : 'Hide sidebar',
        hint: '⌘B',
        icon: <SidebarIcon size={14} />,
        run: () => {
          close()
          store.toggleSidebar()
        },
      },
      {
        // The full-window review of the working tree — folder groups, hunks,
        // and revise-this-hunk. "Show changes" above opens the side panel;
        // this is the workspace.
        id: 'review',
        group: 'Actions',
        label: 'Review changes',
        icon: <DiffIcon size={14} />,
        keywords: 'review diff hunks working tree staged full window workspace',
        run: () => {
          close()
          window.dispatchEvent(new CustomEvent('harnessdesk:review'))
        },
      },
      {
        id: 'usage',
        group: 'Actions',
        label: 'Dashboard',
        hint: '\u2318U',
        icon: <UsageIcon size={14} />,
        keywords: 'usage limits quota spend cost plan remaining dashboard',
        run: () => {
          close()
          host.openUsage()
        },
      },
      {
        id: 'agents-window',
        group: 'Actions',
        label: 'Agents',
        icon: <AgentIcon size={14} />,
        keywords: 'agents who roster brief reviewer implementer judge researcher seats ceiling',
        run: () => {
          close()
          host.openAgents()
        },
      },
      {
        // Kept under its own name rather than as "Settings › Archive": people
        // type what they want back, not where it is filed.
        id: 'archive',
        group: 'Actions',
        label: 'Archive',
        icon: <ArchiveIcon size={14} />,
        keywords: 'archived sessions old deleted restore settings',
        run: () => {
          close()
          host.openSettings('archive')
        },
      },
      ...SETTINGS_PAGES.map(
        (entry): Entry => ({
          id: `settings-${entry.section}`,
          group: 'Actions',
          label: `Settings › ${entry.section === 'skills' && skillsLabel ? skillsLabel : entry.label}`,
          hint: entry.section === 'runtimes' ? '⌘,' : undefined,
          icon: entry.icon,
          keywords: `settings ${entry.keywords}${entry.section === 'skills' && skillsLabel ? ` ${skillsLabel}` : ''}`,
          run: () => {
            close()
            host.openSettings(entry.section)
          },
        }),
      ),
    ]

    // Named by account where an agent has more than one, or two accounts of
    // one Codex would offer the same sentence twice.
    const runtimeEntries: Entry[] = snapshot.runtimes.map((runtime) => ({
      id: `agent-${runtime.id}`,
      group: 'Runtimes',
      label: `Start with ${runtimeLabel(runtime, snapshot.runtimes, snapshot.accountsByRuntime, snapshot.accountPrefs)}`,
      hint: runtime.id === snapshot.activeRuntime ? 'current' : runtime.presentation.tagline,
      icon: <RuntimeMark runtime={runtime} />,
      keywords: `switch agent ${brandOf(runtime.presentation.name)}`,
      // "Start with" promises a conversation. Choosing the agent is a
      // preference that leaves the screen alone, so the draft is opened
      // here, on purpose, after the pick. The pick goes through even for the
      // agent already chosen: the store makes that a no-op unless the agent
      // has crashed, in which case it is the restart its health asks for.
      // The draft can follow synchronously because `selectRuntime` patches
      // the default before its first await — pinned by the store's
      // "same frame" test.
      run: () => {
        close()
        void store.selectRuntime(runtime.id)
        store.newDraft()
      },
    }))

    /* Open is the default door to each Agent; starting one is an explicit query. */
    const roster: Entry[] = inForce(snapshot.agents ?? []).flatMap((entry) => {
      const definition = entry.definition
      if (!definition) return []
      const plan = snapshot.agentPlans.get(entry.id)
      const seat = seatTaken(plan)
      return [
        ...(/\bstart\b/i.test(query) ? [{
          id: `start-as-${entry.id}`,
          group: 'Agents' as const,
          label: `Start as ${definition.name}`,
          hint: seat?.label,
          disabled: !plan ? 'Reading where this Agent can start' : !seat ? firstReason(plan) ?? 'No available seat here' : undefined,
          icon: seat ? <RuntimeMark runtime={markFor(seat, snapshot.runtimes)} /> : <AgentIcon size={14} />,
          keywords: `agent new conversation ${definition.description ?? ''}`,
          run: () => {
            close()
            void store.startAsAgent(entry.id)
          },
        }] : []),
        {
          id: `open-agent-${entry.id}`,
          group: 'Agents' as const,
          label: `Open ${definition.name}`,
          icon: <AgentIcon size={14} />,
          keywords: 'agent brief seats ceiling this mac',
          run: () => {
            close()
            host.openAgents(entry.id)
          },
        },
      ]
    })

    const teams: Entry[] = [...snapshot.teams.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((team) => ({
        id: `team-${team.id}`,
        group: 'Teams',
        filter: 'Teams',
        label: team.name,
        hint: team.root.split('/').filter(Boolean).at(-1) ?? team.root,
        icon: <TeamIcon size={14} />,
        keywords: `${team.root} ${team.name} team project`,
        run: () => {
          close()
          store.openTeamRoom(team.id)
        },
      }))

    const needle = query.trim()
    const sessionEntryFrom = (summary: SessionSummary): Entry => {
      const agent = snapshot.runtimes.find((entry) => entry.id === summary.runtime)?.presentation.name ?? summary.runtime
      const folder = summary.cwd.split('/').filter(Boolean).at(-1) ?? summary.cwd
      const label = sessionLabel(summary.title, summary.preview)
      const labelMatches = needle ? highlightAll(needle, label) : []
      // The transcript store's own matching line wins over one re-derived
      // from the preview: it is from the conversation's content. A title hit
      // is shown in the title itself, never repeated as a second line.
      const content = contentHits.get(`${summary.runtime}-${summary.id}`)
      const hit = needle && labelMatches.length === 0 ? extractHit(needle, summary.preview ?? '') : null
      return {
        id: `session-${summary.runtime}-${summary.id}`,
        group: 'Sessions',
        filter: 'Sessions',
        label,
        ...(labelMatches.length > 0 ? { labelMatches } : {}),
        ...(content ? { contentMatch: true } : {}),
        hint: `${brandOf(agent)} · ${folder}`,
        icon: <SessionIcon size={14} />,
        keywords: `${folder} ${agent} ${summary.preview ?? ''}`,
        ...(content && labelMatches.length === 0
          ? { matchLine: content.line, matchStart: content.start, matchEnd: content.end }
          : hit
            ? { matchLine: hit.line, matchStart: hit.spans[0]?.start, matchEnd: hit.spans[0]?.end }
            : {}),
        run: () => {
          close()
          void store.openSession(summary.id, { runtime: summary.runtime })
        },
      }
    }

    // Merge local history and both content searches, deduplicating by id.
    // History rows come last so a transcript hit for a listed session keeps
    // the listing's fresher summary — the map above still supplies its line.
    const seen = new Set<string>()
    const combined: SessionSummary[] = []
    for (const summary of [
      ...searchResults,
      ...snapshot.history.slice(0, 400),
      ...[...contentHits.values()].map((hit) => hit.summary),
    ]) {
      const key = `${summary.runtime}-${summary.id}`
      if (seen.has(key)) continue
      seen.add(key)
      combined.push(summary)
    }
    const sessions: Entry[] = combined.sort((a, b) => b.updatedAt - a.updatedAt).map(sessionEntryFrom)

    const fileEntries: Entry[] = files.map((file) => ({
      id: `file-${file.path}`,
      group: 'Files',
      label: file.relativePath,
      hint: file.kind === 'directory' ? 'folder' : undefined,
      icon: <FileIcon size={14} />,
      run: () => {
        close()
        store.openFile(file.path)
      },
    }))

    const commands: Entry[] = availableCommands(snapshot).map((command) => ({
      id: `command-${command.name}`,
      group: 'Commands',
      filter: 'Commands',
      label: `/${command.name}`,
      hint: command.description,
      icon: <SlashIcon size={14} />,
      run: () => {
        close()
        compose(`/${command.name} `)
      },
    }))

    return [...actions, ...teams, ...roster, ...runtimeEntries, ...sessions, ...fileEntries, ...commands]
  }, [contentHits, files, host, query, searchResults, snapshot, store])

  const shown = useMemo(() => {
    const needle = query.trim()
    const candidates = filter === 'All'
      ? entries
      : entries.filter((entry) => filterOf(entry) === filter)
    if (!needle) {
      if (filter === 'All') {
        return [
          ...entries.filter((entry) => entry.group === 'Sessions').slice(0, 6).map((entry) => ({ ...entry, group: 'Recents' as const })),
          ...entries.filter((entry) => entry.group === 'Actions'),
        ]
      }
      if (filter === 'Sessions') {
        return candidates.filter((entry) => entry.group === 'Sessions').slice(0, 6).map((entry) => ({ ...entry, group: 'Recents' as const }))
      }
      return candidates
    }
    // Score everything and pick the best matches without per-group caps.
    // Sessions with a content match from the search backend get a boost.
    const scored = candidates
      .map((entry) => ({
        entry,
        score: score(needle, entry.label, `${entry.keywords ?? ''} ${entry.hint ?? ''} ${entry.title ?? ''}`)
          + (entry.matchLine || entry.contentMatch ? 20 : 0),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40)

    // Group results by group so headers are contiguous and never repeated,
    // ordering groups by their best-matching entry.
    const groupOrder: Entry['group'][] = []
    const byGroup = new Map<Entry['group'], Entry[]>()
    for (const item of scored) {
      const g = item.entry.group
      const list = byGroup.get(g)
      if (list) {
        list.push(item.entry)
      } else {
        groupOrder.push(g)
        byGroup.set(g, [item.entry])
      }
    }
    return groupOrder.flatMap((g) => byGroup.get(g) ?? [])
  }, [entries, filter, query])
  const visibleFilters = files.length > 0 || filter === 'Files' ? FILES_PALETTE_FILTERS : PALETTE_FILTERS

  // A fresh query starts back at the top, and the highlight then locks to
  // whichever entry leads that first paint: results that arrive later may
  // insert rows above it, but they cannot move the highlight off the row the
  // user is looking at.
  useEffect(() => setActiveId(null), [filter, query])
  useEffect(() => {
    if (activeId === null && shown.length > 0) setActiveId(shown[0]?.id ?? null)
  }, [activeId, shown])
  const active = (() => {
    if (activeId === null) return 0
    const index = shown.findIndex((entry) => entry.id === activeId)
    return index === -1 ? 0 : index
  })()
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[data-active]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const moveActive = (delta: number): void => {
    const next = Math.max(0, Math.min(active + delta, shown.length - 1))
    setActiveId(shown[next]?.id ?? null)
  }

  const selectFilter = (value: string): void => {
    const next = visibleFilters.find((candidate) => candidate === value)
    if (!next) return
    setFilter(next)
    setActiveId(null)
  }

  const moveFilter = (delta: number): void => {
    const current = visibleFilters.indexOf(filter)
    const next = (current + delta + visibleFilters.length) % visibleFilters.length
    selectFilter(visibleFilters[next]!)
  }

  const run = (index: number): void => {
    const entry = shown[index]
    if (entry && !entry.disabled) entry.run()
  }

  let lastGroup: Entry['group'] | null = null

  return (
    <DialogRoot open onOpenChange={(open) => { if (!open) host.close() }}>
      <CommandPalettePanel
        aria-label="Command palette"
        initialFocus={input}
        showCloseButton={false}
      >
        <CommandPaletteSearch
          inputRef={input}
          autoFocus
          placeholder="Search sessions, files, teams, agents, commands…"
          value={query}
          onChange={setQuery}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              moveActive(1)
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              moveActive(-1)
            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              const field = event.currentTarget
              const atStart = field.selectionStart === 0 && field.selectionEnd === 0
              const atEnd = field.selectionStart === field.value.length && field.selectionEnd === field.value.length
              if ((event.key === 'ArrowLeft' && atStart) || (event.key === 'ArrowRight' && atEnd)) {
                event.preventDefault()
                moveFilter(event.key === 'ArrowLeft' ? -1 : 1)
              }
            } else if (event.key === 'Enter') {
              event.preventDefault()
              run(active)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              host.close()
            }
          }}
        />
        <CommandPaletteControls>
          <Tabs value={filter} onValueChange={selectFilter}>
            <TabsList aria-label="Search type" variant="line">
              {visibleFilters.map((value) => (
                <TabsTrigger key={value} value={value} data-palette-tab={value}>{value}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Button
            type="button"
            variant="quiet"
            size="sm"
            aria-label="Include tool output"
            aria-pressed={includeTools}
            title="Include tool output"
            {...(includeTools ? { 'data-active': '' } : {})}
            onClick={() => {
              const checked = !includeTools
              setIncludeTools(checked)
              setContentHits(new Map())
              try { localStorage.setItem('hd-palette-tools-v1', String(checked)) } catch { /* Viewer storage can be unavailable. */ }
            }}
          >
            <FilterIcon size={14} />
            Tool output
          </Button>
        </CommandPaletteControls>
        <CommandPaletteDivider />
        <CommandPaletteResults ref={list} role="listbox" aria-label={`${filter} results`}>
          {shown.length === 0 && <CommandPaletteEmpty>Nothing matches “{query}”.</CommandPaletteEmpty>}
          {shown.map((entry, index) => {
            const header = entry.group !== lastGroup ? entry.group : null
            const session = entry.group === 'Sessions' || entry.group === 'Recents'
            lastGroup = entry.group
            return (
              <div key={entry.id}>
                {header && <PopoverGroupLabel inset={false}>{header}</PopoverGroupLabel>}
                <CommandPaletteResult
                  role="option"
                  aria-selected={index === active}
                  {...(index === active ? { 'data-active': '' } : {})}
                  onMouseEnter={() => setActiveId(entry.id)}
                  onClick={() => run(index)}
                  icon={entry.icon}
                  title={entry.disabled ?? entry.title}
                  disabled={Boolean(entry.disabled)}
                  aria-disabled={entry.disabled ? true : undefined}
                  label={entry.labelMatches?.length ? (
                    <>
                      {entry.labelMatches.map((span, matchIndex) => (
                        <span key={matchIndex}>
                          {entry.label.slice(matchIndex === 0 ? 0 : entry.labelMatches![matchIndex - 1]!.end, span.start)}
                          <Text as="b" role="meta" ink="primary" weight="semibold">{entry.label.slice(span.start, span.end)}</Text>
                        </span>
                      ))}
                      {entry.label.slice(entry.labelMatches.at(-1)!.end)}
                    </>
                  ) : entry.label}
                  meta={entry.hint}
                  metaInk={session ? 'secondary' : 'muted'}
                  match={entry.matchLine && (
                    <>
                      {entry.matchStart != null && entry.matchEnd != null ? (
                        <>
                          {entry.matchLine.slice(0, entry.matchStart)}
                          <Text as="b" role="meta" ink="primary" weight="semibold">{entry.matchLine.slice(entry.matchStart, entry.matchEnd)}</Text>
                          {entry.matchLine.slice(entry.matchEnd)}
                        </>
                      ) : entry.matchLine}
                    </>
                  )}
                />
              </div>
            )
          })}
        </CommandPaletteResults>
        <CommandPaletteDivider />
        <CommandPaletteFooter>
          <CommandPaletteKeyHint label="Close" keyName="Esc" />
          <CommandPaletteKeyHint label="Change type" keyName="←→" />
          <CommandPaletteKeyHint label="Open" keyName="↵" />
        </CommandPaletteFooter>
      </CommandPalettePanel>
    </DialogRoot>
  )
}
