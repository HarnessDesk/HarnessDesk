import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

import { Banner, BannerAction, BannerStack } from './Banner'

const host = document.createElement('div')
document.body.append(host)
const root = createRoot(host)
afterEach(async () => { await act(() => root.render(null)) })

it('renders nothing when there is no message', async () => {
  await act(() => root.render(<Banner title="" onDismiss={vi.fn()} />))
  expect(host.innerHTML).toBe('')
})

it('uses a success tile and accepts a mark in its footprint', async () => {
  await act(() => root.render(<Banner tone="success" title="Saved" mark={<span>Alpha</span>} />))
  expect(host.querySelector('[data-slot="icon-tile"][data-tone="success"]')?.textContent).toBe('Alpha')
  expect(host.querySelector('[data-slot="icon-tile"]')?.getAttribute('data-shape')).toBe('face')
})

it('gets compact floating presentation from its host and ignores the legacy size prop', async () => {
  await act(() => root.render(<Banner compact title="Saved" />))
  expect(host.querySelector('[data-compact]')).toBeNull()
  await act(() => root.render(<BannerStack><Banner title="Saved" /></BannerStack>))
  expect(host.querySelector('[data-compact][data-floating]')).not.toBeNull()
})

it('counts fragment actions, stacks three, and demotes additional primary actions', async () => {
  await act(() => root.render(<Banner title="Choose" actions={<>
    <BannerAction>First</BannerAction><BannerAction>Second</BannerAction><BannerAction>Third</BannerAction>
  </>} />))
  expect(host.querySelector('[data-stack]')).not.toBeNull()
  expect(host.querySelectorAll('button[data-variant="default"]')).toHaveLength(1)
  expect(host.querySelectorAll('button[data-variant="secondary"]')).toHaveLength(2)
})

it('omits empty title and detail nodes as well as an empty shell', async () => {
  await act(() => root.render(<Banner title={null}>Saved.</Banner>))
  expect(host.querySelector('[data-slot="alert-title"]')).toBeNull()
  await act(() => root.render(<Banner title="Saved">   </Banner>))
  expect(host.querySelector('[data-slot="alert-description"]')).toBeNull()
  await act(() => root.render(<Banner title="   ">{false}</Banner>))
  expect(host.innerHTML).toBe('')
})
