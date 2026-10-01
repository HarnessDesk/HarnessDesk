import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { Workbench } from '../panels/Workbench'
import '../panels/builtins'
import { StoreProvider } from '../state/context'
import { dock, emptyWorkbench } from '../state/workbench'
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
const workbench = { ...dock(emptyWorkbench(), 'right', { kind: 'trajectory' }), main }
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
