import { act, StrictMode, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PageHead, DetailHead, BackLink } from '../Settings'
import { PageHeadingProvider, usePageHeading, type PageHeadingData } from './PageHeading'

let host: HTMLDivElement, root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })
const Publisher = ({ title }: { title: string }) => { usePageHeading(title); return null }
it('ignores older heading publication and cleanup after the replacement claims the channel', () => {
  const receive = vi.fn(), tree = (old: boolean, title: string) => <StrictMode><PageHeadingProvider onHeading={receive}>
    {old && <Publisher key="old" title={title} />}<Publisher key="current" title="Current Agent" />
  </PageHeadingProvider></StrictMode>
  act(() => root.render(tree(true, 'Previous Agent')))
  expect(receive.mock.calls.at(-1)?.[0].place).toBe('Current Agent')
  receive.mockClear()
  act(() => root.render(tree(true, 'Late previous update')))
  act(() => root.render(tree(false, 'Late previous update')))
  expect(receive).not.toHaveBeenCalled()
  act(() => root.render(null))
  expect(receive).toHaveBeenLastCalledWith(null)
})
it('keeps the channel stable when its receiver changes and publishes current headings without a loop', () => {
  const receive = vi.fn()
  const Page = () => {
    const [heading, setHeading] = useState<PageHeadingData | null>(null)
    return <PageHeadingProvider onHeading={next => { receive(next); setHeading(next) }}>
      <Publisher title="Current Agent" /><span>{heading?.place}</span>
    </PageHeadingProvider>
  }
  act(() => root.render(<Page />))
  expect(receive).toHaveBeenCalledOnce()
  expect(host.textContent).toBe('Current Agent')
})
it('framed heads transport titles while retaining facts and actions; standalone heads retain their titles', () => {
  const receive = vi.fn(), page = <PageHead title="Plugins" blurb="Installed capabilities" actions={<button>Install</button>} />
  act(() => root.render(page))
  expect(host.querySelector('h1')?.textContent).toBe('Plugins')
  act(() => root.render(<PageHeadingProvider onHeading={receive}>{page}</PageHeadingProvider>))
  expect(host.querySelector('h1')).toBeNull()
  expect(host.textContent).toContain('Installed capabilitiesInstall')
  expect(receive.mock.calls.at(-1)?.[0].place).toBe('Plugins')
  act(() => root.render(<PageHeadingProvider onHeading={receive}><DetailHead name="Code reviewer" owner="Project" blurb="Reviews changes" actions={<button>Customize</button>} /></PageHeadingProvider>))
  expect(host.querySelector('h1')).toBeNull()
  expect(host.textContent).toContain('ProjectReviews changesCustomize')
  expect(receive.mock.calls.at(-1)?.[0].place).toBe('Code reviewer')
})
it('framed page support keeps its original description and scope action together without another title', () => {
  const receive = vi.fn(), scope = vi.fn()
  const page = <PageHead title="Overview" blurb="Usage across your agents" actions={<button onClick={scope}>Every agent</button>} />
  act(() => root.render(page))
  const blurbClass = host.querySelector('p')!.className
  act(() => root.render(<PageHeadingProvider onHeading={receive}>{page}</PageHeadingProvider>))
  const description = host.querySelector('p')!
  expect(description.className).toBe(blurbClass)
  const support = description.closest('[data-page-support]')!
  expect(support).not.toBeNull()
  expect(support.querySelector('button')?.textContent).toBe('Every agent')
  expect(host.querySelector('[data-slot="page-head"], h1')).toBeNull()
  act(() => support.querySelector('button')!.click())
  expect(scope).toHaveBeenCalledOnce()
  expect(receive.mock.calls.at(-1)?.[0].place).toBe('Overview')
})
it('framed detail support keeps owner and description below Back while preserving its action', () => {
  const receive = vi.fn(), customize = vi.fn()
  const detail = <DetailHead name="Code reviewer" owner="Built in" blurb="Reviews recorded changes" actions={<button onClick={customize}>Customize</button>} />
  act(() => root.render(detail))
  const ownerClass = host.querySelector('[data-owner]')!.className, blurbClass = host.querySelector('p')!.className
  act(() => root.render(<PageHeadingProvider onHeading={receive}>
    <BackLink to="Agents" onClick={() => {}} />{detail}
  </PageHeadingProvider>))
  const owner = host.querySelector('[data-owner]')!, description = host.querySelector('p')!
  expect(owner).not.toBeNull()
  expect(owner.className).toBe(ownerClass)
  expect(description.className).toBe(blurbClass)
  const support = owner.closest('[data-detail-support]')!
  expect(support).not.toBeNull()
  expect(support.previousElementSibling?.textContent).toBe('Agents')
  expect(description.parentElement).toBe(owner.parentElement)
  expect(support.querySelector('button')?.textContent).toBe('Customize')
  expect(host.querySelector('h1, [data-slot="detail-title"]')).toBeNull()
  act(() => support.querySelector('button')!.click())
  expect(customize).toHaveBeenCalledOnce()
  expect(receive.mock.calls.at(-1)?.[0].place).toBe('Code reviewer')
})
