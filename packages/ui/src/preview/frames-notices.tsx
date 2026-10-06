import { useEffect, useMemo, useRef } from 'react'
import { reduceSession, type AgentEvent } from '@harnessdesk/protocol'
import { AppStore, type AppSnapshot } from '../state/store'
import { StoreProvider } from '../state/context'
import { useTheme } from '../state/theme'
import { Notices } from '../components/Notices'
import { NotificationsSection } from '../components/SettingsYou'
import { PaneColumn, Toaster } from '../design'
import { Workbench } from '../panels/Workbench'
import { ShellProvider } from '../panels/views'
import { Sidebar } from '../components/Sidebar'
import { PREVIEW_SESSION_KEY, store as fixture } from './harness'
import { emptyWorkbench } from '../state/workbench'

const config: AgentEvent = { type: 'notice', level: 'warning', message: 'Ignored configuration settings', kind: 'runtime:config', detail: { summary: 'Ignored configuration settings', settings: ['profiles.local.forced_login_method', 'profiles.local.base_url'], file: '/Users/user/.codex/config.toml', details: 'These settings are ignored.' } } as AgentEvent
const depreciation: AgentEvent = { type: 'notice', level: 'info', message: 'A setting you use is being retired', kind: 'runtime:deprecation', detail: { summary: 'A setting you use is being retired', settings: [], details: 'Use the current setting on your next configuration change.' } } as AgentEvent
const compacted: AgentEvent = { type: 'notice', level: 'info', sessionId: 's1', kind: 'conversation:compacted', message: 'Context was compacted to make room for more of this conversation.' } as AgentEvent

/** An isolated real store and placeholder transport: no desktop or vendor calls. */
export const NoticesFrame = () => {
  useTheme()
  const scene = new URLSearchParams(window.location.search).get('notices') ?? 'startup'
  const conversationScene = scene.startsWith('conversation-')
  const store = useMemo(() => {
    const own = new AppStore('ws://localhost:0/')
    const base = fixture.getSnapshot()
    const workbench = { ...emptyWorkbench(), main: { root: { kind: 'pane' as const, id: 'notice-conversation', view: { kind: 'conversation' as const, session: PREVIEW_SESSION_KEY } }, focused: 'notice-conversation', expanded: null } }
    const original = base.sessions.get(PREVIEW_SESSION_KEY)!
    const restoreScene = scene.startsWith('conversation-restore')
    const afterScene = scene.endsWith('-after')
    const emptyConversation = conversationScene
      ? {
          id: original.id,
          runtime: original.runtime,
          cwd: '/workspace/demo-project',
          status: { type: 'idle' as const },
          createdAt: original.createdAt,
          updatedAt: restoreScene ? original.createdAt + 1 : original.createdAt,
          turns: [],
          itemsLoaded: true,
        }
      : original
    const session = conversationScene && afterScene
      ? reduceSession(emptyConversation, { type: 'notice', sessionId: original.id, class: 'conversation', level: 'warning', message: 'A tool was unavailable when this conversation opened.', id: 'notice-preview-1' })
      : emptyConversation
    Object.assign(own.getSnapshot(), { ...base, home: conversationScene ? '/workspace' : '/Users/user', inbox: [], agentNotices: [], notices: [], health: { state: 'ready' }, workbench, layout: workbench.main, sessions: new Map([[PREVIEW_SESSION_KEY, session]]), activeSessionKey: PREVIEW_SESSION_KEY, preferencesLoaded: false } satisfies Partial<AppSnapshot>)
    const surface = window as unknown as { noticeReveals: unknown[] }
    surface.noticeReveals = []
    own.transport.request = (async (method: string, params: unknown) => {
      if (method === 'workspace/reveal') surface.noticeReveals.push(params)
      if (method === 'app/state/get') return {}
      if (method === 'session/read') return session
      if (method === 'session/list') return { data: [], nextCursor: null }
      if (method === 'workspace/recent') return []
      if (method === 'session/tasks') return []
      return null
    }) as typeof own.transport.request
    return own
  }, [])
  const started = useRef(false)
  useEffect(() => {
    ;(window as unknown as { noticeStore: AppStore }).noticeStore = store
    if (started.current) return
    started.current = true
    const handlers = (store.transport as unknown as { handlers: { onEvent(runtime: string, event: AgentEvent): void; onNotification(value: unknown): void } }).handlers
    void store.loadPreferences().then(() => {
      const workbench = { ...emptyWorkbench(), main: { root: { kind: 'pane' as const, id: 'notice-conversation', view: { kind: 'conversation' as const, session: PREVIEW_SESSION_KEY } }, focused: 'notice-conversation', expanded: null } }
      Object.assign(store.getSnapshot(), { workbench, layout: workbench.main, activeSessionKey: PREVIEW_SESSION_KEY })
      if (!conversationScene) {
        handlers.onEvent('codex', config)
        handlers.onEvent('codex', config)
        handlers.onEvent('codex', config)
        handlers.onEvent('codex', depreciation)
        if (new URLSearchParams(window.location.search).has('longNotice')) handlers.onEvent('codex', { type: 'notice', kind: 'runtime:warning', level: 'warning', message: 'A background configuration warning contains guidance that must stay readable all the way to the end of this long message, including the final instruction: check the configuration file before the next run.' })
        handlers.onEvent('codex', compacted)
        handlers.onNotification({ method: 'person/notice', params: { notice: { id: 'demo-agent', from: { runtime: 'codex', sessionId: 's1', name: 'Alpha' }, where: 'inbox', title: 'Alpha finished “Retry the checkout call”', body: 'All checks passed. The change is ready to review.', at: Date.now() - 90_000 } } })
      }
    })
  }, [conversationScene, scene, store])
  return <StoreProvider store={store}>
    <ShellProvider actions={{ chooseProject: () => {}, signIn: () => {}, openUsage: () => {}, openRuntimes: () => {}, openAgents: () => {}, reviewImports: () => {} }}>
      <div data-frame-id={`notices-${scene}`} className="h-screen bg-background">
        {scene === 'settings' ? <div className="min-h-full overflow-y-auto"><PaneColumn inset="reading"><NotificationsSection /></PaneColumn></div> : <Workbench sidebar={<Sidebar onOpenSettings={() => {}} onOpenPlugins={() => {}} onOpenAgents={() => {}} onOpenTeams={() => {}} onOpenUsage={() => {}} onBrowseFolders={() => {}} onSignIn={() => {}} onSearch={() => {}} />} />}
        <Notices />
        <Toaster />
      </div>
    </ShellProvider>
  </StoreProvider>
}
