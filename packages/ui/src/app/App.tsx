import { MainPages, isMainPage } from './MainPages'
import { destinationForSettings } from './settings-destination'
import type { PageDestination } from '../state/destinations'
import { toggleTerminal } from '../components/TerminalToggle'
import { TopBarProvider } from '../panels/top-bar'
import { ShellHostsProvider, ShellOutlets } from '../panels/shell-hosts'
import { useCallback, useEffect, useState } from 'react'

import type { RuntimeId } from '@harnessdesk/protocol'

import { desktop, isDesktop, onOpenGoal, onOpenSession, onShortcut, setTraySummary, setWindowTitle } from '../lib/desktop'
import { sessionLabel, shortLabel } from '../lib/sessions'
import { describeTray } from '../lib/tray'
import { shortcutFor } from '../lib/shortcuts'
import { Workbench } from '../panels/Workbench'
import { ShellProvider } from '../panels/views'
import { Toaster } from '../design'
import { Notices } from '../components/Notices'
import { CommandPalette } from '../components/CommandPalette'
import { FolderPicker } from '../components/FolderPicker'
import { FrontDoor } from '../components/FrontDoor'
import { resolveSection, type Section } from '../components/Settings'
import { NewWorktree } from '../components/NewWorktree'
import { SeatSheet } from '../components/SeatSheet'
import { RaceStart } from '../components/RaceStart'
import { projectRootOf } from '../lib/projects'
import { routeFor } from './seat-fixes'
import { Sidebar } from '../components/Sidebar'
import { SignIn } from '../components/SignIn'
import { type DashboardView } from '../components/Usage'
import { useActiveSession, useSnapshot, useStore } from '../state/context'
import { useTheme } from '../state/theme'

/**
 * Where an entry point that names one account lands on the Dashboard.
 *
 * `undefined` — ⌘U, the sidebar's own Dashboard row, ⌘K, the menu bar item —
 * opens across every account, on Overview, the whole story. A runtime named
 * — an account's own "Usage", a fix routed here — is "tell me about this one
 * account", which is what the rail's per-account row used to answer by
 * itself; now that is Plans, scoped. Exported and tested on its own: the
 * mapping is the one part of "every entry point opens the right view" worth
 * a unit rather than a render.
 */
