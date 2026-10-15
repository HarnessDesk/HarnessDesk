import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { Notice, NoticeHost, NoticeList, NoticeRow, NoticeStatus } from '../index'

const host = document.createElement('div')
const root = createRoot(host)
afterEach(async () => { await act(() => root.render(null)) })

it('renders action data with one primary and invokes the selected action', async () => {
  const onSelect = vi.fn()
  await act(() => root.render(<Notice tone="success" title="Saved" actions={[
    { label: 'View changes', onSelect, kind: 'primary' },
    { label: 'Again', onSelect, kind: 'primary' },
    { label: 'Later', onSelect, kind: 'ghost' },
  ]} />))
  expect(host.querySelectorAll('[data-variant="default"]button')).toHaveLength(1)
  await act(() => host.querySelector('button')!.click())
  expect(onSelect).toHaveBeenCalledOnce()
  expect(host.querySelector('[role="status"]')).not.toBeNull()
})

it('inherits compact presentation and keeps the list and status anatomy in the family', async () => {
  await act(() => root.render(<NoticeHost size="compact"><NoticeStatus title="Working" /><NoticeList title="Inbox"><NoticeRow title="Saved" /></NoticeList></NoticeHost>))
  expect(host.querySelector('[data-slot="notice-status"][data-compact]')).not.toBeNull()
  expect(host.querySelector('[data-slot="notice-list"] [data-slot="notice-row"]')).not.toBeNull()
})

it('keeps a labelled icon-kind action at text-button width', async () => {
  const onSelect = vi.fn()
  await act(() => root.render(<Notice title="Changes saved." actions={[
    { label: 'View the complete activity log', onSelect, kind: 'icon' },
  ]} />))
  const action = host.querySelector('button')!
  expect(action.textContent).toBe('View the complete activity log')
  expect(action.classList.contains('p-(--hd-btn-padding-sm)')).toBe(true)
  expect(action.dataset.variant).toBe('ghost')
  await act(() => action.click())
  expect(onSelect).toHaveBeenCalledOnce()
})
