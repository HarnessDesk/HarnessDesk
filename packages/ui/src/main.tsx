import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app/App'
import { installPanelComponent } from './slots/PanelBlocks'
import { AppStore } from './state/store'
import { StoreProvider } from './state/context'
import { installOverlayScrollbarTracking } from './styles/overlay-scrollbars'
import './styles/app.css'

installPanelComponent()
installOverlayScrollbarTracking()

// Hold only faces until the saved shape has been applied before paint.
document.body.setAttribute('data-hd-faces-pending', '')
const store = new AppStore()
// Development probe surface; harmless in production and priceless in a bug.
;(window as unknown as { __hdStore?: AppStore }).__hdStore = store
const ready = store.connect()
;(window as unknown as { __hdReady?: Promise<void> }).__hdReady = ready
void ready.catch((error: unknown) => {
  // Once preferences arrived, the layout effect owns the reveal even if a
  // later startup task fails before React has painted the chosen shape.
  if (!store.getSnapshot().preferencesLoaded) document.body.removeAttribute('data-hd-faces-pending')
  store.backgroundFailure(error instanceof Error ? error.message : String(error))
})

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from index.html')

createRoot(container).render(
  <StrictMode>
    <StoreProvider store={store}>
      <App />
    </StoreProvider>
  </StrictMode>,
)
