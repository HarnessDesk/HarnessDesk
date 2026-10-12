import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { popupContractFindings, scanPopupContracts } from './check-popup-contract.mjs'

test('retired row and content APIs cannot return', () => {
  assert.equal(popupContractFindings('const x = <PopoverOption />', 'screen.tsx').length, 1)
  assert.equal(popupContractFindings('const x = <PopoverContent />', 'screen.tsx').length, 1)
  assert.equal(popupContractFindings('import { PopoverOption as OldRow } from \'../design\'; const x = <OldRow />', 'screen.tsx').length, 1)
})
test('a screen cannot supply menu row markup or popup geometry', () => {
  assert.equal(popupContractFindings('const x = <MenuItem label="Open" onSelect={open} />', 'components/Screen.tsx').length, 0)
  assert.ok(popupContractFindings('const x = <MenuItem className="p-4">Open</MenuItem>', 'components/Screen.tsx').length > 0)
  assert.ok(popupContractFindings('const x = <HoverCardContent bleed />', 'components/Screen.tsx').length > 0)
  assert.ok(popupContractFindings('const x = <InfoCard rows={rows} style={{width: 400}} />', 'components/Screen.tsx').length > 0)
  assert.ok(popupContractFindings('const x = <HoverCardContent><Button>Act</Button></HoverCardContent>', 'components/Screen.tsx').length > 0)
})
test('every checked-in popup consumer follows the contract', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  assert.deepEqual(scanPopupContracts(root), [])
})
