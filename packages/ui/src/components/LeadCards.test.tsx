import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { previewStore } from '../preview/harness'
import type { LeadCard } from '@harnessdesk/protocol'
import { leadContract, leadPlan, leadResult, leadRuntime, leadWaiting } from '../preview/lead-fixture'
// An absent implementation renders nothing, so the first run fails on the promised behavior.
const modules = import.meta.glob('./LeadCards.tsx', { eager: true }) as Record<string, { LeadCards: React.ComponentType<any> }>
const LeadCards = modules['./LeadCards.tsx']?.LeadCards ?? (() => null)
const clean: (() => void)[] = []
afterEach(() => clean.splice(0).forEach(fn => fn()))
const mount = (cards: readonly LeadCard[], decide = vi.fn(async () => {})) => {
  const box = document.createElement('div'); document.body.append(box); const root = createRoot(box)
  const render = (next: readonly LeadCard[]) => act(() => root.render(<StoreProvider store={previewStore()}><LeadCards cards={next} contract={leadContract} runtimes={[leadRuntime]} onDecide={decide} onChanges={() => {}} onApprovals={() => {}} /></StoreProvider>))
  render(cards); clean.push(() => { act(() => root.unmount()); box.remove() })
  return { box, render, decide }
}
const button = (box: Element, name: string) => [...box.querySelectorAll('button')].find(node => node.textContent === name)!
it('fences decisions to the seen card revision and digest, replacing stale controls in place', async () => {
  const { box, render, decide } = mount([leadPlan])
  const old = button(box, 'Approve'); expect(old).toBeDefined()
  render([{ ...leadPlan, revision: 2, contractDigest: 'b'.repeat(64), contract: { ...leadContract, digest: 'b'.repeat(64), revision: 2, goal: 'Changed scope' } } as LeadCard])
  expect(old.isConnected).toBe(false)
  await act(async () => old.click()); expect(decide).not.toHaveBeenCalled()
  await act(async () => button(box, 'Approve').click())
  expect(decide).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 2, contractDigest: 'b'.repeat(64) }))
  expect(box.querySelectorAll('[data-lead-card]')).toHaveLength(1)
})
it('never enables a worker approval and links to the existing approval surface', () => {
  const { box } = mount([{ ...leadWaiting, kind: 'worker-approval', personCardId: null } as LeadCard])
  expect(button(box, 'Open approvals')).toBeDefined()
  expect(button(box, 'Accept')).toBeUndefined(); expect(button(box, 'Approve')).toBeUndefined()
})
it('keeps missing checks, review, findings and worker spend explicitly unknown', () => {
  const { box } = mount([{ ...leadResult, assertions: [], budget: { ...leadResult.budget, spend: 'unknown' } } as LeadCard])
  expect(box.textContent).toContain('Checks'); expect(box.textContent).toContain('Review'); expect(box.textContent).toContain('Findings')
  expect(box.textContent?.match(/Unknown/g)?.length).toBeGreaterThanOrEqual(4)
  expect(box.textContent).not.toContain('Passed')
})
it('sanitizes unsafe summaries and findings', () => {
  const { box } = mount([{ ...leadWaiting, summary: '<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">Read</a>', assertions: [{ ...leadWaiting.assertions[0]!, reason: '<svg onload=alert(1)>unsafe</svg>' }] } as LeadCard])
  expect(box.textContent).toContain('Read')
  expect(box.querySelector('script,[onerror],[onload],a[href^="javascript:"]')).toBeNull()
})
it('locks both decisions during a pending request and restores focus after it', async () => {
  let done!: () => void
  const decide = vi.fn(() => new Promise<void>(resolve => { done = resolve }))
  const { box } = mount([leadPlan], decide)
  await act(async () => button(box, 'Approve').click())
  expect(box.querySelectorAll('button[disabled]')).toHaveLength(2)
  await act(async () => { box.querySelector<HTMLButtonElement>('button')!.click() }); expect(decide).toHaveBeenCalledTimes(1)
  await act(async () => done())
  expect(box.contains(document.activeElement)).toBe(true)
})
