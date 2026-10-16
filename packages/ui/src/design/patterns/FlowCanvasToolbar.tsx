import type { ReactNode } from 'react'
import styles from './FlowCanvasToolbar.module.css'

/** Flow controls float inside a positioned canvas: editing and view tools at left, Run actions at right. */
export const FlowCanvasToolbar = ({ children, actions }: { readonly children: ReactNode; readonly actions?: ReactNode }) =>
  <div data-slot="flow-canvas-toolbar" className={styles.toolbar}>
    <div role="group" aria-label="Flow tools" className={styles.tools}>{children}</div>
    {actions && <div role="group" aria-label="Flow actions" className={`${styles.tools} ${styles.actions}`}>{actions}</div>}
  </div>
