import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { leadContract } from '../../preview/lead-fixture'
const modules = import.meta.glob('./LeadPlanFlow.tsx', { eager: true }) as Record<string, { LeadPlanFlow: React.ComponentType<any> }>
const LeadPlanFlow = modules['./LeadPlanFlow.tsx']?.LeadPlanFlow ?? (() => null)

it('reads each ordered step and its responsible roles once, followed by approval, with decorative connectors', () => {
  const box = document.createElement('div'), root = createRoot(box)
  const steps = [...leadContract.steps, { ...leadContract.steps[0]!, id: 'long', title: '<img src=x onerror=alert(1)> A very long step '.repeat(15) }]
  act(() => root.render(<LeadPlanFlow steps={steps} origin={{ source: 'pull-request', event: 'checks-failed', subject: 'acme/widgets#12', url: 'https://github.com/acme/widgets/pull/12' }} />))
  try {
    expect(box.querySelector('ol[aria-label="Plan flow"]')).not.toBeNull()
    expect(box.querySelectorAll('li')).toHaveLength(3)
    expect(box.textContent?.match(/Implement and review/g)).toHaveLength(1)
    expect(box.textContent).toContain('write, then review')
    expect(box.querySelector('li:last-child')?.textContent).toContain('Approve to start')
    expect(box.textContent).toContain('From: checks failed on acme/widgets#12')
    expect(box.querySelectorAll('[data-slot="timeline-rail"][aria-hidden="true"]')).toHaveLength(3)
    expect(box.querySelector('img,[onerror]')).toBeNull()
  } finally { act(() => root.unmount()) }
})

it('renders a scheduled origin without exposing its idempotency key or raw timestamp', () => {
  const box = document.createElement('div'), root = createRoot(box), slot = new Date(2026, 9, 26, 9).getTime()
  act(() => root.render(<LeadPlanFlow steps={leadContract.steps} origin={{ source: 'schedule', event: 'schedule-repeat-internal-id', subject: String(slot), url: null }} />))
  try {
    expect(box.textContent).toContain('From: scheduled run, Mon, Oct 26')
    expect(box.textContent).toContain('9:00 AM')
    expect(box.textContent).not.toContain('internal-id')
    expect(box.textContent).not.toContain(String(slot))
  } finally { act(() => root.unmount()) }
})
