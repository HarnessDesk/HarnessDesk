import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { HOVER_CARD_WIDTH_REM, HoverCard, HoverCardContent, HoverCardTrigger } from './hover-card'

/**
 * The width a caller measures is the width the card is drawn at.
 *
 * `AgentHoverCard` decides beside-or-under by asking whether
 * `HOVER_CARD_WIDTH_REM` fits next to the trigger, while the card itself is
 * drawn by a Tailwind class. The two are written in different places and
 * nothing else ties them: widen the class and every decision is made for a
 * card that no longer exists, and the symptom is a card drawn off the window
 * in exactly the narrow room the measurement is for — with a green suite.
 * Review found the gap; this is the tie.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('is drawn at the width callers measure it by', () => {
  act(() =>
    root.render(
      <HoverCard open>
        <HoverCardTrigger asChild>
          <span>trigger</span>
        </HoverCardTrigger>
        <HoverCardContent>card</HoverCardContent>
      </HoverCard>,
    ),
  )
  const card = document.querySelector('[data-slot="hover-card-content"]')
  expect(card, 'an open card renders its content').not.toBeNull()
  // Tailwind's spacing unit is a quarter of a rem, so 18rem is `w-72`.
  const width = [...(card?.classList ?? [])].filter((name) => /^w-\d+$/.test(name))
  expect(width).toEqual([`w-${HOVER_CARD_WIDTH_REM * 4}`])
})
