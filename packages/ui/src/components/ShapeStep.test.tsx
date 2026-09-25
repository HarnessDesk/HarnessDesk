import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AgentEntry, FlowAgentRole, RuntimeInfo } from '@harnessdesk/protocol'

import { ShapeStep } from './ShapeStep'

/**
 * An Agent step's own form: seats it prefers are edited as an ordered picker
 * of runtimes, the same idiom `PreferFieldDialog` uses for an Agent's own
 * `prefer` — never a raw runtime-id text field that replaces the whole list
 * the moment it changes, dropping fallbacks, models and efforts along with it
 * (review item 4).
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const RUNTIMES: readonly RuntimeInfo[] = [
  { id: 'codex', presentation: { name: 'Codex' } } as unknown as RuntimeInfo,
  { id: 'claude-code', presentation: { name: 'Claude Code' } } as unknown as RuntimeInfo,
]

const ROLE = (over: Partial<FlowAgentRole> = {}): FlowAgentRole => ({
  id: 'reviewer', kind: 'agent', uses: [], seats: [], isolate: false, grant: 'read', independentOf: [], ...over,
})

const render = (role: FlowAgentRole, onChange = vi.fn(), agents: readonly AgentEntry[] = []) => {
  act(() => {
    root.render(<ShapeStep role={role} agents={agents} runtimes={RUNTIMES} onChange={onChange} />)
  })
  return onChange
}

const menuButton = (label: string): HTMLElement => {
  const found = [...document.body.querySelectorAll('[aria-label]')].find((one) => one.getAttribute('aria-label') === label)
  if (!found) throw new Error(`no “${label}” trigger`)
  return found as HTMLElement
}
const menuItem = (label: string): HTMLElement => {
  const found = [...document.body.querySelectorAll('[role="menuitem"]')].find((one) => one.textContent?.trim() === label)
  if (!found) throw new Error(`no menu item “${label}”`)
  return found as HTMLElement
}
const settle = () => act(async () => {})

it('a seat override shows a runtime’s presentation name, never its raw id, and no free-text field remains', () => {
  render(ROLE({ seats: [{ runtime: 'codex' }] }))
  expect(document.body.textContent).toContain('Codex')
  expect(document.body.textContent).not.toContain('codex')
  expect(document.body.querySelector('input[value="codex"]')).toBeNull()
})

it('an existing seat’s model and effort are kept and shown, never dropped by the picker', () => {
  render(ROLE({ seats: [{ runtime: 'codex', model: 'gpt-5.6', effort: 'high' }] }))
  expect(document.body.textContent).toContain('Codex')
  expect(document.body.textContent).toContain('gpt-5.6')
  expect(document.body.textContent).toContain('high')
})

it('adding a seat keeps the existing seat and its model, never replacing the list', async () => {
  const onChange = render(ROLE({ seats: [{ runtime: 'codex', model: 'gpt-5.6', effort: 'high' }] }))
  act(() => menuButton('Add a seat').click())
  await settle()
  act(() => menuItem('Claude Code').click())
  await settle()

  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({
      seats: [{ runtime: 'codex', model: 'gpt-5.6', effort: 'high' }, { runtime: 'claude-code' }],
    }),
  )
})

it('reordering moves the seat, never touching its model or effort', async () => {
  const onChange = render(ROLE({
    seats: [{ runtime: 'codex', model: 'gpt-5.6' }, { runtime: 'claude-code', effort: 'high' }],
  }))
  act(() => menuButton('Codex seat actions').click())
  await settle()
  act(() => menuItem('Move down').click())
  await settle()

  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({
      seats: [{ runtime: 'claude-code', effort: 'high' }, { runtime: 'codex', model: 'gpt-5.6' }],
    }),
  )
})

it('removing one seat leaves the rest of the list exactly as it was', async () => {
  const onChange = render(ROLE({
    seats: [{ runtime: 'codex', model: 'gpt-5.6' }, { runtime: 'claude-code', effort: 'high' }],
  }))
  act(() => menuButton('Codex seat actions').click())
  await settle()
  act(() => menuItem('Remove seat').click())
  await settle()

  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ seats: [{ runtime: 'claude-code', effort: 'high' }] }))
})
