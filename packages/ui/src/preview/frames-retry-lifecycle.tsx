import { useState } from 'react'
import { createRoot } from 'react-dom/client'

import { Button, PaneSurface } from '../design'
import { RunView } from '../components/RunView'
import { RunInspector } from '../components/RunInspector'
import { runTimeline } from '../lib/run-timeline'
import { runFixture } from './run-view-fixture'
import { StoreProvider } from '../state/context'
import { previewStore } from './harness'

/** A controlled lifecycle frame, loaded by the focused browser regression. */
export const mountRetryLifecycle = (container: HTMLElement, surface: 'timeline' | 'inspector' = 'inspector'): void => {
  const store = previewStore()
  const fixture = runFixture('running')
  const Example = () => {
    const [ended, setEnded] = useState(false)
    const input = { ...fixture, execution: { ...fixture.execution, state: ended ? 'settled' as const : 'running' as const } }
    return <PaneSurface className="flex min-h-144 flex-col gap-4 p-6">
      <Button onClick={() => setEnded(true)}>End Run</Button>
      {surface === 'timeline'
        ? <RunView model={runTimeline(input)} number={1} selectedRow="check-2-2" onSelect={() => {}} />
        : <RunInspector input={input} selectedRow="check-2-2" seats={[]} />}
    </PaneSurface>
  }
  createRoot(container).render(<StoreProvider store={store}><Example /></StoreProvider>)
}
