import type { ReactNode } from 'react'
import styles from './FlowCanvasToolbar.module.css'

/** Flow controls float inside a positioned canvas: editing and view tools at left, Run actions at right. */
export const FlowCanvasToolbar = ({ children, actions, placement = 'floating' }: { readonly children: ReactNode; readonly actions?: ReactNode; readonly placement?: 'floating' | 'bar' }) =>
  <div data-slot="flow-canvas-toolbar" data-placement={placement} className={styles.toolbar}>
    <div role="group" aria-label="Flow tools" className={styles.tools}>{children}</div>
    {actions && <div role="group" aria-label="Flow actions" className={`${styles.tools} ${styles.actions}`}>{actions}</div>}
  </div>
