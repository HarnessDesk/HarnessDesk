import { act, StrictMode, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { StoreProvider } from '../state/context'
import { previewStore } from '../preview/harness'
import { TopBarProvider, useTopBar } from './top-bar'
import { ShellHostsProvider, ShellOutlets, useShellHosts } from './shell-hosts'

let host: HTMLDivElement, root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

const Host = ({ id, owner = 'page' }: { id: string; owner?: string }) => {
  const { topRef, mainRef } = useShellHosts(owner)
  useTopBar(owner, { place: id, more: () => null })
  return <><div data-testid={`top-${id}`} ref={topRef} /><div data-testid={`main-${id}`} ref={mainRef} /></>
}

it('removing an older same-owner host preserves its replacement and the singleton outlets', () => {
  const store = previewStore({ status: 'reconnecting' })
  const tree = (older: boolean) => <StrictMode><StoreProvider store={store}><TopBarProvider><ShellHostsProvider>
    {older && <Host key="old" id="old" />}<Host key="new" id="new" /><ShellOutlets activeOwner="page" />
  </ShellHostsProvider></TopBarProvider></StoreProvider></StrictMode>
  act(() => root.render(tree(true)))
  expect(host.querySelector('[data-testid="top-new"] [data-slot="top-bar"]')).not.toBeNull()
  act(() => root.render(tree(false)))
  expect(host.querySelector('[data-testid="top-new"] [data-slot="top-bar"]')).not.toBeNull()
  expect(host.querySelectorAll('[data-slot="top-bar"]')).toHaveLength(1)
  expect(host.querySelectorAll('[data-slot="alert"]')).toHaveLength(1)
  expect(host.querySelector('[data-testid="main-new"] [data-slot="alert"]')).not.toBeNull()
})

it('an older mounted host cannot steal the newer host by changing its ref nodes', () => {
  const store = previewStore({ status: 'reconnecting' })
  const Old = () => {
    const [version, setVersion] = useState(0)
    const { topRef, mainRef } = useShellHosts('page')
    return <><button onClick={() => setVersion(one => one + 1)}>Replace older nodes</button>
      <div key={version} data-testid="top-old" ref={topRef} /><div ref={mainRef} /></>
  }
  act(() => root.render(<StoreProvider store={store}><TopBarProvider><ShellHostsProvider>
    <Old /><Host id="new" /><ShellOutlets activeOwner="page" />
  </ShellHostsProvider></TopBarProvider></StoreProvider>))
  const bar = host.querySelector('[data-testid="top-new"] [data-slot="top-bar"]')
  act(() => host.querySelector<HTMLButtonElement>('button')!.click())
  expect(host.querySelector('[data-testid="top-new"] [data-slot="top-bar"]')).toBe(bar)
  expect(host.querySelector('[data-testid="top-old"] [data-slot="top-bar"]')).toBeNull()
})

it('portals the same selected work registrations back after a nonwork host closes', () => {
  const store = previewStore({ status: 'reconnecting' }), owner = store.getSnapshot().layout.focused
  const Work = () => {
    const { topRef, mainRef } = useShellHosts('work')
    useTopBar(owner, { place: 'Checkout retry', tools: <button>Details</button>, more: () => null })
    return <><div data-testid="top-work" ref={topRef} /><div data-testid="main-work" ref={mainRef} /></>
  }
  const tree = (page: boolean) => <StoreProvider store={store}><TopBarProvider><ShellHostsProvider>
    <Work />{page && <Host id="Settings" />}<ShellOutlets activeOwner={page ? 'page' : null} />
  </ShellHostsProvider></TopBarProvider></StoreProvider>
  act(() => root.render(tree(true)))
  expect(host.querySelector('[data-testid="top-Settings"] [data-topbar-title]')?.textContent).toBe('Settings')
  expect([...host.querySelectorAll('button')].some(one => one.textContent === 'Details')).toBe(false)
  act(() => root.render(tree(false)))
  expect(host.querySelector('[data-testid="top-work"] [data-topbar-title]')?.textContent).toBe('Checkout retry')
  expect([...host.querySelectorAll('button')].some(one => one.textContent === 'Details')).toBe(true)
  expect(host.querySelectorAll('[data-slot="alert"]')).toHaveLength(1)
})
