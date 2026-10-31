import { expect, it } from 'vitest'
import { runtimeId } from '@harnessdesk/protocol'

import { runtimesSeed } from './signin-fixture'

it('gives every Codex row the gateway fact a real host sets', () => {
  // The host attaches `gateways: true` to every Codex slot (bootstrap.ts's
  // `slotOf`, spread through host.ts). A Codex row is the primary runtime or an
  // account `slot.agent` names it. The primary row must have a slot too.
  const codex = runtimeId('codex')
  const rows = (runtimesSeed().runtimes ?? []).filter(row => row.id === codex || row.slot?.agent === codex)
  expect(rows.length).toBeGreaterThan(1)
  for (const row of rows) expect(row.slot?.gateways).toBe(true)
})
