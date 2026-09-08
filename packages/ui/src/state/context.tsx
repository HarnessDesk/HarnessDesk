import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react'

import {
  splitSessionKey,
  type RuntimeInfo,
  type Session,
  type SessionKey,
  type SessionQueue,
} from '@harnessdesk/protocol'

import type { PaneId, PaneView } from './layout'
import { focusedMount } from './workbench'
import type { AppSnapshot, AppStore } from './store'

/**
 * Store access.
 *
 * `useSyncExternalStore` rather than a reducer in context: the store is already
 * an external source of truth fed by a socket, and this is the API React
 * provides for exactly that shape.
 */

const StoreContext = createContext<AppStore | null>(null)

export const StoreProvider = ({
  store,
  children,
}: {
  store: AppStore
  children: ReactNode
}) => <StoreContext.Provider value={store}>{children}</StoreContext.Provider>

export const useStore = (): AppStore => {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useStore must be used inside a StoreProvider')
  return store
}

export const useSnapshot = (): AppSnapshot => {
  const store = useStore()
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

/** Selects a slice, re-rendering only when the selected value changes identity. */
export const useSelect = <T,>(select: (snapshot: AppSnapshot) => T): T => {
  const snapshot = useSnapshot()
  return useMemo(() => select(snapshot), [snapshot, select])
}

/**
 * The selected runtime's own description of itself.
 *
 * Every string the interface says *about* the runtime comes from here. A
 * fallback exists only so the shell renders during the moment before the host
 * has answered; it is deliberately generic rather than Codex-flavoured, because
 * a plausible-looking wrong default is worse than an obviously empty one.
 */
/**
 * The runtime the surrounding code should describe. Inside a pane that shows
 * a conversation, that is the conversation's own runtime — a Claude Code
 * session sitting beside a Codex one must render Claude Code's
 * words, capabilities and sign-in story, not the active runtime's. Outside a
 * pane, or in an empty one, it is the active runtime.
 */
export const useRuntime = (): RuntimeInfo => {
  const snapshot = useSnapshot()
  const pane = useContext(PaneContext)
  const paneRuntime =
    pane?.sessionKey != null ? splitSessionKey(pane.sessionKey).runtime : null
  return useMemo(() => {
    const wanted = paneRuntime ?? snapshot.activeRuntime
    const found = snapshot.runtimes.find((entry) => entry.id === wanted)
    return found ?? snapshot.runtimes[0] ?? FALLBACK_RUNTIME
  }, [snapshot.runtimes, snapshot.activeRuntime, paneRuntime])
}

const FALLBACK_RUNTIME: RuntimeInfo = {
  id: '' as RuntimeInfo['id'],
  name: 'No runtime',
  capabilities: {
    resume: false,
    fork: false,
    steer: false,
    interrupt: false,
    listHistory: false,
    searchHistory: false,
    imageInput: false,
    mcp: false,
    skills: false,
    plans: false,
    reasoning: false,
    metered: false,
    account: false,
    goals: false,
    undo: false,
    compaction: false,
    memory: false,
    review: false,
    extensionStore: false,
    hooks: false,
    pluginTools: false,
    backgroundTasks: false,
    archiveHistory: false,
  nameHistory: false,
    deleteHistory: false,
  },
  presentation: { name: 'No runtime' },
}

/**
 * Which pane a component is rendered in, and which conversation that pane
 * shows. Components inside a pane — the transcript, the composer, the
 * approval dialog — read their own pane's conversation; components outside
 * one — the details column, the commands — read the focused pane's.
 */
export interface PaneScope {
  readonly paneId: PaneId
  readonly view: PaneView
  readonly sessionKey: SessionKey | null
}

const PaneContext = createContext<PaneScope | null>(null)

export const PaneProvider = ({ scope, children }: { scope: PaneScope; children: ReactNode }) => (
  <PaneContext.Provider value={scope}>{children}</PaneContext.Provider>
)

export const usePane = (): PaneScope | null => useContext(PaneContext)

/** The conversation this component is about: its pane's, or the focused pane's. */
export const useSessionKey = (): SessionKey | null => {
  const pane = useContext(PaneContext)
  const snapshot = useSnapshot()
  return pane ? pane.sessionKey : snapshot.activeSessionKey
}

export const useActiveSession = (): Session | null => {
  const key = useSessionKey()
  const snapshot = useSnapshot()
  return key ? (snapshot.sessions.get(key) ?? null) : null
}

/** What this component's conversation has waiting, or null when nothing is. */
export const useQueue = (): SessionQueue | null => {
  const key = useSessionKey()
  const snapshot = useSnapshot()
  return key ? (snapshot.queues.get(key) ?? null) : null
}

/**
 * Whether this component's mount is the one shortcuts and the composer target.
 *
 * `layout.focused` alone was wrong for half the app the moment a panel could
 * hold a conversation: docked focus lives in `workbench.focus`, so a docked
 * transcript read as permanently unfocused and its composer quietly ignored
 * every `harnessdesk:compose` event. One helper answers for both.
 */
export const useIsFocusedPane = (): boolean => {
  const pane = useContext(PaneContext)
  const snapshot = useSnapshot()
  return pane ? focusedMount(snapshot.workbench) === pane.paneId : true
}
