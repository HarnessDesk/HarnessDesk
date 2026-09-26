import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { RuntimeId } from '@harnessdesk/protocol'

import { desktop, isDesktop, onOpenGoal, onOpenSession, onShortcut, setTraySummary, setWindowTitle } from '../lib/desktop'
import { sessionLabel, shortLabel } from '../lib/sessions'
import { describeTray } from '../lib/tray'
import { shortcutFor } from '../lib/shortcuts'
import { Workbench } from '../panels/Workbench'
import { ShellProvider } from '../panels/views'
import { ImportOffer } from '../components/ImportOffer'
import { GoalMigrationBanner } from '../components/GoalMigrationBanner'
import { Toaster } from '../design'
import { Notices, StatusBanner } from '../components/Notices'
import { ChangesReview } from '../components/ChangesReview'
import { CommandPalette } from '../components/CommandPalette'
import { FolderPicker } from '../components/FolderPicker'
import { FrontDoor } from '../components/FrontDoor'
import { resolveSection, Settings, type Section } from '../components/Settings'
import { NewWorktree } from '../components/NewWorktree'
import { SeatSheet } from '../components/SeatSheet'
import { RaceStart } from '../components/RaceStart'
import { projectRootOf } from '../lib/projects'
import { NOTICE_BAR_SELECTOR, NOTICE_FLOOR, NOTICE_GAP, noticePlacement } from '../lib/notice-bounds'
import { AgentsWindow } from '../components/AgentsWindow'
import { routeFor } from './seat-fixes'
import { Sidebar } from '../components/Sidebar'
import { SignIn } from '../components/SignIn'
import { Usage } from '../components/Usage'
import { useActiveSession, useSnapshot, useStore } from '../state/context'
import { useTheme } from '../state/theme'

/**
 * The application shell.
 *
 * Global shortcuts live here rather than in individual views so they work no
 * matter what has focus — the approval dialog is the one exception, and it
 * claims its own keys while open.
 */

