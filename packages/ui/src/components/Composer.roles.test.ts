import { expect, it } from 'vitest'

import frameSource from '../design/patterns/ConversationShell.tsx?raw'
import composerSource from './Composer.tsx?raw'

it('builds the conversation composer from the shared composer shell', () => {
  expect(composerSource).toContain('<ConversationComposerFrame')
  expect(frameSource).toContain('<ComposerShell reading')
  expect(frameSource).toContain('<ComposerDock>')
})
