import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { UsageReport } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { previewStore } from '../preview/harness'
import { frameDestinationStore } from '../preview/frame-destination-store'
import { SettingsTestScope } from '../test-support/settings-page'
import { RuntimesSection } from './SettingsAgents'

/** Settings › Runtimes says which account to spend first when an allowance is about to refill unspent (Q15). */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let box: HTMLDivElement, root: Root
beforeEach(() => { box = document.createElement('div'); document.body.append(box); root = createRoot(box) })
afterEach(() => { act(() => root.unmount()); box.remove() })

const HOUR = 3_600_000
const weekly = (runtime: UsageReport['runtime'], account: string, usedPercent: number, resetsAt: number): UsageReport => ({
  runtime, account, plan: 'Pro', credits: null, spend: null, reached: null,
  lanes: [{ id: 'weekly', label: 'Weekly', usedPercent, windowMinutes: 10_080, resetsAt }],
  source: { kind: 'runtime', label: 'from the agent' }, fetchedAt: Date.now() - 60_000, staleAfterMs: 10 * 60_000, error: null,
})

const render = async (usage: (runtime: UsageReport['runtime']) => UsageReport[]) => {
  const runtime = previewStore().getSnapshot().runtimes[0]!
  const store = frameDestinationStore(previewStore({ usage: usage(runtime.id) }))
  await act(async () => root.render(<StoreProvider store={store}><SettingsTestScope>
    <RuntimesSection view={{ kind: 'list' }} onView={() => {}} onSignIn={() => {}} />
  </SettingsTestScope></StoreProvider>))
  return runtime.presentation.name
}

it('names the account whose window refills soon with most of it unspent, and when', async () => {
  const now = Date.now()
  const name = await render((runtime) => [
    weekly(runtime, 'dev@example.com', 10, now + 6 * 24 * HOUR),
    weekly(runtime, 'team@acme.dev', 30, now + 20 * HOUR),
  ])
  const note = [...box.querySelectorAll('p')].find((node) => node.textContent?.startsWith('Use '))
  expect(note?.textContent).toMatch(new RegExp(`^Use ${name} \\(team@acme\\.dev\\) first — its Weekly has 70% left and resets .+\\.$`))
})

it('says nothing when no allowance is about to be lost', async () => {
  const now = Date.now()
  await render((runtime) => [
    weekly(runtime, 'dev@example.com', 10, now + 6 * 24 * HOUR),
    weekly(runtime, 'team@acme.dev', 30, now + 5 * 24 * HOUR),
  ])
  expect(box.textContent).not.toContain('first —')
})
