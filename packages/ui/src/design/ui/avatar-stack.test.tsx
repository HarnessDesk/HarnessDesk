import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'

import { AvatarStack } from './avatar-stack'
import { BoardCard } from './board'

/**
 * A stack of faces is faces: it takes its corner from the person's choice for
 * faces, and its fallback is the solid face every other face is. The other two
 * shapes stay fixed corners for a stack that is not someone.
 */

const members = [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }]

it('draws faces at the face corner, solid, by default', () => {
  const markup = renderToStaticMarkup(<AvatarStack members={members} />)
  expect(markup).toContain('rounded-(--hd-face-radius)')
  expect(markup).toContain('text-(--hd-accent-foreground)')
  expect(markup).not.toContain('rounded-md')
})

it('keeps a fixed corner and the soft wash when asked for one', () => {
  const square = renderToStaticMarkup(<AvatarStack members={members} shape="square" />)
  expect(square).toContain('rounded-md')
  expect(square).not.toContain('rounded-(--hd-face-radius)')
  expect(square).not.toContain('text-(--hd-accent-foreground)')
  expect(renderToStaticMarkup(<AvatarStack members={members} shape="round" />)).toContain('rounded-full')
})

it('keeps per-member tints and exposes names for visible and hidden identities', () => {
 const markup=renderToStaticMarkup(<AvatarStack size="stack" members={[
  {id:'one',name:'Writer',tint:'blue',mark:<span aria-hidden>W</span>},
  {id:'two',name:'Reviewer',tint:'rose',mark:<span aria-hidden>R</span>},
  {id:'three',name:'Judge'},
 ]} max={2} />)
 expect(markup).toContain('data-tint="blue"')
 expect(markup).toContain('data-tint="rose"')
 expect(markup).toContain('role="img" aria-label="Writer"')
 expect(markup).toContain('title="Judge"')
 expect(markup).toContain('+1')
 expect(markup).toContain('--stack-surface')
})

it('gives each visible face an opaque ground on its root',()=>{
 const box=document.createElement('div')
 box.innerHTML=renderToStaticMarkup(<AvatarStack members={[{id:'writer',name:'Writer',tint:'blue'}]}/>)
 expect(box.querySelector('[data-slot="avatar"]')?.className).toContain('bg-(--hd-tint-blue-ink)')
})


it('names a generic group with a pluralised member count and accepts the caller’s noun', () => {
 expect(renderToStaticMarkup(<AvatarStack members={members.slice(0,1)} />)).toContain('aria-label="1 member"')
 expect(renderToStaticMarkup(<AvatarStack members={members} />)).toContain('aria-label="2 members"')
 expect(renderToStaticMarkup(<AvatarStack members={members} aria-label="2 seats" />)).toContain('aria-label="2 seats"')
})

it('gives Board assignees their card’s ring surface', () => {
 expect(renderToStaticMarkup(<BoardCard title="Review the change" assignees={members} />)).toContain('[--stack-surface:var(--hd-card)]')
})
