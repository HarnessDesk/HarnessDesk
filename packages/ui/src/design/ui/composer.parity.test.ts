import { expect, it } from 'vitest'

import composerCss from '../../components/Composer.module.css?raw'
import conversationComposer from '../../components/Composer.tsx?raw'
import composerSystem from './composer.tsx?raw'

/**
 * The conversation and room composers share one presentation implementation.
 * The feature owns draft and transport behavior; the design component owns
 * every visible role around it.
 */

it('the conversation composer composes every shared composer role', () => {
  for (const role of [
    'ComposerDock',
    'ComposerShell',
    'ComposerText',
    'ComposerTools',
    'ComposerGap',
    'ComposerSend',
    'ComposerChip',
    'ComposerChips',
  ]) {
    expect(conversationComposer).toContain(`<${role}`)
  }
})

it('the feature stylesheet keeps only placement and truncation', () => {
  for (const property of [
    'background:',
    'border:',
    'border-radius:',
    'box-shadow:',
    'color:',
    'font-family:',
    'font-size:',
    'font-weight:',
    'padding:',
  ]) {
    expect(composerCss).not.toContain(property)
  }
})

it('the shared shell owns its resting and focused surface', () => {
  for (const utility of [
    'rounded-(--hd-radius-lg)',
    'bg-(--hd-card)',
    'shadow-(--hd-shadow-xs)',
    'ring-(--hd-border-emphasis)',
    'focus-within:shadow-[var(--hd-composer-ring,0_0_0_0_transparent),var(--hd-shadow-raised)]',
    'focus-within:ring-(--hd-border-heavy)',
  ]) {
    expect(composerSystem).toContain(utility)
  }
})

it('the shared text and send roles keep the canonical measures', () => {
  for (const utility of [
    'leading-(--hd-composer-line)',
    'min-h-(--hd-composer-min)',
    'max-h-(--hd-composer-max)',
    'size-7.5',
    'rounded-full',
    'bg-(--hd-solid)',
    'text-(--hd-solid-foreground)',
  ]) {
    expect(composerSystem).toContain(utility)
  }
})
