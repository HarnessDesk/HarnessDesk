import { act, StrictMode, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { expect, test } from 'vitest'
import { type TopBarProps } from '../design'
import { TopBarProvider, TopBarOutlet, useTopBar, useTopBarView, type ViewSlots } from './top-bar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const emptyMore = () => null
const Base = ({ name }: { name: string }) => {
  useTopBar('main', { place: name, more: emptyMore })
  return null
}
const View = ({ enabled }: { enabled: boolean }) => {
  useTopBarView('main', { verb: { label: 'New job', run: () => {} } }, enabled)
  return null
}
test('focused owner wins, view changes cannot replace the subject, cleanup clears its verb', () => {
  const App = ({ view }: { view: boolean }) => <StrictMode><TopBarProvider>
    <Base name="Checkout retry" /><View enabled={view} />
    <TopBarOutlet owner="main" fallback={{ place: 'New session', more: emptyMore }} />
  </TopBarProvider></StrictMode>
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    act(() => root.render(<App view />))
    expect(container.querySelector('[data-topbar-title]')?.textContent).toBe('Checkout retry')
    expect(container.querySelector('button[aria-label="New job"]')).not.toBeNull()
    act(() => root.render(<App view={false} />))
    expect(container.querySelector('button[aria-label="New job"]')).toBeNull()
    expect(container.querySelector('[data-topbar-title]')?.textContent).toBe('Checkout retry')
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})

const PublishedBase = ({ owner, slots }: { owner: string; slots: TopBarProps }) => {
  useTopBar(owner, slots)
  return null
}
const PublishedView = ({ owner, slots }: { owner: string; slots: ViewSlots }) => {
  useTopBarView(owner, slots)
  return null
}
const mounted = (run: (root: Root, container: HTMLDivElement) => void): void => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try { run(root, container) }
  finally { act(() => root.unmount()); container.remove() }
}

test('different owners keep their own subject and view slots when focus changes', () => {
  const main = { place: 'Checkout retry', more: emptyMore }
  const side = { place: 'Release review', more: emptyMore }
  const mainView = { verb: { label: 'New job', run: () => {} } }
  const sideView = { verb: { label: 'Review changes', run: () => {} } }
  const App = ({ owner }: { owner: string }) => <StrictMode><TopBarProvider>
    <PublishedBase owner="main" slots={main} /><PublishedView owner="main" slots={mainView} />
    <PublishedBase owner="side" slots={side} /><PublishedView owner="side" slots={sideView} />
    <TopBarOutlet owner={owner} fallback={{ place: 'New session', more: emptyMore }} />
  </TopBarProvider></StrictMode>
  mounted((root, container) => {
    act(() => root.render(<App owner="main" />))
    expect(container.querySelector('[data-topbar-title]')?.textContent).toBe('Checkout retry')
    expect(container.querySelector('button[aria-label="New job"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Review changes"]')).toBeNull()
    act(() => root.render(<App owner="side" />))
    expect(container.querySelector('[data-topbar-title]')?.textContent).toBe('Release review')
    expect(container.querySelector('button[aria-label="Review changes"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="New job"]')).toBeNull()
  })
})

test('cleanup of a replaced publisher preserves the replacement until its own cleanup', () => {
  const base = { place: 'Checkout retry', more: emptyMore }
  const original = { verb: { label: 'New job', run: () => {} } }
  const replacement = { verb: { label: 'Review changes', run: () => {} } }
  const App = ({ old, current }: { old: boolean; current: boolean }) => <StrictMode><TopBarProvider>
    <PublishedBase owner="main" slots={base} />
    {old && <PublishedView key="old" owner="main" slots={original} />}
    {current && <PublishedView key="current" owner="main" slots={replacement} />}
    <TopBarOutlet owner="main" fallback={{ place: 'New session', more: emptyMore }} />
  </TopBarProvider></StrictMode>
  mounted((root, container) => {
    act(() => root.render(<App old current />))
    expect(container.querySelector('button[aria-label="Review changes"]')).not.toBeNull()
    act(() => root.render(<App old={false} current />))
    expect(container.querySelector('button[aria-label="Review changes"]')).not.toBeNull()
    act(() => root.render(<App old={false} current={false} />))
    expect(container.querySelector('button[aria-label="Review changes"]')).toBeNull()
    expect(container.querySelector('[data-topbar-title]')?.textContent).toBe('Checkout retry')
  })
})

test('registry publication rerenders the outlet without subscribing its producers', () => {
  let subjectRenders = 0
  let viewRenders = 0
  const slots = { place: 'Checkout retry', more: emptyMore }
  const Subject = () => {
    subjectRenders++
    useTopBar('main', slots)
    return null
  }
  const UpdatingView = () => {
    viewRenders++
    const [label, setLabel] = useState('New job')
    useTopBarView('main', { verb: { label, run: () => {} } })
    return <button onClick={() => setLabel('Review changes')}>Change view</button>
  }
  mounted((root, container) => {
    act(() => root.render(<StrictMode><TopBarProvider>
      <Subject /><UpdatingView />
      <TopBarOutlet owner="main" fallback={{ place: 'New session', more: emptyMore }} />
    </TopBarProvider></StrictMode>))
    const before = { subject: subjectRenders, view: viewRenders }
    expect(container.querySelector('button[aria-label="New job"]')).not.toBeNull()
    act(() => container.querySelector<HTMLButtonElement>('button')!.click())
    expect(container.querySelector('button[aria-label="Review changes"]')).not.toBeNull()
    expect(subjectRenders).toBe(before.subject)
    // StrictMode renders the local state update twice; publication adds none.
    expect(viewRenders).toBe(before.view + 2)
  })
})
