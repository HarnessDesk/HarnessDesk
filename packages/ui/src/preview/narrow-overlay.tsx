import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { Workbench } from '../panels/Workbench'
import '../panels/builtins'
import { StoreProvider } from '../state/context'
import { dock, emptyWorkbench } from '../state/workbench'
import { BLANK } from '../state/layout'
import { runtimeId } from '@harnessdesk/protocol'
import { AppWindowMode } from '../components/AppWindow'
import { PREVIEW_SESSION_KEY, previewStore } from './harness'
import '../styles/app.css'

const paneId = 'narrow-overlay-conversation'
const main = {
  root: {
    kind: 'pane' as const,
    id: paneId,
    view: { kind: 'conversation' as const, session: PREVIEW_SESSION_KEY },
  },
  focused: paneId,
  expanded: null,
}
const requestedView = new URLSearchParams(location.search).get('view') ?? 'trajectory'
const projectRoot = '/work/project'
const views = {
  trajectory: { kind: 'trajectory' },
  git: { kind: 'git', root: projectRoot },
  terminal: { kind: 'terminal', terminalId: 'preview-terminal', runtime: runtimeId('codex'), cwd: projectRoot },
  browser: { kind: 'browser', tabs: [{ id: 'preview-browser', url: BLANK }], active: 'preview-browser', driven: 'preview-browser' },
  file: { kind: 'file', path: `${projectRoot}/README.md`, runtime: runtimeId('codex') },
  changes: { kind: 'changes' },
  agents: { kind: 'agents' },
  tasks: { kind: 'tasks' },
} as const
const panelView = views[requestedView as keyof typeof views] ?? views.trajectory
const workbench = { ...dock(emptyWorkbench(), 'right', panelView as never), main }
const usage = previewStore().getSnapshot().usage.map((report) =>
  report.source.kind === 'file'
    ? {
        ...report,
        lanes: [{ id: 'session', label: 'Session', usedPercent: 100, windowMinutes: 300, resetsAt: Date.now() + 60 * 60_000 }],
        reached: 'session',
      }
    : report,
)
const store = previewStore({
  layout: {
    ...main,
  },
  workbench,
  sidebarCollapsed: true,
  usage,
})

;(window as Window & { __narrowOverlayStore?: typeof store }).__narrowOverlayStore = store

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from narrow-overlay.html')

createRoot(root).render(
  <StrictMode>
    <StoreProvider store={store}>
      <AppWindowMode.Provider value="embedded">
        <Workbench sidebar={<div />} />
      </AppWindowMode.Provider>
    </StoreProvider>
  </StrictMode>,
)
