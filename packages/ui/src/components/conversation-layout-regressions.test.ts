import { expect, it } from 'vitest'

import conversationCss from './Conversation.module.css?raw'
import conversationTsx from './Conversation.tsx?raw'
import itemsCss from './Items.module.css?raw'
import itemsTsx from './Items.tsx?raw'
import stepGroupTsx from './StepGroup.tsx?raw'
import skillSheetTsx from './SkillSheet.tsx?raw'
import baseCss from '../styles/base.css?raw'

it('keeps transcript animations bound to shared global keyframes', () => {
  // Tailwind arbitrary animation utilities name global keyframes, so motion
  // belongs to the base motion contract rather than a CSS-module-local sheet.
  for (const name of ['hd-spin', 'hd-pulse', 'hd-blink']) expect(baseCss).toContain(`@keyframes ${name}`)
  expect(conversationCss).not.toMatch(/@keyframes\s+(spin|pulse)/)
  expect(itemsCss).not.toMatch(/@keyframes\s+(spin|blink)/)
  // The header's running dot converged onto Chip's own `dotTone`/`dotPulse`,
  // which pulses through the shared `Dot`'s own local keyframe rather than
  // this Tailwind utility — so `hd-pulse` now names no direct consumer
  // either, kept in base.css as a general motion utility the same way
  // `hd-blink` and `hd-spin` already are below.
  expect(conversationTsx).not.toMatch(/animate-\[hd-pulse_/)
  expect(conversationTsx).toMatch(/dotTone=\{STATUS_TONE\[status\]\}/)
  // The still-writing caret converged onto the same pulsing `Dot` a sign-in
  // row already wears, so `hd-blink` now names no direct consumer either —
  // kept in base.css as a general motion utility, as hd-spin is below.
  expect(itemsTsx).toMatch(/<Dot state="signin" pulse/)
  expect(itemsTsx).not.toMatch(/animate-\[hd-blink_/)
  // A step's own running mark is the system spinner, not a fourth drawing —
  // the same rule the step group's already kept. Conversation.tsx's own two
  // running marks (the background-tasks chip, the transcript's own load)
  // moved the same way, so hd-spin's keyframe now names no direct consumer
  // in either file — Spinner draws with Tailwind's own animate-spin — and
  // stays defined in base.css as a general motion utility rather than one
  // this pass removes.
  for (const source of [conversationTsx, itemsTsx, stepGroupTsx]) {
    expect(source).toMatch(/<Spinner size="sm" tone="(brand|success)"/)
    expect(source).not.toMatch(/animate-\[hd-spin_/)
  }
})

it('keeps the light work register compact and its grouped body visibly nested', () => {
  // Items and the step group keep one rhythm: both compose `TurnItem`.
  expect(itemsTsx).toContain('<TurnItem register={register} className={styles.item}>')
  // The step group composes the same rhythm the design system owns
  // (`TurnItem`, whose drawing is pinned in its own test), and its body only
  // places the items: it reaches into none of them.
  expect(stepGroupTsx).toContain('<TurnItem register={register}')
  expect(stepGroupTsx).not.toContain('py-(--hd-space')
  expect(stepGroupTsx).not.toContain('[&>div]')
  expect(stepGroupTsx).not.toContain('styles.groupBody')
  expect(itemsCss).not.toMatch(/\.groupBody\s*\{\s*\}/)
})

it('draws every attached image through one picture part: a lone one capped, several filling their tiles', () => {
  // The lone-image cap is `--hd-image-max-height`, owned by
  // `AttachmentMedia`'s `picture`; the screen names the layout, not a size.
  expect(itemsTsx).not.toContain('max-h-[280px]')
  expect(itemsTsx).toContain('variant="picture"')
  expect(itemsTsx).toContain('fill={!singleImage}')
  expect(itemsTsx).not.toContain('imageThumb')
})

it('a skill\'s reach reads On untoned, like Off: health takes no tone (#838)', () => {
  // The sheet has no render rig of its own and the preview does not mount it,
  // so the rendered rules spec cannot see this word; the source can.
  expect(skillSheetTsx).toContain("<Text role=\"meta\">{reach.state === 'reaches' ? 'On' : 'Off'}</Text>")
  expect(skillSheetTsx).not.toMatch(/reaches' \? \{ tone: 'success'/)
})
