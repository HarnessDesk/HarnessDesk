import { StoreProvider } from '../state/context'
import { previewStore } from '../preview/harness'
import { act, StrictMode, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { expect, test } from 'vitest'
import { Chip, MenuItem, type TopBarProps } from '../design'
import { TopBarProvider, TopBarOutlet, WorkViewControlsOutlet, useTopBar, useTopBarMore, useTopBarView, type ViewSlots } from './top-bar'
import { installTopBarTestLayout } from '../test/top-bar-layout'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

installTopBarTestLayout()

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
    <WorkViewControlsOutlet owner="main" /><TopBarOutlet owner="main" fallback={{ place: 'New session', more: emptyMore }} />
  </TopBarProvider></StrictMode>
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    act(() => root.render(<App view />))
    expect(container.querySelector('[data-topbar-title] [data-slot="text"]')?.textContent).toBe('Checkout retry')
    expect([...container.querySelectorAll('button')].find(one => one.textContent === 'New job') ?? null).not.toBeNull()
    act(() => root.render(<App view={false} />))
    expect([...container.querySelectorAll('button')].find(one => one.textContent === 'New job') ?? null).toBeNull()
    expect(container.querySelector('[data-topbar-title]')?.textContent).toBe('Checkout retry')
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})

test('a nonwork registration has no tools and returning restores the work slots', () => {
  const work = { place: 'Checkout retry', tools: <button>Details</button>, more: emptyMore }
  const page = { place: 'Appearance', parent: { label: 'Settings', run: () => {} }, more: emptyMore }
  const App = ({ settings }: { settings: boolean }) => <TopBarProvider>
    <PublishedBase owner="main" slots={work} />{settings && <PublishedBase owner="settings" slots={page} />}
    <TopBarOutlet owner={settings ? 'settings' : 'main'} fallback={{ place: 'New session', more: emptyMore }} />
  </TopBarProvider>
  mounted((root, container) => {
    act(() => root.render(<App settings />))
    expect([...container.querySelectorAll('button')].some(one => one.textContent === 'Details')).toBe(false)
    act(() => root.render(<App settings={false} />))
    expect([...container.querySelectorAll('button')].some(one => one.textContent === 'Details')).toBe(true)
  })
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
    <WorkViewControlsOutlet owner={owner} /><TopBarOutlet owner={owner} fallback={{ place: 'New session', more: emptyMore }} />
  </TopBarProvider></StrictMode>
  mounted((root, container) => {
    act(() => root.render(<App owner="main" />))
    expect(container.querySelector('[data-topbar-title]')?.textContent).toBe('Checkout retry')
    expect([...container.querySelectorAll('button')].find(one => one.textContent === 'New job') ?? null).not.toBeNull()
    expect([...container.querySelectorAll('button')].find(one => one.textContent === 'Review changes') ?? null).toBeNull()
    act(() => root.render(<App owner="side" />))
    expect(container.querySelector('[data-topbar-title]')?.textContent).toBe('Release review')
    expect([...container.querySelectorAll('button')].find(one => one.textContent === 'Review changes') ?? null).not.toBeNull()
    expect([...container.querySelectorAll('button')].find(one => one.textContent === 'New job') ?? null).toBeNull()
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
    <WorkViewControlsOutlet owner="main" /><TopBarOutlet owner="main" fallback={{ place: 'New session', more: emptyMore }} />
  </TopBarProvider></StrictMode>
  mounted((root, container) => {
    act(() => root.render(<App old current />))
    expect([...container.querySelectorAll('button')].find(one => one.textContent === 'Review changes') ?? null).not.toBeNull()
    act(() => root.render(<App old={false} current />))
    expect([...container.querySelectorAll('button')].find(one => one.textContent === 'Review changes') ?? null).not.toBeNull()
    act(() => root.render(<App old={false} current={false} />))
    expect([...container.querySelectorAll('button')].find(one => one.textContent === 'Review changes') ?? null).toBeNull()
    expect(container.querySelector('[data-topbar-title]')?.textContent).toBe('Checkout retry')
  })
})

test('an older same-owner producer cannot republish over the current registration', () => {
  const replacement = { place: 'Current settings', more: emptyMore }
  const Old = () => {
    const [place, setPlace] = useState('Previous settings')
    useTopBar('settings', { place, more: emptyMore })
    return <button onClick={() => setPlace('Late previous settings')}>Update previous</button>
  }
  mounted((root, container) => {
    act(() => root.render(<TopBarProvider><Old /><PublishedBase owner="settings" slots={replacement} />
      <TopBarOutlet owner="settings" fallback={{ place: 'Fallback', more: emptyMore }} /></TopBarProvider>))
    expect(container.querySelector('[data-topbar-title]')?.textContent).toBe('Current settings')
    act(() => container.querySelector<HTMLButtonElement>('button')!.click())
    expect(container.querySelector('[data-topbar-title]')?.textContent).toBe('Current settings')
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
      <WorkViewControlsOutlet owner="main" /><TopBarOutlet owner="main" fallback={{ place: 'New session', more: emptyMore }} />
    </TopBarProvider></StrictMode>))
    const before = { subject: subjectRenders, view: viewRenders }
    expect([...container.querySelectorAll('button')].find(one => one.textContent === 'New job') ?? null).not.toBeNull()
    act(() => container.querySelector<HTMLButtonElement>('button')!.click())
    expect([...container.querySelectorAll('button')].find(one => one.textContent === 'Review changes') ?? null).not.toBeNull()
    expect(subjectRenders).toBe(before.subject)
    // StrictMode renders the local state update twice; publication adds none.
    expect(viewRenders).toBe(before.view + 2)
  })
})

