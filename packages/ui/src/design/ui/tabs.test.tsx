import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { Tabs, TabsList, TabsTrigger } from './tabs'

it('keeps a section tab focus outline inside a scrolling strip', () => {
 const container=document.createElement('div')
 document.body.append(container)
 const root=createRoot(container)
 try {
  act(()=>root.render(<Tabs value="overview"><TabsList variant="section"><TabsTrigger value="overview">Overview</TabsTrigger></TabsList></Tabs>))
  expect(container.querySelector('[data-slot="tabs-trigger"]')?.className).toContain('group-data-[variant=section]/tabs-list:focus-visible:outline-offset-[calc(-1*var(--hd-ring-width))]')
 } finally {act(()=>root.unmount());container.remove()}
})

it('keeps a measurable label and an icon count when a tab folds', () => {
 const container=document.createElement('div')
 document.body.append(container)
 const root=createRoot(container)
 try {
  act(()=>root.render(<Tabs value="board"><TabsList><TabsTrigger value="board" icon={<svg />} iconOnly count={2}>Board</TabsTrigger></TabsList></Tabs>))
  expect(container.querySelector('[data-slot="tabs-label"]')?.textContent).toBe('Board2')
  expect(container.querySelector('[data-slot="tabs-count"]')?.textContent).toBe('2')
  expect(container.querySelector('[role="tab"]')?.getAttribute('data-icon-only')).toBe('true')
 } finally {act(()=>root.unmount());container.remove()}
})
