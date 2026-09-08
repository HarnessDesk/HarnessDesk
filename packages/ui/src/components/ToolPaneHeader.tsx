import type { ReactNode } from 'react'

import { useMountControls } from '../panels/mount'
import { PanelActions } from '../panels/PanelActions'
import styles from './ToolPanes.module.css'

/**
 * Text pinned to left-to-right inside a right-to-left box. The pane subtitles
 * ellipsise from the front by running the box RTL; without these marks the
 * bidi algorithm treats a leading slash as part of the RTL flow and shows
 * "/Users/x/app" as "Users/x/app/".
 */
export const ltr = (text: string): string => `\u200e${text}\u200e`

/**
 * The strip above a tool: what it shows, where, and the controls that act on
 * the panel holding it.
 *
 * Those controls used to be wired straight to `layout.expanded` and
 * `closePane`, which meant this header only worked inside the split tree — and
 * so every tool that wore it could only ever be a pane. They ask the mount
 * now, so the same header draws the right thing in a pane, in the right panel
 * and in the bottom panel, and the tool underneath it is unchanged in all
 * three. Outside the panel system there is no mount and no furniture, which is
 * how these render in the design explorer and on the preview page.
 */
export const ToolPaneHeader = ({
  title,
  lead,
  subtitle,
  hint,
  children,
}: {
  title: string
  /**
   * Shown in the title's place when a pane has something better to put
   * there — the browser's tab strip. `title` stays as the row's label, so
   * the header is still named for a screen reader.
   */
  lead?: ReactNode
  subtitle?: string
  hint?: string
  children?: ReactNode
}) => {
  const panel = useMountControls()
  return (
    <header className={`${styles.header} hd-drag`} title={hint} aria-label={title}>
      {/* A lead is interactive — the browser's tab strip — so it needs the
          same real no-drag box the controls on the right get, for the same
          reason: inside the drag rect a click moves the window. A plain
          title needs no such thing, and gets none. */}
      {lead ? <div className={`${styles.lead} hd-no-drag`}>{lead}</div> : <span className={styles.title}>{title}</span>}
      {subtitle && (
        <span className={styles.subtitle} title={subtitle}>
          {ltr(subtitle)}
        </span>
      )}
      <span style={{ flex: 1 }} />
      {/* A real box, not `display: contents`: app-region is a property of a
          box, and a boxless wrapper leaves its buttons inside the drag region,
          where a click moves the window instead of pressing them. */}
      <div className="hd-no-drag" style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        {children}
        {/* The panel's verbs, drawn here only when this view is the whole
            panel: a browser alone in its stack has no strip above it, so its
            own header is where "expand", "move" and "close" have to live.
            Sharing a stack, the strip carries them and this draws nothing —
            which is the difference between one row of controls and two.

            The rule keeps them one row; the divider keeps them two *groups*.
            Without it a browser's own ⋯ sits against the panel's ⋯ — same
            glyph, different subject, and nothing saying which is which. */}
        {panel?.chrome === 'own' && children != null && <span className={styles.headerDivider} />}
        <PanelActions />
      </div>
    </header>
  )
}
