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
const handlers = vi.hoisted(() => [] as { onApprove?: () => void }[])
vi.mock('./LeadDecision', async importOriginal => {
  const actual = await importOriginal<typeof import('./LeadDecision')>()
  return { ...actual, LeadDecision: (props: React.ComponentProps<typeof actual.LeadDecision>) => { handlers.push(props); return <actual.LeadDecision {...props} /> } }
})
const clean: (() => void)[] = []
afterEach(() => { clean.splice(0).forEach(fn => fn()); handlers.length = 0 })
const mount = (cards: readonly LeadCard[], decide = vi.fn(async () => {})) => {
  const box = document.createElement('div'); document.body.append(box); const root = createRoot(box)
  const render = (next: readonly LeadCard[]) => act(() => root.render(<StoreProvider store={previewStore()}><LeadCards cards={next} contract={leadContract} runtimes={[leadRuntime]} onDecide={decide} onChanges={() => {}} onApprovals={() => {}} /></StoreProvider>))
  render(cards); clean.push(() => { act(() => root.unmount()); box.remove() })
  return { box, render, decide }
}
const button = (box: Element, name: string) => [...box.querySelectorAll('button')].find(node => (node.getAttribute('aria-label') ?? node.textContent) === name)!
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
  expect(box.textContent).toContain('Checks'); expect(box.textContent).toContain('Review'); expect(box.textContent).toContain('Findings unknown')
  expect(box.textContent?.match(/unknown/g)?.length).toBeGreaterThanOrEqual(4)
  expect(box.textContent).not.toContain('passed')
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


it.each(['stale contract', 'empty passed evidence', 'empty failed evidence'] as const)('qualifies %s as Unknown', scenario => {
  const assertions = leadContract.assertions.map(assertion => ({ assertionId: assertion.id, revision: 1, contractRevision: scenario === 'stale contract' ? 99 : leadContract.revision,
    status: scenario === 'empty failed evidence' ? 'failed' as const : 'passed' as const, evidence: scenario === 'stale contract' ? [{ kind: 'check' as const, id: 'synthetic', revision: 'synthetic-head' }] : [], reason: null }))
  const { box } = mount([{ ...leadResult, assertions }])
  expect(box.textContent).not.toContain('passed'); expect(box.textContent).not.toContain('failed')
})
it('renders Passed only for qualified non-empty evidence', () => {
  const assertions = leadContract.assertions.map(assertion => ({ assertionId: assertion.id, revision: 1, contractRevision: leadContract.revision, status: 'passed' as const, evidence: [{ kind: 'check' as const, id: 'synthetic', revision: 'synthetic-head' }], reason: null }))
  const { box } = mount([{ ...leadResult, assertions }]); expect(box.textContent?.match(/passed/g)).toHaveLength(2); expect(box.textContent).toContain('No blocking findings')
})
it('rejects retained stale decision callbacks independently of DOM removal', async () => {
  const { render, decide } = mount([leadPlan]); const old = handlers.at(-1)!.onApprove!
  render([{ ...leadPlan, revision: 2 }]); await act(async () => old()); expect(decide).not.toHaveBeenCalled()
})
it('rejects two same-tick callbacks before disabled controls render', async () => {
  let done!: () => void; const decide = vi.fn(() => new Promise<void>(resolve => { done = resolve }))
  mount([leadPlan], decide); const approve = handlers.at(-1)!.onApprove!
  await act(async () => { approve(); approve() }); expect(decide).toHaveBeenCalledTimes(1)
  await act(async () => done())
})
it('person gates have no worker approval link', () => {
  const { box } = mount([leadWaiting]); expect(button(box, 'Open approvals')).toBeUndefined()
})
it('renders a worker as a short presentation-labelled card', () => {
  const { box } = mount([{ ...leadWaiting, kind: 'worker-approval', personCardId: null }])
  expect(box.textContent).not.toContain('Lead spend'); expect(box.textContent).not.toContain('Checks')
  expect(box.querySelectorAll('button')).toHaveLength(1)
})
it('keeps internal identifiers out of cards and uses compact assertion statuses', () => {
  const { box } = mount([leadPlan, leadResult])
  for (const text of ['lead-reviewed-result', 'recipe-1', 'attended', 'Ceiling:', 'task:', 'head-demo', leadContract.digest, 'Assertion revision', 'Contract revision']) expect(box.textContent).not.toContain(text)
  expect(box.textContent).toContain('Demo runtime · demo-model'); expect(box.textContent).toContain('No blocking findings')
})

