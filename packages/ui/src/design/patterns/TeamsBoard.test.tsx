import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { TeamsBoard, TeamsBoardColumn, TeamsBoardCard } from './TeamsBoard'
;(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true

it('names columns and cards, preserves the full ask and opens a card once', async () => {
 const host=document.createElement('div');document.body.append(host)
 const root=createRoot(host),open=vi.fn()
 try {
  await act(async()=>root.render(<TeamsBoard><TeamsBoardColumn label="Needs you" tone="warning" count={1}>
   <TeamsBoardCard id="one" title="Fix checkout." brief="Fix checkout. Keep retries bounded." summary="Choose the deployment target before this Run continues." attention unread
    path={[{id:'write',label:'Write',state:'done'},{id:'review',label:'Review',state:'current'},{id:'wrap',label:'Wrap',state:'future'}]}
    project="storefront" age="2h" open={open}/>
  </TeamsBoardColumn></TeamsBoard>))
  expect(host.querySelector('section')?.getAttribute('aria-label')).toBe('Needs you')
  expect(host.querySelector('h2')?.textContent).toBe('Needs you1')
  expect(host.querySelector('h2')?.getAttribute('data-role')).toBe('section')
  expect(host.querySelector('h2 [data-role="meta"]')?.textContent).toBe('1')
  const button=host.querySelector<HTMLButtonElement>('button')!
  expect(button.getAttribute('aria-label')).toBe('Open Fix checkout.')
  expect(button.querySelector('[aria-label="Unread changes"]')).not.toBeNull()
  const description=button.getAttribute('aria-describedby')?.split(' ').map(id=>document.getElementById(id)?.textContent).join(' ')
  expect(description).toContain('Choose the deployment target before this Run continues.')
  expect(description).toContain('storefront')
  expect(button.querySelector('[data-slot="team-title"]')?.getAttribute('title')).toBe('Fix checkout. Keep retries bounded.')
  expect(button.querySelector('[data-slot="team-detail"]')?.textContent).toContain('before this Run continues.')
  expect(host.querySelectorAll('[data-step-state]')).toHaveLength(3)
  await act(async()=>button.click())
  expect(open).toHaveBeenCalledOnce()
 } finally {await act(async()=>root.unmount());host.remove()}
})

it('keeps a long refusal out of the card body while preserving its full accessible explanation', async () => {
 const host=document.createElement('div');document.body.append(host)
 const root=createRoot(host),open=vi.fn()
 const reason='The requested runtime could not start this seat. '.repeat(30)
 try {
  await act(async()=>root.render(<TeamsBoardCard id="refused-team" title="Restore the checkout retry without losing the original payment method" brief="Keep the retry bounded."
   summary="Run stopped" issue={reason} attention path={[]} project="storefront" age="2h" open={open}/>))
  const card=host.querySelector<HTMLButtonElement>('[data-team-row="refused-team"]')!
  const issue=card.querySelector('[data-slot="issue-mark"]')
  expect(issue?.getAttribute('title')).toBe(reason)
  expect(issue?.getAttribute('aria-label')).toBe(reason)
  expect(card.textContent).toContain('Run stopped')
  expect(card.textContent).not.toContain(reason)
  expect(card.querySelectorAll('[data-slot="issue-mark"]')).toHaveLength(1)
  await act(async()=>card.click())
  expect(open).toHaveBeenCalledOnce()
 } finally {await act(async()=>root.unmount());host.remove()}
})
