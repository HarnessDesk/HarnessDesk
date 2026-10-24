import { useRef } from 'react'
import { ApprovalDialog, type ApprovalDialogAction } from '../design'
import { AlertIcon } from './Icons'
import { useApprovalKeys } from './use-approval-keys'

/** Lead decisions use the session's docked approval surface and keyboard policy. */
export const LeadDecision = ({ id, type, title, pending, onApprove, onDecline, approveLabel = 'Approve', link, focusRef, detail }: {
  readonly detail?: string
  readonly id: string; readonly type?: string; readonly title: string; readonly pending: boolean
  readonly onApprove?: () => void; readonly onDecline?: () => void; readonly approveLabel?: 'Approve' | 'Accept' | 'Reclaim branch'
  readonly link?: { readonly label: string; readonly run: () => void }
  readonly focusRef?: (node: HTMLElement | null) => void
}) => {
  const scope = useRef<HTMLDivElement>(null), typedThrough = useRef(0), deliberateUntil = useRef(0)
  const actions: ApprovalDialogAction[] = [
    ...(link ? [{ id: 'open', label: link.label, shortcut: 1, placement: 'safe' as const, onSelect: link.run }] : []),
    ...(onDecline ? [{ id: 'decline', label: 'Decline', shortcut: link ? 2 : 1, placement: 'safe' as const, disabled: pending, pending, onSelect: onDecline }] : []),
    ...(onApprove ? [{ id: 'approve', label: approveLabel, shortcut: link ? 3 : 2, placement: 'proceed' as const, disabled: pending, pending, onSelect: onApprove }] : []),
  ]
  useApprovalKeys(scope, true, true, actions, pending ? undefined : onDecline, typedThrough)
  return <div onFocusCapture={event => {
    if ((event.target as HTMLElement).dataset.slot === 'approval-card' && Date.now() >= deliberateUntil.current) typedThrough.current = Date.now() + 500
    deliberateUntil.current = 0
  }} onPointerDownCapture={() => { deliberateUntil.current = Date.now() + 500; typedThrough.current = 0 }} data-lead-decision={id} data-lead-decision-type={type}><ApprovalDialog ref={node => { scope.current = node; focusRef?.(node) }} title={title} icon={<AlertIcon />} focused={false} focusKey={id} placement="docked" actions={actions}>{detail ?? null}</ApprovalDialog></div>
}