it.each(['permission-change', 'budget-change'] as const)('gives %s a summary inside its one surface', type => {
  const policy = { version: 1 as const, revision: 1, mode: 'default' as const, rules: [] }
  const card: LeadCard = type === 'permission-change' ? { version: 1, id: 'policy', revision: 1, type, contractDigest: leadContract.digest, previous: policy,
    proposed: { ...policy, revision: 2, mode: 'manage', rules: [{ id: 'rule', effect: 'allow', method: 'flow/start-goal', action: null, project: null }] } }
    : { version: 1, id: 'caps', logicalGoalId: 'synthetic-goal', revision: 1, type, contractDigest: leadContract.digest, previous: { revision: 1, caps: leadContract.caps }, proposed: { usdMicros: 6000000, rounds: 5 } }
  const { box } = mount([card]); expect(box.querySelector('[data-lead-prose]')).not.toBeNull()
  if (type === 'permission-change') { expect(box.textContent).toContain('Start a run'); expect(box.textContent).not.toContain('flow/start-goal') }
})

it('does not attribute a worker approval to every runtime in the plan', () => {
  const box = document.createElement('div'), root = createRoot(box)
  const other = { ...leadRuntime, id: 'second-runtime', presentation: { ...leadRuntime.presentation, name: 'Second worker' } }
  act(() => root.render(<StoreProvider store={previewStore()}><LeadCards cards={[{ ...leadWaiting, kind: 'worker-approval', personCardId: null }]} contract={{ ...leadContract, steps: [...leadContract.steps, { ...leadContract.steps[0]!, id: 'other', assignments: [{ ...leadContract.steps[0]!.assignments[0]!, seat: { runtime: other.id } }] }] }} runtimes={[leadRuntime, other]} onDecide={vi.fn()} onChanges={vi.fn()} onApprovals={vi.fn()} /></StoreProvider>))
  try { expect(box.textContent).toContain('A worker is waiting for you to approve a command.'); expect(box.textContent).not.toContain('Second worker') }
  finally { act(() => root.unmount()) }
})

it('shows only contracted result kinds in one compact line with complete fixture evidence', () => {
  const { box } = mount([leadResult])
  expect(box.textContent).not.toContain('Changes unknown')
  expect([...box.querySelectorAll('p')].some(node => /^Changes /.test(node.textContent ?? ''))).toBe(false)
  expect(box.textContent).not.toContain('unknown')
  expect([...box.querySelectorAll('p')].some(node => node.textContent === 'Checks passed · Review passed · No blocking findings')).toBe(true)
  expect(leadResult.assertions).toHaveLength(leadContract.assertions.length)
  for (const assertion of leadContract.assertions) expect(leadResult.assertions.find(result => result.assertionId === assertion.id)).toMatchObject({ status: 'passed', contractRevision: leadContract.revision, evidence: expect.any(Array) })
})
it('names a permission change in the dock that asks for approval', () => {
  const policy = { version: 1 as const, revision: 1, mode: 'plan' as const, rules: [] }
  const { box } = mount([{ version: 1, id: 'widen', revision: 1, type: 'permission-change', contractDigest: null, previous: policy, proposed: { ...policy, revision: 2, mode: 'manage' } }])
  expect(box.querySelector('[data-lead-decision]')?.textContent).toContain('Plan → Manage')
})

it('does not display reasons for assertions outside the contract', () => {
  const { box } = mount([{ ...leadResult, assertions: [...leadResult.assertions, { assertionId: 'uncontracted', revision: 1, contractRevision: leadContract.revision, status: 'unknown', evidence: [], reason: 'Uncontracted change reason' }] }])
  expect(box.textContent).not.toContain('Uncontracted change reason')
})
