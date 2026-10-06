import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import type { Intent } from '@harnessdesk/protocol'
import { TableCell, TableRow } from '../design'
import { TeamBoardList } from './TeamBoardList'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

for (const check of ['counted names', 'selected Set aside'] as const) it(`list repair: ${check} survives a job reopening`, () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const job = { id: 1, title: 'Retry', updatedAt: 1 } as Intent
  const render = (aside: boolean) => act(() => root.render(<TeamBoardList intents={[job]} placed={new Map([[1, { column: aside ? 'aside' : 'todo', why: null }]])}
    renderRow={intent => <TableRow key={intent.id}><TableCell>{intent.title}</TableCell></TableRow>} />))
  try {
    render(true)
    const all = container.querySelector('button[aria-pressed="true"]')!
    if (check === 'counted names') {
      expect(all.getAttribute('aria-label') ?? all.textContent).toBe('All 1')
      return
    }
    const aside = [...container.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === 'Set aside 1')!
    act(() => aside.click())
    render(false)
    const selected = container.querySelector('button[aria-pressed="true"]')!
    expect(selected).not.toBeNull()
    expect(selected.getAttribute('aria-label') ?? selected.textContent).toBe('Set aside 0')
    expect(container.textContent).toContain('No jobs match')
  } finally { act(() => root.unmount()); container.remove() }
})

it('compact jobs group by their observed state, with Needs you first', () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const jobs = [{ id: 1, title: 'Working', updatedAt: 2 }, { id: 2, title: 'Answer', updatedAt: 1 }] as Intent[]
  try {
    act(() => root.render(<TeamBoardList compact grouped intents={jobs} placed={new Map([[1, { column: 'working', why: null }], [2, { column: 'needs', why: 'Choose' }]])} renderRow={(job, columns) => { expect(columns.has('state')).toBe(false); return <TableRow key={job.id}><TableCell>{job.title}</TableCell></TableRow> }} />))
    expect(container.querySelector('table')?.getAttribute('data-hd-table')).toBe('compact')
    expect([...container.querySelectorAll('[data-state-group]')].map(el => el.textContent)).toEqual(['Needs you', 'Working'])
  } finally { act(() => root.unmount()); container.remove() }
})
