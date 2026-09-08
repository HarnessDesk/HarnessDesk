import { useEffect, useMemo, useRef, useState } from 'react'

import type { FileMatch, SessionSummary, TranscriptHit } from '@harnessdesk/protocol'

import { runtimeLabel } from '../lib/accounts'
import { brandOf } from '../lib/identity'
import { extractHit } from '../lib/search-highlight'
import { sessionLabel } from '../lib/sessions'
import { availableCommands } from '../state/commands'
import { useSnapshot, useStore } from '../state/context'
import {
  AgentIcon,
  ArchiveIcon,
  BranchIcon,
  DiffIcon,
  FileIcon,
  FolderOpenIcon,
  LibraryIcon,
  PluginIcon,
  PlusIcon,
  SearchIcon,
  SessionIcon,
  SidebarIcon,
  SlashIcon,
  SlidersIcon,
  UsageIcon,
} from './Icons'
import { RuntimeMark } from './BrandIcons'
import { summonable } from '../panels/views'
import type { Section } from './Settings'

/**
 * Every settings page ⌘K can open, by the name on its nav row. The list
 * used to hold four of the fourteen, so "Appearance" typed into the palette
 * found nothing while "Settings › Preferences" opened a page nobody had
 * called that.
 */
const SETTINGS_PAGES: readonly { section: Section; label: string; icon: React.ReactNode; keywords: string }[] = [
  { section: 'agents', label: 'Agents', icon: <AgentIcon size={14} />, keywords: 'agents accounts sign in' },
  { section: 'general', label: 'General', icon: <SlidersIcon size={14} />, keywords: 'general backup restore diagnostics data' },
  { section: 'appearance', label: 'Appearance', icon: <SlidersIcon size={14} />, keywords: 'appearance theme dark light palette accent font code editor' },
  { section: 'notifications', label: 'Notifications', icon: <SlidersIcon size={14} />, keywords: 'notifications banners alerts mute' },
  { section: 'shortcuts', label: 'Keyboard shortcuts', icon: <SlidersIcon size={14} />, keywords: 'keyboard shortcuts keys bindings' },
  { section: 'workspaces', label: 'Workspaces', icon: <SlidersIcon size={14} />, keywords: 'workspaces folders projects worktrees' },
  { section: 'models', label: 'Models', icon: <SlidersIcon size={14} />, keywords: 'models endpoints presets routes' },
  { section: 'skills', label: 'Skills', icon: <SlidersIcon size={14} />, keywords: 'skills commands hooks' },
  { section: 'extensions', label: 'Extensions', icon: <SlidersIcon size={14} />, keywords: 'extensions mcp servers apps' },
  { section: 'library', label: 'Library', icon: <LibraryIcon size={14} />, keywords: 'library skills mcp servers import capabilities across agents' },
  { section: 'plugins', label: 'Plugins', icon: <PluginIcon size={14} />, keywords: 'plugins tools capabilities' },
  { section: 'permissions', label: 'Permissions', icon: <SlidersIcon size={14} />, keywords: 'permissions approvals sandbox rules deny allow' },
  { section: 'browser', label: 'Browser', icon: <SlidersIcon size={14} />, keywords: 'browser pane window profile cookies' },
]
import styles from './CommandPalette.module.css'

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
  readonly openSettings: (section: Section) => void
  readonly openUsage: () => void
  readonly chooseFolder: () => void
  readonly close: () => void
}

