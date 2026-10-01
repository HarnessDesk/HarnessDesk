import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'

import { AvatarStack } from './avatar-stack'

/**
 * A stack of faces is faces: it takes its corner from the person's choice for
 * faces, and its fallback is the solid face every other face is. The other two
 * shapes stay fixed corners for a stack that is not someone.
 */

const members = [{ name: 'Alpha' }, { name: 'Beta' }]

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
