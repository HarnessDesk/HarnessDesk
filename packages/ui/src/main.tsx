import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app/App'
import { installPanelComponent } from './slots/PanelBlocks'
import { AppStore } from './state/store'
import { StoreProvider } from './state/context'
import './styles/app.css'

installPanelComponent()

const store = new AppStore()
// Development probe surface; harmless in production and priceless in a bug.
;(window as unknown as { __hdStore?: AppStore }).__hdStore = store
void store.connect().catch((error: unknown) => {
  store.notice('error', error instanceof Error ? error.message : String(error))
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
