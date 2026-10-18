import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
const modules = import.meta.glob('./lead-contract.tsx', { eager: true }) as Record<string, { LeadContract: React.ComponentType<any> }>
const LeadContract = modules['./lead-contract.tsx']?.LeadContract ?? (() => null)
it('keeps keyboard decisions in reading order at narrow width with wrapping prose', () => {
  const box = document.createElement('div'); box.style.width = '280px'; document.body.append(box); const root = createRoot(box)
  act(() => root.render(<LeadContract title="Plan" revision={2} summary="A long approval sentence must remain whole at narrow widths." onApprove={() => {}} onDecline={() => {}} />))
  try {
    const buttons = [...box.querySelectorAll('button')]
    expect(buttons.map(node => node.textContent)).toEqual(['Approve', 'Decline'])
    for (const node of buttons) { node.focus(); expect(document.activeElement).toBe(node); expect(node.tabIndex).toBe(0) }
    expect(box.querySelector('[data-slot="lead-contract"]')).not.toBeNull()
    expect(box.querySelector('[data-lead-actions]')?.className).toContain('flex-wrap')
    expect(box.querySelector('[data-lead-prose]')?.className).not.toContain('truncate')
  } finally { act(() => root.unmount()); box.remove() }
})
