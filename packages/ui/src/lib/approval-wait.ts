import type { AgentItem, Approval, SessionKey, TurnId } from '@harnessdesk/protocol'

/** Approval ownership is runtime-qualified for every adapter's request shape. */
export const waitsForApproval = (
  approvals: readonly { key: SessionKey; approval: Approval }[],
  key: SessionKey | null,
  items: readonly Pick<AgentItem, 'id'>[],
  turn?: TurnId,
): boolean => key !== null && approvals.some(({ key: owner, approval }) => owner === key
  && ((turn !== undefined && approval.turnId === turn) || items.some(item => item.id === approval.itemId)))
