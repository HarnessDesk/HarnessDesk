import { LeadProactiveCard } from './LeadCards'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { previewStore } from '../preview/harness'
import type { LeadCard } from '@harnessdesk/protocol'
import { leadBudget, leadContract, leadPlan, leadResult, leadRuntime, leadWaiting } from '../preview/lead-fixture'
// An absent implementation renders nothing, so the first run fails on the promised behavior.
const modules = import.meta.glob('./LeadCards.tsx', { eager: true }) as Record<string, { LeadCards: React.ComponentType<any>; leadDollars: (micros: number) => string }>
const LeadCards = modules['./LeadCards.tsx']?.LeadCards ?? (() => null)
const leadDollars = modules['./LeadCards.tsx']?.leadDollars ?? (() => '')
const handlers = vi.hoisted(() => [] as { onApprove?: () => void }[])
vi.mock('./LeadDecision', async importOriginal => {
  const actual = await importOriginal<typeof import('./LeadDecision')>()
  return { ...actual, LeadDecision: (props: React.ComponentProps<typeof actual.LeadDecision>) => { handlers.push(props); return <actual.LeadDecision {...props} /> } }
})
const clean: (() => void)[] = []
afterEach(() => { clean.splice(0).forEach(fn => fn()); handlers.length = 0 })
const mount = (cards: readonly LeadCard[], decide = vi.fn(async () => {})) => {
  const box = document.createElement('div'); document.body.append(box); const root = createRoot(box)
  const render = (next: readonly LeadCard[]) => act(() => root.render(<StoreProvider store={previewStore()}><LeadCards cards={next} contract={leadContract} onDecide={decide} onChanges={() => {}} onApprovals={() => {}} /></StoreProvider>))
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
it('says in plain words what a result has not confirmed, and leaves out a worker spend it does not know', () => {
  const { box } = mount([{ ...leadResult, assertions: [], budget: { ...leadResult.budget, spend: 'unknown' } } as LeadCard])
  expect([...box.querySelectorAll('p')].some(node => node.textContent === 'Checks not confirmed · Review not confirmed · Findings not confirmed')).toBe(true)
  expect(box.textContent).not.toMatch(/unknown/i)
  expect(box.textContent).not.toContain('workers reported')
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
it('reads a clean findings ledger as No blocking findings, not as unconfirmed, while a check without evidence stays unconfirmed', () => {
  const assertions = leadContract.assertions.map(assertion => ({ assertionId: assertion.id, revision: 1, contractRevision: leadContract.revision, status: 'passed' as const,
    evidence: assertion.kind === 'blocking-findings' ? [] : [{ kind: assertion.kind === 'review' ? 'review' as const : 'check' as const, id: 'synthetic', revision: 'synthetic-head' }], reason: null }))
  const { box } = mount([{ ...leadResult, assertions }])
  expect([...box.querySelectorAll('p')].some(node => /No blocking findings/.test(node.textContent ?? '') && !/not confirmed/.test(node.textContent ?? ''))).toBe(true)
  const unconfirmed = leadContract.assertions.map(assertion => ({ assertionId: assertion.id, revision: 1, contractRevision: leadContract.revision, status: 'passed' as const, evidence: [], reason: null }))
  const second = mount([{ ...leadResult, assertions: unconfirmed }])
  expect(second.box.textContent).toContain('Checks not confirmed')
  expect(second.box.textContent).toContain('No blocking findings')
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
  for (const text of ['Demo runtime', 'demo-model']) expect(box.textContent).not.toContain(text)
  expect(box.textContent).toContain('write, then review'); expect(box.textContent).toContain('No blocking findings')
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
  act(() => root.render(<StoreProvider store={previewStore()}><LeadCards cards={[{ ...leadWaiting, kind: 'worker-approval', personCardId: null }]} contract={{ ...leadContract, steps: [...leadContract.steps, { ...leadContract.steps[0]!, id: 'other', assignments: [{ ...leadContract.steps[0]!.assignments[0]!, seat: { runtime: other.id } }] }] }} onDecide={vi.fn()} onChanges={vi.fn()} onApprovals={vi.fn()} /></StoreProvider>))
  try { expect(box.textContent).toContain(leadWaiting.summary); expect(box.textContent).not.toContain('Second worker') }
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

it('shows the plan project by its name and never by its path', () => {
  const contract = { ...leadContract, project: { id: 'acme', path: '/tmp/hd-lead-rig-1a2b/acme' }, caps: { usdMicros: 5123456, rounds: 4 } }
  const { box } = mount([{ ...leadPlan, contract } as LeadCard])
  expect([...box.querySelectorAll('p')].map(node => node.textContent).find(text => text?.startsWith('Up to'))).toBe('Up to $5.12 · 4 rounds · acme')
  expect(box.textContent).not.toContain('/tmp'); expect(box.textContent).not.toContain('hd-lead-rig')
})

it('names each plan step by what its seats do, never by a runtime or a model', () => {
  const seat = { runtime: 'fixture', model: 'demo-model' }
  const step = (id: string, roles: string[]) => ({ ...leadContract.steps[0]!, id, title: `Change ${id}`,
    assignments: roles.map(role => ({ role, agent: 'builder', seat, ceiling: 'edit' as const })) })
  const contract = { ...leadContract, steps: [step('one', ['implement', 'review']), step('two', ['implement']), step('three', ['implement', 'implement', 'review']), step('four', ['security-audit'])] }
  const { box } = mount([{ ...leadPlan, contract } as LeadCard])
  expect([...box.querySelectorAll('li')].slice(0, 4).map(node => node.textContent)).toEqual([
    'Change one — write, then review', 'Change two — write', 'Change three — write, then review', 'Change four — security audit'])
  for (const text of ['Demo runtime', 'demo-model', 'fixture', 'Worker unavailable']) expect(box.textContent).not.toContain(text)
})

it('rounds every amount to whole cents, and never shows a positive amount as $0.00', () => {
  expect([78264, 5000000, 1234567, 0].map(leadDollars)).toEqual(['$0.08', '$5.00', '$1.23', '$0.00'])
  expect(leadDollars(4000)).toBe('less than $0.01')
  const policy = { ...leadContract.caps }
  const { box } = mount([{ version: 1, id: 'caps', logicalGoalId: 'synthetic-goal', revision: 1, type: 'budget-change', contractDigest: leadContract.digest,
    previous: { revision: 1, caps: policy }, proposed: { usdMicros: 6250000, rounds: 5 } }])
  expect(box.textContent).toContain('Raise the allowance from $5.00 to $6.25 and from 4 to 5 rounds?')
})

it('says workers reported $0.00 only when that is known, and leaves the clause out when it is not', () => {
  const spendLine = (budget: object) => {
    const { box } = mount([{ ...leadResult, budget: { ...leadBudget, ...budget } } as LeadCard])
    return [...box.querySelectorAll('p')].map(node => node.textContent).find(text => text?.startsWith('I spent'))
  }
  expect(spendLine({ leadUsdMicros: 78264, workerUsdMicros: 0 })).toBe('I spent $0.08 · workers reported $0.00.')
  expect(spendLine({ leadUsdMicros: 78264, workerUsdMicros: 4000 })).toBe('I spent $0.08 · workers reported less than $0.01.')
  expect(spendLine({ leadUsdMicros: 78264, workerUsdMicros: 0, spend: 'unknown' })).toBe('I spent $0.08.')
})
it('keeps a settled result judged against its own plan once a later goal has its own contract', () => {
  const box = document.createElement('div'); document.body.append(box); const root = createRoot(box)
  const next = { ...leadContract, revision: 2, digest: 'b'.repeat(64), goal: 'Add the missing test' }
  act(() => root.render(<StoreProvider store={previewStore()}><LeadCards cards={[]} contract={next} decisions={[{ card: leadPlan, choice: 'approve', position: 1 }, { card: leadResult, choice: 'decline', position: 2 }]} onDecide={vi.fn(async () => {})} onChanges={() => {}} onApprovals={() => {}} /></StoreProvider>))
  clean.push(() => { act(() => root.unmount()); box.remove() })
  expect([...box.querySelectorAll('p')].some(node => node.textContent === 'Checks passed · Review passed · No blocking findings')).toBe(true)
  expect(box.textContent).not.toContain('not confirmed')
})
it('reads a findings gate passed with nothing to cite as no blocking findings, not as unconfirmed', () => {
  const none = { ...leadResult, assertions: leadResult.assertions.map(result => leadContract.assertions.find(assertion => assertion.id === result.assertionId)?.kind === 'blocking-findings' ? { ...result, evidence: [] } : result) }
  const { box } = mount([none])
  expect([...box.querySelectorAll('p')].some(node => node.textContent === 'Checks passed · Review passed · No blocking findings')).toBe(true)
  expect(box.textContent).not.toContain('Findings not confirmed')
})

it('shows request-specific person actions and keeps them out of plan decisions', async () => {
  const box = document.createElement('div'); document.body.append(box); const root = createRoot(box)
  const perform = vi.fn(async () => {}), decide = vi.fn(async () => {})
  const actions = [{ kind: 'worker-approval', id: 'worker', runId: 'run', role: 'code reviewer', request: 'read the git log', choices: ['yes-once', 'no'] },
    { kind: 'check', id: 'check', runId: 'run', name: 'verify', command: 'node --test' }]
  act(() => root.render(<StoreProvider store={previewStore()}><LeadCards cards={[]} personActions={actions} contract={leadContract} onPerform={perform} onDecide={decide} onChanges={() => {}} onApprovals={() => {}} /></StoreProvider>))
  clean.push(() => { act(() => root.unmount()); box.remove() })
  expect(box.textContent).toContain('code reviewer'); expect(box.textContent).toContain('read the git log'); expect(box.textContent).toContain('node --test')
  await act(async () => button(box, 'Yes once').click())
  expect(perform).toHaveBeenCalledWith({ id: 'worker', contractDigest: leadContract.digest, choice: 'yes-once' })
  await act(async () => button(box, 'No').click())
  expect(perform).toHaveBeenCalledWith({ id: 'worker', contractDigest: leadContract.digest, choice: 'no' })
  await act(async () => button(box, 'Run check verify').click())
  expect(perform).toHaveBeenCalledWith({ id: 'check', contractDigest: leadContract.digest, choice: 'run' })
  expect(decide).not.toHaveBeenCalled()
})


it('offers a reclaim choice bound to the observed branch head', async () => {
  const card = { version: 1, id: 'reclaim-7', revision: 1, type: 'branch-ownership', contractDigest: leadContract.digest,
    repository: 'acme/widgets', number: 7, observedHead: 'b'.repeat(40), summary: 'The branch was updated by another writer.' } as any
  const { box, decide } = mount([card])
  expect(box.textContent).toContain('Take the branch back')
  await act(async () => { button(box, 'Take the branch back').click() })
  expect(decide).toHaveBeenCalledWith(expect.objectContaining({ cardId: card.id, choice: 'reclaim-branch', expectedRevision: 1 }))
})

it('offers four result actions and binds publication to the reviewed revision under the shared pending lock', async () => {
  let done!: () => void
  const decide = vi.fn(() => new Promise<void>(resolve => { done = resolve }))
  const { box } = mount([leadResult], decide)
  expect([...box.querySelectorAll('[data-lead-decision] button')].map(node => node.textContent?.replace(/\d/g, '').trim())).toEqual(['Open changes', 'Decline', 'Accept', 'Accept and open PR'])
  await act(async () => button(box, 'Accept and open PR').click())
  expect(decide).toHaveBeenCalledWith(expect.objectContaining({ choice: 'accept-open-pr', expectedRevision: leadResult.revision, contractDigest: leadResult.contractDigest }))
  await act(async () => button(box, 'Accept').click())
  expect(decide).toHaveBeenCalledTimes(1)
  await act(async () => done())
})

it('renders the explicit push card through its reviewed-result decision and describes the effect', async () => {
  const { box, decide } = mount([{ ...leadResult, publication: 'push' }])
  expect(box.textContent).toContain('Push the reviewed changes and open a pull request.')
  await act(async () => button(box, 'Accept and open PR').click())
  expect(decide).toHaveBeenCalledWith(expect.objectContaining({ choice: 'accept-open-pr' }))
})

it('uses the server branch summary once without appending a second reclaim instruction', () => {
  const card: LeadCard = { version: 1, id: 'branch', revision: 1, type: 'branch-ownership', contractDigest: leadContract.digest,
    repository: 'acme/widgets', number: 7, observedHead: 'a'.repeat(40), summary: 'Automatic repairs are paused. Reclaim it to continue.' }
  const { box } = mount([card])
  expect(box.querySelector('[data-lead-decision]')?.textContent).not.toContain('Reclaim aaaaaaaaaaaa')
  expect(box.querySelector('[data-lead-decision]')?.textContent).toContain(card.summary)
})
it('omits the project separator when an allowance has no matching scope', () => {
  const format = (modules['./LeadCards.tsx'] as any).leadAllowance
  expect(format).toBeTypeOf('function')
  expect(format(leadBudget.caps)).toBe('Up to $5.00 · 4 rounds')
})

it('renders exactly three proactive parts and only maps existing navigation actions', () => {
  const box = document.createElement('div'), root = createRoot(box), open = vi.fn()
  act(() => root.render(<StoreProvider store={previewStore()}><LeadProactiveCard report={{ finding: 'The review is ready.', caveat: 'Checks need you.', ask: 'Open changes', action: 'changes' }} onAction={open} /></StoreProvider>))
  try {
    expect(box.querySelectorAll('[data-proactive-part]')).toHaveLength(3)
    act(() => button(box, 'Open changes').click())
    expect(open).toHaveBeenCalledWith('changes')
  } finally { act(() => root.unmount()) }
})
