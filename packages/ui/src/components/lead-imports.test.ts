import { expect, it } from 'vitest'
import cards from './LeadCards.tsx?raw'
import settings from './LeadSettings.tsx?raw'

it.each([['LeadCards', cards], ['LeadSettings', settings]])('%s never imports LeadPage', (_name, source) => {
  expect(source).not.toMatch(/(?:from\s*|\bimport\s*(?:\(\s*)?|\brequire\(\s*)['"](?:[^'"]*\/)?LeadPage(?:\.[jt]sx?)?['"]/)
})
