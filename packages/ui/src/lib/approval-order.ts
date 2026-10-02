import type { ApprovalOption } from '@harnessdesk/protocol'

/**
 * Where the two approving answers sit relative to each other.
 *
 * The rest of the app puts the proceeding action rightmost, nearest the thumb.
 * Here that is the plain yes: `approveAlways` says yes *and* stops asking, so
 * it changes what happens the next time too, and an answer with a tail should
 * not get the easiest target on the row. The runtime's own order still decides
 * the shortcut numbers — this only decides which one your hand lands on.
 */
const approvingLast = (a: ApprovalOption, b: ApprovalOption): number =>
  (a.intent === 'approveAlways' ? 0 : 1) - (b.intent === 'approveAlways' ? 0 : 1)

/** The order a permission card draws an agent's choices: its refusals first, then its approvals, the plain yes last. */
export const approvalChoiceOrder = (options: readonly ApprovalOption[]): ApprovalOption[] => [
  ...options.filter((option) => option.intent === 'deny' || option.intent === 'cancel'),
  ...options
    .filter((option) => option.intent === 'approve' || option.intent === 'approveAlways')
    .sort(approvingLast),
]
