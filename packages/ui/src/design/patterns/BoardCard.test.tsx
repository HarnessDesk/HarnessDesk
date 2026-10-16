import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { BoardCard } from './BoardCard'
import { BoardCard as WorkBoardCard, CompactBoardCard } from '..'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('exports the compact frame without replacing the work-board card', () => {
 expect(CompactBoardCard).toBe(BoardCard)
 expect(WorkBoardCard).not.toBe(BoardCard)
})

it('renders the named card, aside, attention detail and described footer in order', async () => {
 const host=document.createElement('div');document.body.append(host)
 const root=createRoot(host),onOpen=vi.fn()
 try {
  await act(async()=>root.render(<BoardCard label="Open checkout" title="Checkout" titleAside={<span>Unread</span>}
   titleProps={{'data-slot':'example-title',title:'Checkout work'}} detail="Choose a target" attention
   detailProps={{id:'detail','data-slot':'example-detail',title:'Choose a target'}} aria-describedby="detail facts"
   middle={<span data-path="recorded">Review</span>} footer={<span id="facts">storefront · 2h</span>}
   data-record="checkout" onOpen={onOpen}/>))
  const button=host.querySelector<HTMLButtonElement>('button')!
  expect(button.getAttribute('aria-label')).toBe('Open checkout')
  expect(button.getAttribute('data-record')).toBe('checkout')
  expect(button.querySelector('[data-slot="example-title"]')?.textContent).toBe('CheckoutUnread')
  expect(button.querySelector('[data-slot="example-title"]')?.getAttribute('title')).toBe('Checkout work')
  expect(button.querySelector('[data-slot="example-detail"] svg')).not.toBeNull()
  expect(button.querySelector('[data-slot="example-detail"]')?.textContent).toBe('Choose a target')
  expect(Array.from(button.children).map(child=>child.textContent)).toEqual(['CheckoutUnread','Choose a target','Review','storefront · 2h'])
  expect(button.getAttribute('aria-describedby')?.split(' ').map(id=>document.getElementById(id)?.textContent)).toEqual(['Choose a target','storefront · 2h'])
  await act(async()=>button.click())
  expect(onOpen).toHaveBeenCalledOnce()
 } finally {await act(async()=>root.unmount());host.remove()}
})

it('omits absent detail, middle, aside and footer without empty wrappers', async () => {
 const host=document.createElement('div'),root=createRoot(host)
 try {
  await act(async()=>root.render(<BoardCard label="Open checkout" title="Checkout" onOpen={()=>{}}/>))
  const button=host.querySelector('button')!
  expect(button.children).toHaveLength(1)
  expect(button.textContent).toBe('Checkout')
  expect(button.querySelector('svg')).toBeNull()
  expect(button.hasAttribute('aria-describedby')).toBe(false)
 } finally {await act(async()=>root.unmount())}
})

it('renders an ordinary detail without the attention flag', async () => {
 const host=document.createElement('div'),root=createRoot(host)
 try {
  await act(async()=>root.render(<BoardCard label="Open checkout" title="Checkout" detail="Review complete" onOpen={()=>{}}/>))
  expect(host.querySelector('button')?.children).toHaveLength(2)
  expect(host.querySelector('button')?.lastElementChild?.textContent).toBe('Review complete')
  expect(host.querySelector('svg')).toBeNull()
 } finally {await act(async()=>root.unmount())}
})
