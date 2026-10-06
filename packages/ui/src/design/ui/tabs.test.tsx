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
