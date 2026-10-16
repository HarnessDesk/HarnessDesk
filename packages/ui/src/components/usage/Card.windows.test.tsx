import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { runtimeId, type UsageReport } from '@harnessdesk/protocol'
import { Card } from './shared'

const report: UsageReport = {
  runtime: runtimeId('alpha'), account: 'dev@example.com', plan: 'Pro',
  lanes: [{ id: 'weekly', label: 'Weekly', usedPercent: 25, windowMinutes: 10080, resetsAt: null }],
  credits: null, spend: null, reached: null, source: { kind: 'runtime', label: 'from the agent' },
  fetchedAt: 0, staleAfterMs: 60000, error: null,
}
const render = (input: UsageReport) => {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<Card report={input} info={null} now={0} onRefresh={() => {}} onStopTracking={() => {}} />)
  return host
}
describe('plan card windows', () => {
  it('shows adapter plan presentation with its raw type in the title', () => {
    const host = render({ ...report, plan: 'self_serve_business_prolite', planLabel: 'Business Pro Lite' })
    expect(host.textContent).toContain('Business Pro Lite')
    expect(host.textContent).not.toContain('Self Serve')
    expect(host.querySelector('[title="self_serve_business_prolite"]')?.textContent).toContain('Business Pro Lite')
  })
  it('names the only window in the headline and draws its meter once', () => {
    const host = render(report)
    expect(host.textContent).toContain('left · Weekly')
    expect(host.textContent?.match(/Weekly/g)).toHaveLength(1)
    expect(host.querySelectorAll('[role="progressbar"]')).toHaveLength(1)
    expect(host.querySelectorAll('[data-slot="usage-meter-row"]')).toHaveLength(0)
  })
  it('keeps the named window rows when there is more than one window', () => {
    const host = render({ ...report, lanes: [
      { id: 'session', label: 'Session', usedPercent: 10, windowMinutes: 300, resetsAt: null },
      ...report.lanes,
    ] })
    expect(host.querySelectorAll('[data-slot="usage-meter-row"]')).toHaveLength(2)
    expect(host.querySelectorAll('[role="progressbar"]')).toHaveLength(3)
  })
})
