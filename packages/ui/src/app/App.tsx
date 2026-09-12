import { useCallback, useEffect, useRef, useState } from 'react'

import type { RuntimeId } from '@harnessdesk/protocol'

import { desktop, isDesktop, onOpenSession, onShortcut, setTraySummary, setWindowTitle } from '../lib/desktop'
import { sessionLabel, shortLabel } from '../lib/sessions'
import { describeTray } from '../lib/tray'
import { shortcutFor } from '../lib/shortcuts'
import { Workbench } from '../panels/Workbench'
import { ShellProvider } from '../panels/views'
import { ImportOffer } from '../components/ImportOffer'
import { Toaster } from '../design/ui'
import { Notices, StatusBanner } from '../components/Notices'
import { ChangesReview } from '../components/ChangesReview'
import { CommandPalette } from '../components/CommandPalette'
import { FolderPicker } from '../components/FolderPicker'
import { resolveSection, Settings, type Section } from '../components/Settings'
import { NewWorktree } from '../components/NewWorktree'
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
          setSettingsOpen('agents')
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
    [store, snapshot.layout.focused],
  )

  useEffect(() => onShortcut(run), [run])

  // A settings page asked for from somewhere deep — the composer's model menu
  // — opens here, where the window state lives, and the request is cleared so
  // closing the window does not reopen it.
  useEffect(() => {
    if (!snapshot.settingsFor) return
    setSettingsOpen(resolveSection(snapshot.settingsFor))
    store.askSettings(null)
  }, [snapshot.settingsFor, store])

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
    const offShow = bridge?.onBrowserShow?.(({ url }) => store.openBrowser(url === 'about:blank' ? undefined : url)) ?? (() => {})
    const offClose = bridge?.onBrowserClose?.(() => store.closeBrowser()) ?? (() => {})
    const offFocus = bridge?.onBrowserFocus?.(() => store.focusDrivenBrowserTab()) ?? (() => {})
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
  useEffect(() => {
    const stack = notices.current
    const area = stack?.parentElement
    if (!stack || !area) return
    const apply = (): void => {
      const height = stack.getBoundingClientRect().height
      area.style.setProperty('--hd-notice-inset', height > 0 ? `${Math.ceil(height) + 10}px` : '0px')
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(stack)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="hd-shell">
      <div className="hd-shellBody">
        {/*
         * One shell, one set of actions.
         *
         * The four callbacks below used to be threaded down through `Panes`,
         * every pane and the team room to reach a conversation. They are a
         * context now, which is what lets a feature be mounted in any panel
         * without somebody first remembering to pass its props along a fourth
         * path. See `panels/views.tsx`.
         */}
        <ShellProvider
          actions={{
            chooseProject: chooseFolder,
            signIn: (runtime) => setSignInOpen(runtime ?? true),
            openUsage: (runtime) => setUsageOpen(runtime),
            openAgents: () => setSettingsOpen('agents'),
          }}
        >
          <Workbench
            sidebar={
              <Sidebar
                onOpenSettings={(section) => setSettingsOpen(section ?? 'agents')}
                onOpenPlugins={() => setSettingsOpen('plugins')}
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
          <div className="hd-floatingNotices" data-over-conversation ref={notices}>
            <StatusBanner onSignIn={() => setSignInOpen(true)} />
            <ImportOffer
              onReview={() => {
                setLibraryImport(true)
                setSettingsOpen('library')
              }}
            />
          </div>
        </ShellProvider>
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
          libraryImport={libraryImport}
          onSection={setSettingsOpen}
          onClose={() => {
            setSettingsOpen(false)
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
      {paletteOpen && (
        <CommandPalette
          host={{
            close: () => setPaletteOpen(false),
            chooseFolder,
            openSettings: (section) => setSettingsOpen(section),
            openUsage: () => setUsageOpen(true),
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
  )
}
