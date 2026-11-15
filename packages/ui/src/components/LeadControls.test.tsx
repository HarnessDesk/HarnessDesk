import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ContextMenu } from '../design'
import { leadContract, leadProjection } from '../preview/lead-fixture'
import { StoreProvider } from '../state/context'
import { createLeadState } from '../state/lead'
import type { AppStore } from '../state/store'
import { useLeadControls } from './LeadControls'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./use-inbox-waiting', () => ({ useLeadInbox: () => null }))
vi.mock('./use-lead-name', () => ({ useLeadName: () => 'dex' }))

const roots: (() => void)[] = []
afterEach(() => { for (const dispose of roots.splice(0)) dispose() })

const mount = async (canStop: boolean | undefined, active = false) => {
  const initial = leadProjection()
  const projection = leadProjection({ ...initial, thread: { ...initial.thread, state: active ? 'running' : 'stopped', contract: leadContract }, ...(canStop === undefined ? {} : { canStop }) })
  const request = vi.fn(async () => projection)
  const lead = createLeadState({ request } as never, () => true)
  lead.changed({ method: 'lead/changed', params: projection })
  const stop = vi.spyOn(lead, 'stop').mockResolvedValue(undefined as never)
  const store = { lead } as unknown as AppStore
  const box = document.createElement('div'); document.body.append(box)
  const root = createRoot(box)
  const Fixture = () => {
    const controls = useLeadControls(), [open, setOpen] = useState(true)
    return <><ContextMenu at={open ? { x: 10, y: 10 } : null} label="Lead options" onClose={() => setOpen(false)}>{controls.items(() => setOpen(false))}</ContextMenu>{controls.dialog}</>
  }
  roots.push(() => { act(() => root.unmount()); box.remove() })
  await act(async () => root.render(<StoreProvider store={store}><Fixture /></StoreProvider>))
  const pause = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent?.startsWith('Pause Dex'))!
  expect(pause).toBeTruthy()
  return { pause, stop, lead }
}

it('offers the existing confirmed Pause for stopped work with manual stop capability', async () => {
  const { pause, stop } = await mount(true)
  expect(pause.getAttribute('aria-disabled')).not.toBe('true')
  await act(async () => pause.click())
  expect(stop).not.toHaveBeenCalled()
  const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]')!
  expect(dialog).toBeTruthy()
  const confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Pause Dex')!
  await act(async () => confirm.click())
  expect(stop).toHaveBeenCalledTimes(1)
})

it.each([false, undefined])('keeps an ended goal with capability %s paused and unavailable', async canStop => {
  const { pause, stop } = await mount(canStop)
  expect(pause.getAttribute('aria-disabled')).toBe('true')
  await act(async () => pause.click())
  expect(stop).not.toHaveBeenCalled()
})

it('keeps ordinary active goals pausable without the optional capability', async () => {
  const { pause } = await mount(undefined, true)
  expect(pause.getAttribute('aria-disabled')).not.toBe('true')
})