export const dashboardRouteFor = (
  runtime?: RuntimeId,
): { view: DashboardView; scope: RuntimeId | null } =>
  runtime ? { view: 'plans', scope: runtime } : { view: 'overview', scope: null }

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
  // Each explicit import request is consumed once by the retained Library body.
  const projectKey = snapshot.workspace?.path ?? 'unscoped'
  const [libraryImport, setLibraryImport] = useState({ project: projectKey, intent: 0 })
  if (libraryImport.project !== projectKey) setLibraryImport({ project: projectKey, intent: 0 })
  const libraryImportIntent = libraryImport.project === projectKey ? libraryImport.intent : 0
  const [foldersOpen, setFoldersOpen] = useState(false)
  // The front door, opened on one project at a time — from the palette today,
  // and from any other place-scoped entry point that hands over its own
  // resolved `root` rather than opening a chooser of its own. `null` is
  // closed; this is the one instance the app renders for it.
  const [frontDoorRoot, setFrontDoorRoot] = useState<string | null>(null)
  const openFrontDoor = useCallback((root: string) => { setFrontDoorRoot(root) }, [])
  // `true` opens the sign-in page where it thinks best; a runtime id pins it.
  const [signInOpen, setSignInOpen] = useState<boolean | RuntimeId>(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const openPage = useCallback((target: PageDestination) => store.openDestination(target), [store])
  const openSettingsAt = useCallback((section: Section, focus: string | null) => {
    const target=destinationForSettings(section,focus)
    openPage(target)
  },[openPage])
  const openAgents = useCallback((focus?:string)=>openPage({kind:'agents',id:focus??null}),[openPage])
  const openTeams = useCallback(()=>openPage({kind:'teams',filter:'active'}),[openPage])
  const openUsage = useCallback((runtime?:RuntimeId)=>openPage({kind:'dashboard',...dashboardRouteFor(runtime)}),[openPage])
  useEffect(()=>{
    const open=():void=>{ store.openReview() }
    window.addEventListener('harnessdesk:review',open)
    return ()=>window.removeEventListener('harnessdesk:review',open)
  },[store])
  useEffect(() => {
    const open = (): void => setPaletteOpen(true)
    window.addEventListener('harnessdesk:search', open)
    return () => window.removeEventListener('harnessdesk:search', open)
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
      if (name?.startsWith('tile-')) {
        window.dispatchEvent(new CustomEvent('hd-side-by-side', { detail: name }))
        return
      }
      switch (name) {
        case 'new-team': {
          const root = projectRootOf(snapshot.workspace)
          if (root) openFrontDoor(root)
          else store.notice('warning', 'Open a folder to start one.')
          return
        }
        case 'new-session':
          store.newDraft()
          return
        case 'open-folder':
          setFoldersOpen(true)
          return
        case 'toggle-terminal':
          toggleTerminal(store)
          return
        case 'toggle-sidebar':
          store.toggleSidebar()
          return
        case 'nav-back':
          if (snapshot.workbench.navigation.current.kind === 'settings') void store.leaveSettings()
          else void store.navigateBack()
          return
        case 'nav-forward':
          if (snapshot.workbench.navigation.current.kind !== 'settings') void store.navigateForward()
          return
        case 'show-changes':
          store.setDetailsTab('changes')
          return
        case 'settings':
          openSettingsAt('general', null)
          return
        case 'sign-in':
          setSignInOpen((subject as RuntimeId | undefined) ?? true)
          return
        case 'usage':
          // ⌘U toggles, and always across every agent on Overview — a scoped
          // view is something you ask for by pointing at one.
          if (snapshot.workbench.navigation.current.kind==='dashboard') store.returnToWork()
          else openUsage()
          return
        case 'close-pane':
          if(snapshot.workbench.navigation.current.kind!=='work')store.returnToWork()
          else store.closePane(snapshot.layout.focused)
          return
        case 'palette':
          setPaletteOpen((value) => !value)
          return
      }
    },
    [store, snapshot.layout.focused, snapshot.workspace, snapshot.workbench.navigation.current, openFrontDoor, openSettingsAt, openUsage],
  )

  useEffect(() => onShortcut(run), [run])

  // Menus and dialogs consume Escape first. The former window destinations
  // keep their departure key after those controls have released it.
  useEffect(() => {
    const leavePage = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const kind = store.getSnapshot().workbench.navigation.current.kind
      if (kind !== 'settings' && kind !== 'library' && kind !== 'plugins' && kind !== 'dashboard' && kind !== 'changes-review') return
      event.preventDefault()
      if (kind === 'settings') void store.leaveSettings()
      else store.returnToWork()
    }
    window.addEventListener('keydown', leavePage)
    return () => window.removeEventListener('keydown', leavePage)
  }, [store])

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
    else if (route.kind === 'usage') openUsage(route.runtime)
    else if (route.kind === 'agent') openAgents(route.agent)
    else openSettingsAt(route.section, route.focus)
  }, [snapshot.seatFix, store, openSettingsAt, openAgents, openUsage])

  // A clicked macOS notification lands on the conversation it was about.
  useEffect(
    () =>
      onOpenSession(({ runtime, sessionId }) => {
        void store.openSession(sessionId as Parameters<typeof store.openSession>[0], {
          runtime: runtime as RuntimeId,
        })
      }),
    [store],
  )
  useEffect(() => onOpenGoal(({ goal }) => {store.openGoal(goal)}), [store])

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

  const [leftFilter, setLeftFilter] = useState('')
  const current=snapshot.workbench.navigation.current
  const pageActive=current.kind!=='work' && isMainPage(current.kind)
  const settingsSection:Section|null=current.kind!=='settings'?null:current.route.kind==='section'?current.route.section
    :current.route.kind==='project'?'workspaces':current.route.kind==='skill'?'skills':'runtimes'
  const renderLeftColumn=()=><Sidebar active
    listFilter={{value:leftFilter,onChange:setLeftFilter}} sessionsOwner
    onOpenSettings={section=>openSettingsAt(section??'runtimes',null)} onOpenLibrary={()=>openSettingsAt('library',null)} onOpenPlugins={()=>openSettingsAt('plugins',null)}
    onOpenAgents={()=>openAgents()} onOpenTeams={openTeams} onOpenUsage={openUsage} onBrowseFolders={chooseFolder}
    onSignIn={runtime=>setSignInOpen(runtime??true)} onSearch={()=>setPaletteOpen(true)}
    activeDestination={pageActive && current.kind!=='settings' && current.kind!=='changes-review'?current.kind
      :null}
    settings={pageActive && settingsSection?{section:settingsSection,onSection:section=>openSettingsAt(section,null),
      onBack:()=>{void store.leaveSettings()}}:undefined}/>
  const frameOwner=(pageActive?`destination:${current.kind}`:null)
  return (
    /* One shell, one set of actions — including retained main pages. A project page lives in Settings, and its Agent
       rows must reach the same window as the left menu rather than falling
       outside the provider into its inert default. */
    <ShellProvider
      actions={{
        chooseProject: chooseFolder,
        signIn: (runtime) => setSignInOpen(runtime ?? true),
        openUsage,
        openRuntimes: () => openSettingsAt('runtimes', null),
        openAgents,
        reviewImports: () => {
          setLibraryImport(current => ({project:projectKey,intent:(current.project===projectKey?current.intent:0)+1}))
          openSettingsAt('library', null)
        },
      }}
    >
    <TopBarProvider><ShellHostsProvider><div className="hd-shell">
      <div className="hd-shellBody">
          <Workbench sidebar={renderLeftColumn()} pageActive={pageActive}
            pages={<MainPages key={snapshot.workspace?.path??'unscoped'}
              onSignIn={runtime=>setSignInOpen(runtime)} onNewTeam={()=>{const root=projectRootOf(snapshot.workspace);if(root)openFrontDoor(root)}} libraryImportIntent={libraryImportIntent}/>} />
      </div>
      {/* Results, and failures the store could not say in place, as toasts:
          `Notices` hands the store's queue to the one toaster. Standing
          notices are drawn where they are about — the composer, the strip
          above the panes, the sidebar's foot — never floated over a pane. */}
      <Notices />
      <Toaster theme={theme} />
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
            openUsage: () => openUsage(),
            openAgents,
            openTeams,
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
      <ShellOutlets activeOwner={frameOwner} hostOwner={pageActive?'work':undefined} />
    </div></ShellHostsProvider></TopBarProvider>
    </ShellProvider>
  )
}
