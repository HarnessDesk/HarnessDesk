import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { StoreProvider } from '../../state/context'
import { previewStore } from '../../preview/harness'
import { LeadDecision } from '../../components/LeadDecision'
const modules = import.meta.glob('./lead-contract.tsx', { eager: true }) as Record<string, { LeadContract: React.ComponentType<any>; LeadMessage: React.ComponentType<any> }>
const LeadContract = modules['./lead-contract.tsx']?.LeadContract ?? (() => null)
it('keeps keyboard decisions in reading order at narrow width with wrapping prose', () => {
  const box = document.createElement('div'); box.style.width = '280px'; document.body.append(box); const root = createRoot(box)
  act(() => root.render(<StoreProvider store={previewStore()}><><LeadContract summary="A long approval sentence must remain whole at narrow widths." /><LeadDecision id="plan" title="Approve this plan?" pending={false} onApprove={() => {}} onDecline={() => {}} /></></StoreProvider>))
  try {
    const buttons = [...box.querySelectorAll('button')]
    expect(buttons.map(node => node.getAttribute('aria-label'))).toEqual(['Decline', 'Approve'])
    for (const node of buttons) { node.focus(); expect(document.activeElement).toBe(node); expect(node.tabIndex).toBe(0) }
    expect(box.querySelector('[data-slot="lead-contract"]')).not.toBeNull()
    expect(box.querySelector('[data-slot="approval-card"]')).not.toBeNull()
    expect(box.querySelector('[data-lead-prose]')?.className).not.toContain('truncate')
  } finally { act(() => root.unmount()); box.remove() }
})

it('uses assistant prose with a decided meta state and no card surface', () => {
  const box = document.createElement('div'), root = createRoot(box)
  act(() => root.render(<StoreProvider store={previewStore()}><LeadContract summary="A summary." state="Approved" /></StoreProvider>))
  try {
    expect(box.querySelectorAll('[data-slot="card"]')).toHaveLength(0)
    expect(box.querySelector('[data-slot="message"]')).not.toBeNull()
    expect(box.querySelector('[data-lead-state]')?.textContent).toBe('Approved')
    expect(box.querySelector('[data-lead-prose] p')).not.toBeNull()
  } finally { act(() => root.unmount()) }
})

it.each(['user', 'assistant'])('exposes the %s speaker through a nameable message role', role => {
  const LeadMessage = modules['./lead-contract.tsx']!.LeadMessage
  const box = document.createElement('div'), root = createRoot(box)
  act(() => root.render(<StoreProvider store={previewStore()}><LeadMessage role={role} text="Synthetic message" /></StoreProvider>))
  try { expect(box.querySelector('article')?.getAttribute('aria-label')).toBe(role === 'user' ? 'You' : 'Dex') }
  finally { act(() => root.unmount()) }
})