export const App = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  const session = useActiveSession()
  // Whether Settings is open, and the page it is on: one piece of state, not
  // two. Every route into Settings sets it — the app menu, ⌘K opened over the
  // window, the import banner, a deep `askSettings` — and so does the nav
  // rail inside the window, through `onSection`. Held in both places, a
  // request naming the page this one already held could not move the window,
  // because nothing here changed and so neither did the prop.
  const [settingsOpen, setSettingsOpen] = useState<false | Section>(false)
  // The thing the page was opened on. Keep it with the route until a person
  // chooses another Settings page or closes the window: clearing it in an
  // effect made the one-shot race the store request that opened the window,
  // and Strict Mode could mount Workspaces only after the project was gone.
  const [settingsFocus, setSettingsFocus] = useState<string | null>(null)
  const openSettingsAt = useCallback((section: Section, focus: string | null) => {
    setSettingsOpen(section)
    setSettingsFocus(focus)
  }, [])
  /**
   * The Agents window (Task 13's owner decision: the roster lives in the left
   * menu, never in Settings) — `false`, or open on the Agent named by `focus`
   * (`null` for the overview). Set here because the refusal sheet's *Edit
   * seats for this Mac* and the palette's *Open <Agent>* both need a door to
   * it before the window itself exists; Task 13 reads this state and draws it.
   */
  const [agentsOpen, setAgentsOpen] = useState<false | { focus: string | null }>(false)
  const openAgents = useCallback((focus?: string) => {
    // Top-level destinations replace one another. In particular, a project
    // Agent row lives inside Settings but opens the app's one Agents window;
    // leaving Settings underneath made Back return to the page it had left.
    setSettingsOpen(false)
    setSettingsFocus(null)
    setAgentsOpen({ focus: focus ?? null })
  }, [])
  // One-shot: the import banner routes here, and the Library opens with the
  // import flow already up. Cleared when Settings closes, like any dialog.
  const [libraryImport, setLibraryImport] = useState(false)
  // A one-shot: once the Library section has mounted and read the intent, drop
  // it, so navigating away in Settings and back does not reopen the import
  // dialog unbidden. The child captured it during that first render; clearing
  // the flag afterward leaves the open dialog untouched.
  useEffect(() => {
    if (libraryImport) setLibraryImport(false)
  }, [libraryImport])
  const [foldersOpen, setFoldersOpen] = useState(false)
  // The front door, opened on one project at a time — from the palette today,
  // and from any other place-scoped entry point that hands over its own
  // resolved `root` rather than opening a chooser of its own. `null` is
  // closed; this is the one instance the app renders for it.
  const [frontDoorRoot, setFrontDoorRoot] = useState<string | null>(null)
  const openFrontDoor = useCallback((root: string) => setFrontDoorRoot(root), [])
  // `true` opens the sign-in page where it thinks best; a runtime id pins it.
  const [signInOpen, setSignInOpen] = useState<boolean | RuntimeId>(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  // `true` opens Usage across every agent; a runtime id opens it on that one.
  const [usageOpen, setUsageOpen] = useState<boolean | RuntimeId>(false)
  // The review workspace opens from anywhere — the Changes panel, ⌘K —
  // through one event, the way the composer takes text.
  const [reviewOpen, setReviewOpen] = useState(false)
  useEffect(() => {
    const open = (): void => setReviewOpen(true)
    window.addEventListener('harnessdesk:review', open)
    return () => window.removeEventListener('harnessdesk:review', open)
  }, [])
  // The resolved face, for anything that needs telling rather than styling —
  // Sonner paints its own surface and takes the theme as a value.
  const theme = useTheme()
  // One way to choose a folder per build: the desktop app uses the system
  // dialog, as Claude Code and Codex do; the browser build, which has none,
  // gets the in-app picker. The picker is also the fallback should the
  // native dialog be unavailable, so no entry point can dead-end.
  const chooseFolder = useCallback(() => {
    if (!isDesktop()) {
      setFoldersOpen(true)
      return
    }
    void store.pickWorkspace().catch(() => setFoldersOpen(true))
  }, [store])

  // Menu commands and in-page shortcuts run the same handlers, so there is one
  // implementation of each action rather than two that can drift.
  const run = useCallback(
    (action: string) => {
      // A menu item may name what it acts on — `sign-in:codex` is the panel's
      // row for one agent, `sign-in` the app menu's item for whichever needs it.
      const [name, subject] = action.split(':')
      switch (name) {
        case 'new-session':
          store.newDraft()
          return
        case 'open-folder':
          setFoldersOpen(true)
          return
        case 'toggle-sidebar':
          store.toggleSidebar()
          return
        case 'nav-back':
          void store.navigateBack()
          return
        case 'nav-forward':
          void store.navigateForward()
          return
        case 'show-changes':
          store.setDetailsTab('changes')
          return
        case 'settings':
          openSettingsAt('runtimes', null)
          return
        case 'sign-in':
          setSignInOpen((subject as RuntimeId | undefined) ?? true)
          return
        case 'usage':
          // ⌘U toggles, and always across every agent — a scoped view is
          // something you ask for by pointing at one.
          setUsageOpen((open) => open === false)
          return
        case 'close-pane':
          store.closePane(snapshot.layout.focused)
          return
        case 'palette':
          setPaletteOpen((value) => !value)
          return
      }
    },
    [store, snapshot.layout.focused, openSettingsAt],
  )

  useEffect(() => onShortcut(run), [run])

  // A settings page asked for from somewhere deep — the composer's model menu
  // — opens here, where the window state lives, and the request is cleared so
  // closing the window does not reopen it.
  useEffect(() => {
    if (!snapshot.settingsFor) return
    openSettingsAt(resolveSection(snapshot.settingsFor), snapshot.settingsFocus)
    store.askSettings(null)
  }, [snapshot.settingsFor, snapshot.settingsFocus, store, openSettingsAt])

  // A fix asked for from anywhere — the refusal sheet, an Agent's page, a
  // name card — goes where it is fixed, from here, where the sign-in, the
  // usage window and Settings live (and, once Task 13 lands, the Agents
  // window).
  useEffect(() => {
    const asked = snapshot.seatFix
    if (!asked) return
    store.askSeatFix(null)
    const route = routeFor(asked.fix, asked.agent)
    if (route.kind === 'signIn') setSignInOpen(route.runtime)
    else if (route.kind === 'usage') setUsageOpen(route.runtime)
    else if (route.kind === 'agent') openAgents(route.agent)
    else openSettingsAt(route.section, route.focus)
  }, [snapshot.seatFix, store, openSettingsAt, openAgents])

  // A clicked macOS notification lands on the conversation it was about.
  useEffect(
    () =>
      onOpenSession(({ runtime, sessionId }) =>
        void store.openSession(sessionId as Parameters<typeof store.openSession>[0], {
          runtime: runtime as RuntimeId,
        }),
      ),
    [store],
  )
  useEffect(() => onOpenGoal(({ goal }) => store.openGoal(goal)), [store])

  /**
   * The menu bar's status item.
   *
   * Sent from here rather than computed in the shell: the renderer already
   * knows what every plan has left and whether an agent has an account, and
   * a second source for the same number is a second number. What it says is
   * decided in `lib/tray.ts`; the shell only draws it.
   */
  useEffect(() => {
    if (!isDesktop()) return
    const send = (): void =>
      setTraySummary(
        describeTray({
          runtimes: snapshot.runtimes,
          usage: snapshot.usage,
          accountsByRuntime: snapshot.accountsByRuntime,
          accountPrefs: snapshot.accountPrefs,
          health: snapshot.health,
          activeRuntime: snapshot.activeRuntime,
          now: Date.now(),
        }),
      )
    send()
    // "resets in 3h" goes stale on its own, and the menu is opened hours after
    // the last snapshot arrived. A minute is the resolution of what it says.
    const timer = window.setInterval(send, 60_000)
    return () => window.clearInterval(timer)
  }, [
    snapshot.runtimes,
    snapshot.usage,
    snapshot.accountsByRuntime,
    snapshot.accountPrefs,
    snapshot.health,
    snapshot.activeRuntime,
  ])

  useEffect(() => {
    const open = (): void => setFoldersOpen(true)
    window.addEventListener('harnessdesk:browse-folders', open)
    return () => window.removeEventListener('harnessdesk:browse-folders', open)
  }, [])

  // The desktop shell asks for the browser pane when an agent's browser tool
  // needs a page and none is open, for it to go when the tool closes it, and
  // for the driven tab to come to the front before every command — a
  // `<webview>` nobody is looking at stops painting, and screenshots blank.
  useEffect(() => {
    const bridge = desktop()
    const offShow = bridge?.onBrowserShow?.(({ url, profile }) =>
      store.openBrowser(url === 'about:blank' ? undefined : url, { profile })) ?? (() => {})
    const offClose = bridge?.onBrowserClose?.(({ profile }) => store.closeBrowser(profile)) ?? (() => {})
    const offFocus = bridge?.onBrowserFocus?.(({ profile, request }) => {
      store.focusDrivenBrowserTab(profile)
      requestAnimationFrame(() => requestAnimationFrame(() => bridge.browserFocused?.(request)))
    }) ?? (() => {})
    // A download a page started lands in the Downloads folder; the notice
    // says so, and offers the file. Listened for here rather than in the
    // pane, because a download outlives the tab that began it.
    const offDownload =
      bridge?.onBrowserDownload?.((outcome) =>
        store.notice(
          outcome.ok ? 'info' : 'warning',
          outcome.message,
          outcome.ok && bridge.revealDownload
            ? { label: 'Show in Finder', run: () => bridge.revealDownload?.(outcome.path) }
            : undefined,
        ),
      ) ?? (() => {})
    return () => {
      offShow()
      offClose()
      offFocus()
      offDownload()
    }
  }, [store])

  // A window coming back after a while re-asks the agent what it offers —
  // the user may have upgraded it in the meantime, or the vendor added a
  // model — but only when the last answer is old enough to doubt.
  useEffect(() => {
    const back = (): void => {
      if (document.visibilityState === 'visible') void store.refreshCatalogIfStale()
    }
    window.addEventListener('focus', back)
    document.addEventListener('visibilitychange', back)
    return () => {
      window.removeEventListener('focus', back)
      document.removeEventListener('visibilitychange', back)
    }
  }, [store])

  // The window title tracks the session so it is meaningful in Mission Control
  // and the Window menu. Those places cannot ellipsize, and an untitled
  // conversation's label is the user's whole opening message, so it is
  // shortened here rather than left to overrun the menu.
  useEffect(() => {
    setWindowTitle(session ? shortLabel(sessionLabel(session.title, session.preview, 'HarnessDesk')) : 'HarnessDesk')
  }, [session?.title, session?.preview])

  // One table decides which chords exist; this dispatches from it, and the
  // Keyboard shortcuts page prints the same rows. Two lists is the
  // arrangement where a page documents a key that stopped working.
  //
  // The whole event goes to `shortcutFor`, not its key and modifiers, because
  // part of the answer is whether anything has already handled it. ⌘[ in the
  // file editor outdents; without that check it would outdent *and* navigate
  // away from the file being edited.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const shortcut = shortcutFor(event)
      if (!shortcut) return
      event.preventDefault()
      run(shortcut.action)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [run])

  // Standing notices float over the pane area so they never fight the traffic
  // lights, but a card over the first message is a card over the first
  // message: the transcript learns the stack's height and starts below it.
  const notices = useRef<HTMLDivElement | null>(null)
  /*
   * The placement effect's own `apply`, latest version — set by that effect
   * below, called from this one. A margin driven by `--hd-notice-inset` can
   * move the very bar the placement effect clears (a conversation's header,
   * a room's), without resizing it — a margin only shifts a box, and
   * `ResizeObserver` fires on a size change — so nothing would otherwise ask
   * the placement effect to look again. Calling it here, synchronously,
   * right after the inset is written, is what a shared `ResizeObserver` on
   * the same element could only promise by relying on two different
   * observers happening to run in the right order; a plain function call
   * says so outright.
   */
  const repositionNotices = useRef<() => void>(() => {})
  useEffect(() => {
    const stack = notices.current
    const area = stack?.parentElement
    if (!stack || !area) return
    const apply = (): void => {
      const height = stack.getBoundingClientRect().height
      /*
       * `NOTICE_FLOOR + NOTICE_GAP`, not a flat cushion: a pane that yields
       * (`[data-notice-yield]` below) mounts whatever a screen draws — a
       * header included — from its own top, the same baseline the stack
       * itself measures `NOTICE_FLOOR` from. Reserving only the card's own
       * height pushed that header down by less than the stack's own top
       * offset, so the two still overlapped by exactly that difference: a
       * conversation's header, moved to sit partly under the card it was
       * clear of before anything yielded to it. Reserving the same floor the
       * stack itself starts behind, plus its usual clearance, means whatever
       * yields always ends up at or past the stack's own bottom, however
       * little or much sits above it before the push.
       */
      area.style.setProperty(
        '--hd-notice-inset',
        height > 0 ? `${Math.ceil(height) + NOTICE_FLOOR + NOTICE_GAP}px` : '0px',
      )
      repositionNotices.current()
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(stack)
    return () => observer.disconnect()
  }, [])

  /*
   * A standing banner rides the pane being read (#896) — `noticeArea` in
   * `state/workbench.ts` says which one, from the layout model, and marks it
   * `[data-notice-host]`: the split tree's expanded or first pane, or the
   * panel a zoom or a narrow window has given the room. This reads that box
   * live rather than reconstructing it from saved sizes, which a zoom or a
   * narrow window overrides without changing, and `noticePlacement` keeps
   * the stack at a readable width and below every bar it would otherwise lie
   * across, so it never takes a click meant for another pane's toolbar. The
   * observers fire for a window resize, a split drag, a zoom or a panel
   * opening alike; the effect itself only runs again when the marked element
   * could be a different one.
   */
  useLayoutEffect(() => {
    const stack = notices.current
    const area = stack?.parentElement
    if (!stack || !area) return
    const content = document.querySelector<HTMLElement>('[data-notice-bounds]')
    const host = document.querySelector<HTMLElement>('[data-notice-host]')
    const apply = (): void => {
      const box = area.getBoundingClientRect()
      const bars = [...document.querySelectorAll<HTMLElement>(NOTICE_BAR_SELECTOR)]
        // A hidden tab, a zoomed-away area or the collapsed half of an
        // expansion keeps its box but is not on screen; a header inside a
        // notice is the stack's own, and would only chase it down the page.
        .filter((bar) => !stack.contains(bar) && (bar.checkVisibility?.({ visibilityProperty: true }) ?? true))
        .map((bar) => bar.getBoundingClientRect())
      const placement = noticePlacement({
        container: box,
        content: content?.getBoundingClientRect() ?? box,
        host: host?.getBoundingClientRect() ?? null,
        bars,
      })
      stack.style.left = `${placement.left}px`
      stack.style.right = `${placement.right}px`
      stack.style.top = `${placement.top}px`
    }
    repositionNotices.current = apply
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(area)
    if (content) observer.observe(content)
    if (host) observer.observe(host)
    // A bar that wraps onto a second line moves the edge the stack clears.
    for (const bar of document.querySelectorAll<HTMLElement>(NOTICE_BAR_SELECTOR)) observer.observe(bar)
    return () => {
      observer.disconnect()
      repositionNotices.current = () => {}
    }
  }, [snapshot.layout, snapshot.workbench, snapshot.narrowWindow])

  return (
    /* One shell, one set of actions — including the app windows mounted
       beside the workbench. A project page lives in Settings, and its Agent
       rows must reach the same window as the left menu rather than falling
       outside the provider into its inert default. */
    <ShellProvider
      actions={{
        chooseProject: chooseFolder,
        signIn: (runtime) => setSignInOpen(runtime ?? true),
        openUsage: (runtime) => setUsageOpen(runtime),
        openRuntimes: () => openSettingsAt('runtimes', null),
        openAgents,
      }}
    >
    <div className="hd-shell">
      <div className="hd-shellBody">
          <Workbench
            sidebar={
              <Sidebar
                onOpenSettings={(section) => openSettingsAt(section ?? 'runtimes', null)}
                onOpenPlugins={() => openSettingsAt('plugins', null)}
                onOpenAgents={() => openAgents()}
                onOpenUsage={(runtime) => setUsageOpen(runtime ?? true)}
                onBrowseFolders={chooseFolder}
                onSignIn={(runtime) => setSignInOpen(runtime ?? true)}
                onSearch={() => setPaletteOpen(true)}
              />
            }
          />
          {/* Banners float over the pane area instead of topping the window,
              where they would collide with the macOS traffic lights.

              Marked as floating over the conversation, and always rendered,
              even empty: a sidebar floating over a narrow window makes what
              is so marked inert with the conversation, so this stack goes
              under its curtain wherever it is drawn, and a notice raised while
              the sidebar is open arrives inside something already inert. */}
          <div
            className="hd-floatingNotices"
            data-over-conversation
            ref={notices}
          >
            <StatusBanner onSignIn={() => setSignInOpen(true)} />
            <GoalMigrationBanner />
            <ImportOffer
              onReview={() => {
                setLibraryImport(true)
                openSettingsAt('library', null)
              }}
            />
          </div>
      </div>
      <Notices />
      {/* Sonner, from the registry's `toast`. Mounted beside the notice stack
          rather than replacing it: `Notices` holds the four-lifetime policy and
          the escalating dismissal, which are product decisions and stay put.
          This is the surface for the other half &mdash; the things worth
          announcing that happen in the transport, nowhere near a component,
          and that a `toast()` call can reach from anywhere. */}
      <Toaster theme={theme} />
      {settingsOpen && (
        <Settings
          section={settingsOpen}
          focus={settingsFocus}
          libraryImport={libraryImport}
          onSection={(section) => openSettingsAt(section, null)}
          onClose={() => {
            setSettingsOpen(false)
            setSettingsFocus(null)
            setLibraryImport(false)
          }}
          onSignIn={(runtime) => setSignInOpen(runtime)}
        />
      )}
      {usageOpen && (
        <Usage
          onClose={() => setUsageOpen(false)}
          onSignIn={(runtime) => setSignInOpen(runtime)}
          runtime={typeof usageOpen === 'string' ? usageOpen : null}
        />
      )}
      {agentsOpen && (
        <AgentsWindow
          focus={agentsOpen.focus}
          onClose={() => setAgentsOpen(false)}
          onFocus={(id) => setAgentsOpen({ focus: id })}
        />
      )}
      {reviewOpen && <ChangesReview onClose={() => setReviewOpen(false)} />}
      {foldersOpen && <FolderPicker onClose={() => setFoldersOpen(false)} />}
      {/* One mount for a dialog three places raise: the sidebar's worktree
          menu, a project's context menu, and ⌘K. */}
      {snapshot.newWorktreeFor && (
        <NewWorktree
          root={snapshot.newWorktreeFor}
          onClose={() => store.askNewWorktree(null)}
        />
      )}
      {/* /race opens dialog state only; the store no longer picks a second
          runtime or creates two drafts itself — see AppStore.raceAgents. */}
      {snapshot.raceStart && projectRootOf(snapshot.workspace) && (
        <RaceStart
          root={projectRootOf(snapshot.workspace)!}
          task={snapshot.raceStart.task}
          onClose={() => store.closeRaceStart()}
        />
      )}
      {/* One mount for the sheet every door that starts an Agent can raise. */}
      {snapshot.seatRefusal && (
        <SeatSheet
          refusal={snapshot.seatRefusal}
          onClose={() => store.dismissSeatRefusal()}
          onFix={(fix) => {
            const agent = snapshot.seatRefusal?.agent ?? ''
            store.dismissSeatRefusal()
            store.askSeatFix(fix, agent)
          }}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          host={{
            close: () => setPaletteOpen(false),
            chooseFolder,
            openSettings: (section, focus) => openSettingsAt(section, focus ?? null),
            openUsage: () => setUsageOpen(true),
            openAgents,
            openFrontDoor,
          }}
        />
      )}
      {frontDoorRoot && (
        <FrontDoor
          context={{ kind: 'project', root: frontDoorRoot }}
          onClose={() => setFrontDoorRoot(null)}
          onStarted={(execution) => {
            store.openGoal(execution.goal)
            setFrontDoorRoot(null)
          }}
        />
      )}
      {signInOpen && (
        <SignIn
          {...(typeof signInOpen === 'string' ? { runtime: signInOpen } : {})}
          onClose={() => setSignInOpen(false)}
        />
      )}
    </div>
    </ShellProvider>
  )
}