test('view actions preserve the parent subject slots and share one More Menu with conversation rows', async () => {
  const ConversationRows = () => {
    useTopBarMore('main', close => <MenuItem icon={<span />} label="Conversation action" onSelect={close} />)
    return null
  }
  const parent: TopBarProps = {
    place: 'Checkout retry', state: <Chip tone="neutral">Working</Chip>,
    tabs: [{ value: 'board', label: 'Board', count: 3, run: () => {} }], tab: 'board',
    tools: <span data-testid="parent-tools">Four tools</span>,
    more: close => <MenuItem icon={<span />} label="Subject action" onSelect={close} />,
  }
  const view: ViewSlots = { verb: { label: 'New job', icon: <span />, run: () => {} }, more: [{ label: 'Hand out', icon: <span />, run: () => {} }] }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    act(() => root.render(<StoreProvider store={previewStore()}><TopBarProvider><PublishedBase owner="main" slots={parent} />
      <PublishedView owner="main" slots={view} /><ConversationRows />
      <WorkViewControlsOutlet owner="main" /><TopBarOutlet owner="main" fallback={{ place: 'Fallback', more: emptyMore }} />
    </TopBarProvider></StoreProvider>))
    expect(container.querySelector('[data-topbar-title] [data-slot="text"]')?.textContent).toBe('Checkout retry')
    expect(container.querySelector('[data-topbar="state"]')?.textContent).toBe('Working')
    expect(container.querySelector('[role="tablist"]')).toBeNull()
    expect(container.querySelector('[data-testid="parent-tools"]')?.textContent).toBe('Four tools')
    await act(async () => container.querySelector<HTMLButtonElement>('[data-topbar="more"] button')!.click())
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1)
    expect([...document.querySelectorAll('[role="menuitem"]')].map(one => one.textContent)).toEqual(['Subject action', 'Conversation action', 'Hand out'])
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})

test('More offers Terminal once on a folder surface and omits it on a page with actions', async () => {
  const App = ({ owner }: { owner: 'conversation' | 'settings' }) => <StoreProvider store={previewStore()}><TopBarProvider>
    <PublishedBase owner="conversation" slots={{ place: 'Conversation', terminal: true, more: emptyMore }} />
    <PublishedBase owner="settings" slots={{ place: 'Settings', more: close => <MenuItem icon={<span />} label="Open settings" onSelect={close} /> }} />
    <WorkViewControlsOutlet owner={owner} /><TopBarOutlet owner={owner} fallback={{ place: 'New session', more: emptyMore }} />
  </TopBarProvider></StoreProvider>
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<App owner="conversation" />))
    await act(async () => container.querySelector<HTMLButtonElement>('[data-topbar="more"] button')!.click())
    const terminals = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
      .filter(one => one.querySelector('[data-menu-label]')?.textContent?.trim() === 'Terminal')
    expect(terminals).toHaveLength(1)
    expect(terminals[0]?.querySelector('[data-menu-trailing]')?.textContent?.trim()).not.toBe('')
    expect(terminals[0]?.querySelector('[data-menu-icon]')).not.toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('[data-topbar="more"] button')!.click())
    await act(async () => root.render(<App owner="settings" />))
    const pageMore = container.querySelector<HTMLButtonElement>('[data-topbar="more"] button')
    expect(pageMore).not.toBeNull()
    await act(async () => pageMore!.click())
    const pageRows = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
    expect(pageRows.map(one => one.textContent?.trim())).toContain('Open settings')
    expect(pageRows
      .filter(one => one.querySelector('[data-menu-label]')?.textContent?.trim() === 'Terminal')).toHaveLength(0)
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
