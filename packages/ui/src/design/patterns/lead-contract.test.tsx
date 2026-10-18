import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { StoreProvider } from '../../state/context'
import { previewStore } from '../../preview/harness'
import leadCss from './lead-contract.module.css?raw'
const modules = import.meta.glob('./lead-contract.tsx', { eager: true }) as Record<string, { LeadContract: React.ComponentType<any>; LeadMessage: React.ComponentType<any> }>
const LeadContract = modules['./lead-contract.tsx']?.LeadContract ?? (() => null)
it('keeps keyboard decisions in reading order at narrow width with wrapping prose', () => {
  const box = document.createElement('div'); box.style.width = '280px'; document.body.append(box); const root = createRoot(box)
  act(() => root.render(<StoreProvider store={previewStore()}><LeadContract title="Plan" revision={2} summary="A long approval sentence must remain whole at narrow widths." onApprove={() => {}} onDecline={() => {}} /></StoreProvider>))
  try {
    const buttons = [...box.querySelectorAll('button')]
    expect(buttons.map(node => node.textContent)).toEqual(['Approve', 'Decline'])
    for (const node of buttons) { node.focus(); expect(document.activeElement).toBe(node); expect(node.tabIndex).toBe(0) }
    expect(box.querySelector('[data-slot="lead-contract"]')).not.toBeNull()
    expect(box.querySelector('[data-lead-actions]')?.className).toContain('flex-wrap')
    expect(box.querySelector('[data-lead-prose]')?.className).not.toContain('truncate')
  } finally { act(() => root.unmount()); box.remove() }
})

it('uses one surface with inset row groups, a state chip and a revision fact', () => {
  const box = document.createElement('div'), root = createRoot(box)
  act(() => root.render(<StoreProvider store={previewStore()}><LeadContract title="Plan" revision={2} summary="A summary." onApprove={() => {}} /></StoreProvider>))
  try {
    expect(box.querySelectorAll('[data-slot="card"]')).toHaveLength(1)
    expect(box.querySelector('[data-slot="card-content"]')).not.toBeNull()
    expect(box.querySelector('[data-lead-state]')?.textContent).toBe('Pending')
    expect(box.querySelector('[data-lead-prose] p')).not.toBeNull()
  } finally { act(() => root.unmount()) }
})

it.each(['user', 'assistant'])('exposes the %s speaker through a nameable message role', role => {
  const LeadMessage = modules['./lead-contract.tsx']!.LeadMessage
  const box = document.createElement('div'), root = createRoot(box)
  act(() => root.render(<StoreProvider store={previewStore()}><LeadMessage role={role} text="Synthetic message" /></StoreProvider>))
  try { expect(box.querySelector('[role="article"]')?.getAttribute('aria-label')).toBe(role === 'user' ? 'You' : 'Lead') }
  finally { act(() => root.unmount()) }
})

it('uses only the stack gap between card groups', () => {
  expect(leadCss).toMatch(/gap: var\(--hd-page-stack\)/)
  expect(leadCss).not.toMatch(/(?:^|\n)\s*(?:padding(?:-[\w-]+)?|border(?:-[\w-]+)?|background(?:-[\w-]+)?)\s*:/)
})
