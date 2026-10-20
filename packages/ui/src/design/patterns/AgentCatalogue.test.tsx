import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentCatalogue, AgentCatalogueCard, AgentCatalogueSources } from './AgentCatalogue'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

it('opens a role through one native button and keeps purpose, runtime and issue readings separate', () => {
  const onOpen = vi.fn()
  act(() => root.render(<AgentCatalogue><AgentCatalogueCard name="Code reviewer" description="Review the work." runtime="Runtime A · Model A" face={<span>CR</span>} status="Can't seat here" problem="The account is signed out." onOpen={onOpen} /></AgentCatalogue>))
  const card = host.querySelector<HTMLButtonElement>('[data-slot="agent-card"]')!
  expect(card.tagName).toBe('BUTTON')
  expect(card.querySelectorAll('button')).toHaveLength(0)
  expect(host.querySelector('[data-slot="agent-catalogue"]')?.getAttribute('role')).toBeNull()
  expect(card.querySelector('[data-slot="agent-card-description"]')?.textContent).toBe('Review the work.')
  expect(card.querySelector('[data-slot="agent-card-runtime"]')?.textContent).toBe('Runtime A · Model A')
  expect(card.querySelectorAll('[data-slot="issue-mark"]')).toHaveLength(1)
  expect(card.querySelector('[data-slot="issue-mark"]')?.getAttribute('aria-label')).toBe('The account is signed out.')
  const readings = card.getAttribute('aria-describedby')!.split(' ').map(id => document.getElementById(id)?.textContent)
  expect(readings).toContain('The account is signed out.')
  act(() => card.click())
  expect(onOpen).toHaveBeenCalledTimes(1)
})

it('makes sources an explicit accessible disclosure', () => {
  act(() => root.render(<AgentCatalogueSources><span>Source details</span></AgentCatalogueSources>))
  const button = host.querySelector<HTMLButtonElement>('button')!
  expect(button.getAttribute('aria-expanded')).toBe('false')
  expect(host.textContent).not.toContain('Source details')
  act(() => button.click())
  expect(button.getAttribute('aria-expanded')).toBe('true')
  expect(document.getElementById(button.getAttribute('aria-controls')!)?.textContent).toBe('Source details')
  act(() => button.click())
  expect(host.textContent).not.toContain('Source details')
})