interface Entry {
  readonly id: string
  readonly group: 'Actions' | 'Agents' | 'Sessions' | 'Files' | 'Commands'
  readonly label: string
  readonly hint?: string
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
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

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
            .then((result) => result.data)
            .catch(() => [] as SessionSummary[]),
        ),
      ).then((pages) => {
        if (!cancelled) {
          setSearchResults(pages.flat().sort((a, b) => b.updatedAt - a.updatedAt))
        }
      })
      void store.transport
        .request('transcripts/search', { query: needle })
        .then((hits) => {
          if (cancelled) return
          setContentHits(new Map(hits.map((hit) => [`${hit.summary.runtime}-${hit.summary.id}`, hit])))
        })
        .catch(() => {
          if (!cancelled) setContentHits(new Map())
        })
    }, 120)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, snapshot.runtimes, store])

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
          if (!cancelled) setFiles(found)
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
        hint: 'Its own checkout, on its own branch',
        icon: <BranchIcon size={14} />,
        run: () => {
          close()
          store.askNewWorktree(snapshot.workspace?.path ?? null)
        },
      },
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
      ...summonable().map(
        (definition): Entry => ({
          id: definition.kind,
          group: 'Actions',
          label: `Show ${definition.label.toLowerCase()}`,
          hint: definition.kind === 'changes' ? '⇧⌘D' : undefined,
          /* The view's own sentence, so "tokens" still finds Trajectory. */
          keywords: definition.hint,
          icon: <definition.icon size={14} />,
          run: () => {
            close()
            store.showView(definition.kind)
          },
        }),
      ),
      {
        id: 'sidebar',
        group: 'Actions',
        label: snapshot.sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar',
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
          label: `Settings › ${entry.label}`,
          hint: entry.section === 'agents' ? '⌘,' : undefined,
          icon: entry.icon,
          keywords: `settings ${entry.keywords}`,
          run: () => {
            close()
            host.openSettings(entry.section)
          },
        }),
      ),
    ]

    // Named by account where an agent has more than one, or two accounts of
    // one Codex would offer the same sentence twice.
    const agents: Entry[] = snapshot.runtimes.map((runtime) => ({
      id: `agent-${runtime.id}`,
      group: 'Agents',
      label: `Start with ${runtimeLabel(runtime, snapshot.runtimes, snapshot.accountsByRuntime, snapshot.accountPrefs)}`,
      hint: runtime.id === snapshot.activeRuntime ? 'current' : runtime.presentation.tagline,
      icon: <RuntimeMark runtime={runtime} />,
      keywords: `switch agent ${brandOf(runtime.presentation.name)}`,
      run: () => {
        close()
        if (runtime.id !== snapshot.activeRuntime) void store.selectRuntime(runtime.id)
        else store.newDraft()
      },
    }))

    const needle = query.trim()
    const sessionEntryFrom = (summary: SessionSummary): Entry => {
      const agent = snapshot.runtimes.find((entry) => entry.id === summary.runtime)?.presentation.name ?? summary.runtime
      const folder = summary.cwd.split('/').filter(Boolean).at(-1) ?? summary.cwd
      // The transcript store's own matching line wins over one re-derived
      // from the title and preview: it is from the conversation's content.
      const content = contentHits.get(`${summary.runtime}-${summary.id}`)
      const hit = needle ? extractHit(needle, `${summary.title ?? ''}\n${summary.preview ?? ''}`) : null
      return {
        id: `session-${summary.runtime}-${summary.id}`,
        group: 'Sessions',
        label: sessionLabel(summary.title, summary.preview),
        hint: `${brandOf(agent)} · ${folder}${summary.git?.branch ? ` · ${summary.git.branch}` : ''}`,
        icon: <SessionIcon size={14} />,
        keywords: `${folder} ${agent} ${summary.preview ?? ''}`,
        ...(content
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
    const sessions: Entry[] = combined.map(sessionEntryFrom)

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
      label: `/${command.name}`,
      hint: command.description,
      icon: <SlashIcon size={14} />,
      run: () => {
        close()
        compose(`/${command.name} `)
      },
    }))

    return [...actions, ...agents, ...sessions, ...fileEntries, ...commands]
  }, [contentHits, files, host, query, searchResults, snapshot, store])

  const shown = useMemo(() => {
    const needle = query.trim()
    if (!needle) {
      // Nothing typed: the actions, the agents, and the latest few sessions.
      return [
        ...entries.filter((entry) => entry.group === 'Actions' || entry.group === 'Agents'),
        ...entries.filter((entry) => entry.group === 'Sessions').slice(0, 6),
      ]
    }
    // Flat results: score everything and show the best matches without
    // per-group caps, sorted by score. Sessions with a content match from
    // the search backend get a boost.
    const scored = entries
      .map((entry) => ({
        entry,
        score: score(needle, entry.label, `${entry.keywords ?? ''} ${entry.hint ?? ''}`)
          + (entry.matchLine ? 20 : 0),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40)
    return scored.map((item) => item.entry)
  }, [entries, query])

  // A fresh query starts back at the top, and the highlight then locks to
  // whichever entry leads that first paint: results that arrive later may
  // insert rows above it, but they cannot move the highlight off the row the
  // user is looking at.
  useEffect(() => setActiveId(null), [query])
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

  const run = (index: number): void => {
    const entry = shown[index]
    if (entry) entry.run()
  }

  let lastGroup: Entry['group'] | null = null

  return (
    <div className={styles.backdrop} onPointerDown={host.close}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className={styles.inputRow}>
          <SearchIcon size={15} className={styles.inputIcon} />
          <input
            ref={input}
            className={styles.input}
            autoFocus
            placeholder="Search sessions, files, agents, commands, actions…"
            value={query}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                moveActive(1)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                moveActive(-1)
              } else if (event.key === 'Enter') {
                event.preventDefault()
                run(active)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                host.close()
              }
            }}
          />
          <kbd className={styles.kbd}>esc</kbd>
        </div>
        <div className={styles.list} ref={list} role="listbox">
          {shown.length === 0 && <div className={styles.empty}>Nothing matches “{query}”.</div>}
          {shown.map((entry, index) => {
            const header = entry.group !== lastGroup ? entry.group : null
            lastGroup = entry.group
            return (
              <div key={entry.id}>
                {header && <div className={styles.group}>{header}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  className={styles.row}
                  {...(index === active ? { 'data-active': '' } : {})}
                  onMouseEnter={() => setActiveId(entry.id)}
                  onClick={() => run(index)}
                >
                  <span className={styles.rowIcon}>{entry.icon}</span>
                  <span className={styles.rowLabel}>{entry.label}</span>
                  {entry.hint && <span className={styles.rowHint}>{entry.hint}</span>}
                  {entry.matchLine && (
                    <span className={styles.rowMatch}>
                      {entry.matchStart != null && entry.matchEnd != null ? (
                        <>
                          {entry.matchLine.slice(0, entry.matchStart)}
                          <mark className={styles.mark}>{entry.matchLine.slice(entry.matchStart, entry.matchEnd)}</mark>
                          {entry.matchLine.slice(entry.matchEnd)}
                        </>
                      ) : entry.matchLine}
                    </span>
                  )}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
