import { forwardRef, useLayoutEffect, useState, type ReactNode } from 'react'

import { Button } from '../ui/button'
import {
  Dialog,
  DialogOverlay,
  DialogPopup,
  DialogPortal,
  DialogTitle,
  DialogViewport,
} from '../ui/dialog'
import styles from './ApprovalDialog.module.css'

export type ApprovalDialogAction = {
  id: string
  label: string
  description?: string
  icon?: ReactNode
  shortcut: number
  placement: 'safe' | 'proceed'
  tone?: 'default' | 'destructive'
  onSelect: () => void
}

/**
 * The pane-local approval surface. Base UI owns focus containment, Escape,
 * dismissal semantics, and screen-reader dialog behavior; this pattern keeps
 * the safety policy explicit and keeps the portal inside its conversation.
 */
export const ApprovalDialog = forwardRef<HTMLDivElement, {
  title: string
  icon: ReactNode
  queue?: string
  focused: boolean
  focusKey: string
  actions: readonly ApprovalDialogAction[]
  children: ReactNode
}>(({
  title,
  icon,
  queue,
  focused,
  focusKey,
  actions,
  children,
}, forwardedRef) => {
  const [portalHost, setPortalHost] = useState<HTMLDivElement | null>(null)
  const [surface, setSurface] = useState<HTMLDivElement | null>(null)
  const safe = actions.filter((action) => action.placement === 'safe')
  const proceed = actions.filter((action) => action.placement === 'proceed')

  useLayoutEffect(() => {
    if (!focused || !surface) return
    const returnTo = document.activeElement as HTMLElement | null
    surface.focus()
    return () => returnTo?.focus?.()
  }, [focused, focusKey, surface])

  return (
    <div
      ref={(node) => {
        setPortalHost(node)
        if (typeof forwardedRef === 'function') forwardedRef(node)
        else if (forwardedRef) forwardedRef.current = node
      }}
      className={styles.scope}
      data-slot="approval-dialog-scope"
    >
      <Dialog
        open
        modal={false}
        disablePointerDismissal
        onOpenChange={(open, details) => {
          if (open) return
          if (details.reason === 'escape-key') {
            details.cancel()
            details.allowPropagation()
          }
        }}
      >
        {portalHost ? <DialogPortal container={portalHost} className={styles.portal}>
          <DialogOverlay className={styles.backdrop} />
          <DialogViewport className={styles.viewport}>
            <DialogPopup
              ref={setSurface}
              className={styles.dialog}
              initialFocus={false}
              finalFocus={false}
              aria-describedby={undefined}
              tabIndex={-1}
            >
              <div className={styles.header}>
                <span className={styles.icon}>{icon}</span>
                <DialogTitle className={styles.title}>{title}</DialogTitle>
                {queue ? <span className={styles.queue}>{queue}</span> : null}
              </div>
              <div className={styles.body}>{children}</div>
              <div className={styles.footer}>
                {safe.map((action) => (
                  <Action key={action.id} action={action} />
                ))}
                <span className={styles.spacer} />
                {proceed.map((action) => (
                  <Action key={action.id} action={action} />
                ))}
              </div>
            </DialogPopup>
          </DialogViewport>
        </DialogPortal> : null}
      </Dialog>
    </div>
  )
})
ApprovalDialog.displayName = 'ApprovalDialog'

const Action = ({ action }: { action: ApprovalDialogAction }) => (
  <Button
    className={styles.action}
    variant={action.tone === 'destructive' ? 'destructive' : action.placement === 'proceed' ? 'default' : 'secondary'}
    onClick={action.onSelect}
    title={action.description}
  >
    {action.icon}
    {action.label}
    <span className={styles.shortcut}>{action.shortcut}</span>
  </Button>
)
