import { expect, it } from 'vitest'

import mapCss from './ConversationMap.module.css?raw'
import filesCss from './TurnFiles.module.css?raw'
import workCss from './TurnWork.module.css?raw'

/**
 * These three transcript pieces keep their geometry in their own sheets, but
 * their visual roles come from the public design utilities at the call site.
 * Pin representative roles so a later layout edit cannot quietly restore a
 * second spelling of a card, map mark, or turn-status treatment.
 */
it('keeps conversation-map, file-card, and turn-work appearance in design roles', () => {
  expect(mapCss).not.toMatch(/\.dash\s*\{[^}]*\bbackground\s*:/s)
  expect(mapCss).not.toMatch(/\.preview\s*\{[^}]*\b(box-shadow|background|color|font-size)\s*:/s)

  expect(filesCss).not.toMatch(/\.card\s*\{[^}]*\b(border-radius|background|box-shadow)\s*:/s)
  expect(filesCss).not.toMatch(/\.titleLine\s*\{[^}]*\b(font-size|font-weight|color)\s*:/s)

  expect(workCss).not.toMatch(/\.live\s*\{[^}]*\b(min-height|padding|font-size|color)\s*:/s)
  expect(workCss).not.toMatch(/\.shimmer\s*\{/s)
})

it('does not let a work-header hover erase trouble ink', () => {
  expect(workCss).toMatch(/\.work:not\(\[data-trouble\]\)\s+\.head:hover\s+\.headLabel\s*\{[^}]*color:\s*var\(--hd-secondary-foreground\)/s)
  expect(workCss).not.toMatch(/^\.head:hover\s+\.headLabel\s*\{/m)
})
