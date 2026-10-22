import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { LibrarySkillsControls } from './library-skills-controls'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('keeps a selected attention filter visible when its count drops to zero', () => {
  const box = document.createElement('div'); document.body.append(box)
  const root = createRoot(box)
  const option = { id: 'filter', label: 'Filter', value: '', items: [], change: vi.fn() }
  try {
    act(() => root.render(<LibrarySkillsControls chip="needs-you" counts={{ all: 3, 'needs-you': 0, 'one-runtime': 0, nobody: 0 }} onChip={vi.fn()}
      view="cards" onView={vi.fn()} filters={option} agent={option} runtime={{ ...option, value: 'unknown' }} search={{ label: 'Search skills', value: '', change: vi.fn() }} />))
    const selected = box.querySelector('[role="radio"][aria-checked="true"]')
    expect(selected?.textContent).toBe('Needs attention0')
    expect(box.querySelector('[title="Runtime"]')?.textContent).toBe('Selected runtime')
  } finally { act(() => root.unmount()); box.remove() }
})

it('does not let Loaded by replace an active Needs attention selection', async () => {
  const box = document.createElement('div'); document.body.append(box)
  const root = createRoot(box), onChip = vi.fn()
  const option = { id: 'filter', label: 'Filter', value: 'all', items: [], change: vi.fn() }
  try {
    await act(async () => root.render(<LibrarySkillsControls chip="needs-you" counts={{ all: 3, 'needs-you': 1, 'one-runtime': 1, nobody: 0 }} onChip={onChip}
      view="cards" onView={vi.fn()} filters={option} agent={option} runtime={option} search={{ label: 'Search skills', value: '', change: vi.fn() }} />))
    await act(async () => box.querySelector<HTMLButtonElement>('[title="Filter skills"]')!.click())
    const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].filter(node => ['Any number', 'One runtime', 'No runtime'].some(label => node.textContent?.startsWith(label)))
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(row.getAttribute('aria-disabled')).toBe('true')
      await act(async () => row.click())
    }
    expect(onChip).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Clear Needs attention to filter by runtime count.')
  } finally { act(() => root.unmount()); box.remove() }
})

it.each(['one-runtime', 'nobody'] as const)('lets All clear the %s reach filter', async chip => {
  const box = document.createElement('div'); document.body.append(box)
  const root = createRoot(box), onChip = vi.fn()
  const option = { id: 'filter', label: 'Filter', value: 'all', items: [], change: vi.fn() }
  try {
    await act(async () => root.render(<LibrarySkillsControls chip={chip} counts={{ all: 3, 'needs-you': 1, 'one-runtime': 1, nobody: 1 }} onChip={onChip}
      view="cards" onView={vi.fn()} filters={option} agent={option} runtime={option} search={{ label: 'Search skills', value: '', change: vi.fn() }} />))
    await act(async () => box.querySelector<HTMLButtonElement>('[aria-label="Skills"] [role="radio"]')!.click())
    expect(onChip).toHaveBeenCalledWith('all')
  } finally { act(() => root.unmount()); box.remove() }
})
