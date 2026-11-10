import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LeadContextFacts } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { LeadContextSection, leadContextWords } from './LeadCheckpoint'
import { LeadHostNotice } from './LeadMessage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const facts = (over: Partial<LeadContextFacts> = {}): LeadContextFacts => ({ version: 1, windowTokens: 200_000, usedTokens: 50_000, cacheHitRate: 0.874, compacting: false,
  checkpoints: [{ id: 'checkpoint-1', at: 1, fallback: false, beforeTokens: 170_000, afterTokens: 30_000, text: '## Facts learned\nThe code word is heron-42.<script>alert(1)</script>' }], ...over })
const render = (node: React.ReactNode, lead: Record<string, unknown>) => {
  const snapshot = emptySnapshot()
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, lead } as unknown as AppStore
  act(() => { root.render(<StoreProvider store={store}>{node}</StoreProvider>) })
}
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === name)!

it('draws a checkpoint notice as a rule across the thread whose View reads the summary', async () => {
  const lead = { readContext: vi.fn(async () => facts()) }
  render(<LeadHostNotice message={{ version: 1, id: 'm-3', revision: 3, role: 'notice', text: 'Earlier conversation summarised.', checkpoint: { id: 'checkpoint-1' } }} />, lead)
  const marker = container.querySelector('[data-slot="marker"][data-variant="separator"]')
  expect(marker?.textContent).toContain('Earlier conversation summarised')
  expect(container.querySelector('article[aria-label="Desk"]')).toBeNull()
  await act(async () => button('View').click())
  expect(lead.readContext).toHaveBeenCalledTimes(1)
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('Earlier conversation')
  expect(dialog.textContent).toContain('The code word is heron-42.')
  expect(dialog.textContent).toContain('Your later messages win.')
  expect(dialog.querySelector('script')).toBeNull()
  await act(async () => button('Close').click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('says when a summary is no longer kept, and when the desk wrote it itself', async () => {
  const lead = { readContext: vi.fn(async () => facts({ checkpoints: [] })) }
  render(<LeadHostNotice message={{ version: 1, id: 'm-3', revision: 3, role: 'notice', text: 'Earlier conversation summarised.', checkpoint: { id: 'checkpoint-1', fallback: true } }} />, lead)
  await act(async () => button('View').click())
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('no longer kept')
  expect(dialog.textContent).toContain('Put together by the desk from the conversation itself.')
})

it('shows context use and the cache hit rate as facts, and Summarise now compacts', async () => {
  const lead = { readContext: vi.fn(async () => facts()), compactContext: vi.fn(async () => facts({ usedTokens: 30_000, checkpoints: [...facts().checkpoints, { ...facts().checkpoints[0]!, id: 'checkpoint-2' }] })) }
  await act(async () => render(<LeadContextSection />, lead))
  expect(container.textContent).toContain('25% of 200k tokens')
  expect(container.textContent).toContain('87% of the prompt read from the cache')
  await act(async () => button('Summarise now').click())
  expect(lead.compactContext).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain('15% of 200k tokens')
  expect(leadContextWords(facts({ usedTokens: null, cacheHitRate: null, checkpoints: [] }))).toEqual({ used: 'Nothing sent yet', cache: 'No requests yet', summaries: 'None yet' })
})

it('keeps a refused Summarise now on screen in the person\'s words', async () => {
  const lead = { readContext: vi.fn(async () => facts()), compactContext: vi.fn(async () => { throw Object.assign(new Error('x'), { wireCode: 'lead-request-in-flight' }) }) }
  await act(async () => render(<LeadContextSection />, lead))
  await act(async () => button('Summarise now').click())
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Wait for the current request to finish.')
})

it('says once the latest messages alone fill the Lead\'s room, and says nothing otherwise', async () => {
  await act(async () => render(<LeadContextSection />, { readContext: vi.fn(async () => facts()) }))
  expect(container.textContent).not.toContain('Summaries pause')
  await act(async () => render(<LeadContextSection key="full" />, { readContext: vi.fn(async () => facts({ full: true })) }))
  expect(container.textContent).toContain('The latest messages alone fill most of the Lead\'s room. Summaries pause until the conversation grows.')
})
