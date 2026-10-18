import { expect, it } from 'vitest'
import cards from './LeadCards.tsx?raw'
import settings from './LeadSettings.tsx?raw'

it.each([['LeadCards', cards], ['LeadSettings', settings]])('%s never imports LeadPage', (_name, source) => {
  expect(source).not.toMatch(/(?:from\s*|\bimport\s*(?:\(\s*)?|\brequire\(\s*)['"](?:[^'"]*\/)?LeadPage(?:\.[jt]sx?)?['"]/)
})

it('keeps the Items renderer outside the design pattern dependency graph', async () => {
  const pattern = await import('../design/patterns/lead-contract.tsx?raw')
  expect(pattern.default).not.toMatch(/components\/Items/)
})

it('keeps user-facing Lead refusals and settings free of card terminology', async () => {
  const { REFUSALS } = await import('./lead-refusals')
  expect(Object.values(REFUSALS).join(' ')).not.toMatch(/\bcard\b/i)
  expect(settings).not.toMatch(/Creates a card/)
})

it('uses one shared composer frame for the session and Lead', async () => {
  const [session, lead] = await Promise.all([import('./Composer.tsx?raw'), import('./LeadPage.tsx?raw')])
  for (const source of [session.default, lead.default]) {
    expect(source).toContain('<ConversationComposerFrame')
    expect(source).not.toContain('<ComposerShell')
  }
})
