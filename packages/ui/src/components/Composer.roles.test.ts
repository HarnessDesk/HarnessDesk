import { expect, it } from 'vitest'

import composerSource from './Composer.tsx?raw'

it('builds the conversation composer from the shared composer shell', () => {
  expect(composerSource).toContain('<ComposerShell')
})
