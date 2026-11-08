import { expect, it } from 'vitest'
import { approvalChoiceOrder } from './approval-order'
import type { ApprovalOption } from '@harnessdesk/protocol'
it('a one-off alternative stays before the primary approval without being a standing grant', () => {
  const options: ApprovalOption[] = [{ id: 'allow', label: 'Push through HarnessDesk', intent: 'approve' }, { id: 'own', label: 'Let it use its own git', intent: 'alternative' }, { id: 'refuse', label: "Don't push", intent: 'deny' }]
  expect(approvalChoiceOrder(options).map(option => option.id)).toEqual(['refuse', 'own', 'allow'])
  expect(options[1]?.intent).not.toBe('approveAlways')
})
