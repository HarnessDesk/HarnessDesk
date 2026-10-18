import { expect, it } from 'vitest'
import { runtimeId } from '@harnessdesk/protocol'

import { runtimesSeed } from './signin-fixture'

it('gives every Codex row with a slot the gateway fact a real host sets', () => {
  // The host attaches `gateways: true` to every Codex slot (bootstrap.ts's
  // `slotOf`, spread through host.ts). A Codex row is the primary runtime or an
  // account `slot.agent` names it. Rows with no slot are not Codex rows here.
  const codex = runtimeId('codex')
  const rows = (runtimesSeed().runtimes ?? []).filter(row => row.id === codex || row.slot?.agent === codex)
  const withSlot = rows.filter(row => row.slot)
  expect(withSlot.length).toBeGreaterThan(0)
  for (const row of withSlot) expect(row.slot?.gateways).toBe(true)
})
