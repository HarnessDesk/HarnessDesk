import { expect, it } from 'vitest'

import conversationCss from './Conversation.module.css?raw'
import conversationTsx from './Conversation.tsx?raw'
import itemsCss from './Items.module.css?raw'
import itemsTsx from './Items.tsx?raw'
import stepGroupTsx from './StepGroup.tsx?raw'
import baseCss from '../styles/base.css?raw'

it('keeps transcript animations bound to shared global keyframes', () => {
  // Tailwind arbitrary animation utilities name global keyframes, so motion
  // belongs to the base motion contract rather than a CSS-module-local sheet.
  for (const name of ['hd-spin', 'hd-pulse', 'hd-blink']) expect(baseCss).toContain(`@keyframes ${name}`)
  expect(conversationCss).not.toMatch(/@keyframes\s+(spin|pulse)/)
  expect(itemsCss).not.toMatch(/@keyframes\s+(spin|blink)/)
  expect(conversationTsx).toMatch(/animate-\[hd-spin_/)
  expect(conversationTsx).toMatch(/animate-\[hd-pulse_/)
  expect(itemsTsx).toMatch(/animate-\[hd-spin_/)
  expect(itemsTsx).toMatch(/animate-\[hd-blink_/)
  // A step group's running mark is the system spinner, not a fourth drawing.
  expect(stepGroupTsx).toMatch(/<Spinner size="sm" tone="brand" \/>/)
  expect(stepGroupTsx).not.toMatch(/animate-\[hd-spin_/)
})

it('keeps the light work register compact and its grouped body visibly nested', () => {
  expect(itemsTsx).toContain("register === 'light' ? 'py-(--hd-space-px)' : 'py-(--hd-space-1)'")
  // The step group composes the same rhythm and body the design system owns
  // (`TurnItem`, `StepFoldBody`), whose drawing is pinned in its own test.
  expect(stepGroupTsx).toContain('<TurnItem register={register}')
  expect(stepGroupTsx).toContain('<StepFoldBody register={register}>')
  expect(stepGroupTsx).not.toContain('py-(--hd-space')
  expect(stepGroupTsx).not.toContain('styles.groupBody')
  expect(itemsCss).not.toMatch(/\.groupBody\s*\{\s*\}/)
})

it('caps a single attached image in both its tile and thumbnail', () => {
  expect(itemsTsx).toContain("singleImage ? 'h-auto max-h-[280px]' : 'h-full'")
  expect(itemsTsx).not.toContain("className={`${styles.imageTile} ${singleImage ? 'h-auto max-h-[280px]' : ''}`}")
})
