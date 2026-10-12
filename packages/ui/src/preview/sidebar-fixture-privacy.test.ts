import { expect, it } from 'vitest'
import { previewAccounts, previewUsage, previewHistory } from './sidebar-fixture'

it('uses the public demo account or example addresses throughout account and usage fixtures', () => {
  const allowed = /^(?:shane@harnessdesk\.app|[^@]+@example\.com|[^@]+@acme\.dev)$/
  for (const status of Object.values(previewAccounts)) {
    for (const account of status.accounts ?? []) {
      if (account.kind === 'oauth') expect(account.email).toMatch(allowed)
    }
  }
  for (const report of previewUsage) if (report.account !== null) expect(report.account).toMatch(allowed)
})

it('uses a neutral task title for the synthetic hand-off research', () => {
  const research = previewHistory.find(session => session.cwd.endsWith('/research-2b41'))
  expect(research?.title).toBe('Research the agent hand-off')
})
