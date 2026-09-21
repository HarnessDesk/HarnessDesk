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
  expect(stepGroupTsx).toMatch(/animate-\[hd-spin_/)
})

it('keeps the light work register compact and its grouped body visibly nested', () => {
  expect(itemsTsx).toContain("register === 'light' ? 'py-(--hd-space-px)' : 'py-(--hd-space-1)'")
  expect(stepGroupTsx).toContain("register === 'light' ? 'py-(--hd-space-px)' : 'py-(--hd-space-1)'")
  expect(stepGroupTsx).toContain('flex flex-col [&>div]:py-0')
  expect(stepGroupTsx).toContain("'pl-(--hd-space-5) pb-(--hd-space-0-5) border-t-0 gap-(--hd-space-px)'")
  expect(stepGroupTsx).toContain("'pt-(--hd-space-0-5) px-(--hd-space-2) pb-(--hd-space-2) border-t border-(--hd-border) gap-(--hd-space-1)'")
})

it('caps a single attached image in both its tile and thumbnail', () => {
  expect(itemsTsx).toContain("singleImage ? 'h-auto max-h-[280px]' : ''")
  expect(itemsTsx).toContain("singleImage ? 'h-auto max-h-[280px]' : 'h-full'")
})
