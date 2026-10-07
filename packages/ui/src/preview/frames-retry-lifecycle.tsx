import { useState } from 'react'
import { createRoot } from 'react-dom/client'

import { Button, PaneSurface } from '../design'
import { RunAgain } from '../components/RetryCheck'
import { StoreProvider } from '../state/context'
import { previewStore } from './harness'

/** A controlled lifecycle frame, loaded by the focused browser regression. */
export const mountRetryLifecycle = (container: HTMLElement): void => {
  const store = previewStore()
  const Example = () => {
    const [ended, setEnded] = useState(false)
    return <PaneSurface className="flex min-h-144 flex-col gap-4 p-6">
      <Button onClick={() => setEnded(true)}>End Run</Button>
      <RunAgain run="run-preview" card={3} terminal={ended}
        refusal={ended ? 'This run is settled. Start a new run to run this check again.' : null} />
    </PaneSurface>
  }
  createRoot(container).render(<StoreProvider store={store}><Example /></StoreProvider>)
}
