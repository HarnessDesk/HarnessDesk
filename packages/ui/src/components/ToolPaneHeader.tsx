import type { ReactNode } from 'react'

import {
  ToolPaneHeader as SystemToolPaneHeader,
  ToolPaneHeaderDivider,
} from '../design'
import { useMountControls } from '../panels/mount'
import { PanelActions } from '../panels/PanelActions'

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
    <SystemToolPaneHeader
      variant="window"
      corner
      className="hd-drag"
      title={title}
      lead={lead}
      subtitle={subtitle ? ltr(subtitle) : undefined}
      hint={hint ?? subtitle}
      aria-label={title}
      actions={(
        /* A real box, not `display: contents`: app-region is a property of a
           box, and a boxless wrapper leaves its buttons inside the drag region,
           where a click moves the window instead of pressing them. */
        <div className="hd-no-drag flex items-center gap-0.5">
          {children}
          {/* The panel's verbs, drawn here only when this view is the whole
              panel: a browser alone in its stack has no strip above it, so its
              own header is where "expand", "move" and "close" have to live.
              Sharing a stack, the strip carries them and this draws nothing. */}
          {panel?.chrome === 'own' && children != null && <ToolPaneHeaderDivider />}
          <PanelActions />
        </div>
      )}
    />
  )
}
