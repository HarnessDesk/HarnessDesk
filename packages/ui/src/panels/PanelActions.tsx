import { CaretIcon, CrossIcon, ExpandIcon, PanelIcon, RestoreIcon } from '../components/Icons'
import { Menu, MenuItem, MenuLabel } from '../components/Menu'
import { Popover } from '../components/Popover'
import { useMountControls } from './mount'
import { useViewTitle } from './views'
import { AREA_NAME } from '../state/workbench'
import styles from './PanelActions.module.css'

/**
 * What can be done to a panel: split it, move it, give it the room, put it
 * away.
 *
 * One component, because the group appears in two places and they must not
 * drift. Usually it sits in the strip above the view, beside the tabs. But a
 * view that draws a header of its own and is alone in its stack has no strip —
 * the browser's tab row *is* its header — so the group moves into that header
 * instead, and the panel draws nothing.
 *
 * That rule is why this is a component rather than markup inside the strip. It
 * was markup inside the strip once, and then the browser showed a tab row above
 * its tab row, with expand and close in both of them.
 */

export const PanelActions = ({ where = 'view' }: { where?: 'strip' | 'view' }) => {
  const panel = useMountControls()
  const titleOf = useViewTitle()
  if (!panel) return null
  const { area, view, zoom, zoomScope, chrome } = panel
  /* Tabs exist only in a docked stack that is drawing a strip; the main area
     never has them, and a lone self-framing view has none either. */
  const hasTabs = area !== 'main' && chrome === 'panel'
  /*
   * Drawn in a view's own header only when the mount says the chrome is that
   * view's. Deciding it here rather than at each call site is deliberate: a
   * view author drops this in and is done, and there is no third place to
   * forget the check — which is how the browser ended up with two expand
   * buttons in the first place.
   */
  if (where === 'view' && chrome !== 'own') return null

  return (
    <>
      <SplitAndMoveMenu />
      {/*
        * Going in, the scope is the mount's: a dock takes the content area and
        * the main area takes the window, because the main area already *is*
        * the content area. Asking for `content` from the middle of the window
        * was a press that changed nothing at all — see `zoomScope` in
        * `mount.tsx`.
        *
        * Coming out, the scope is **whatever is actually held**, and those are
        * not always the same one. `zoomArea` reads a press as "leave" only
        * when the scope matches what it is holding, and a layout saved before
        * this change restores `{ area: 'main', scope: 'content' }` — the scope
        * the middle can no longer ask for. Pressing the mount's scope there
        * widened `content` to `window` and stayed zoomed, under a button
        * labelled "Back to the layout". Every existing user takes that upgrade
        * path exactly once, which is the worst kind of bug to leave in: it
        * only happens to people who already had the app open.
        */}
      <PanelButton
        label={
          zoom
            ? 'Back to the layout'
            : zoomScope === 'window'
              ? 'Fill the window'
              : 'Give this panel the whole area'
        }
        onClick={() => panel.setZoom(zoom ?? zoomScope)}
      >
        {zoom ? <RestoreIcon size={14} /> : <ExpandIcon size={14} />}
      </PanelButton>
      {/*
        * Close belongs here whenever no tab is carrying it.
        *
        * A docked stack draws a ✕ on every tab, so a second one in the corner
        * would mean the same thing twice. Everywhere else there is no tab at
        * all — a view alone in its panel, or any view in the main area, whose
        * strip is a title and these verbs — and without this there is no way
        * to close it. That was the report: drag a panel to the middle and it
        * cannot be got rid of.
        */}
      {!hasTabs && panel.canClose && (
        <PanelButton label={`Close ${titleOf(view)}`} onClick={panel.close}>
          <CrossIcon size={14} />
        </PanelButton>
      )}
      {area !== 'main' && (
        <PanelButton
          label={
            area === 'right'
              ? 'Hide this panel'
              : panel.collapsed
                ? 'Show this panel'
                : 'Collapse to the tabs'
          }
          onClick={panel.toggleCollapse}
        >
          <span className={styles.caret} data-collapsed={panel.collapsed ? '' : undefined}>
            <CaretIcon size={14} />
          </span>
        </PanelButton>
      )}
    </>
  )
}

/**
 * Where a panel can go, and how it can be divided.
 *
 * Both are built from the view's own declaration, so a destination that would
 * be refused is never offered and a split is only proposed when there is
 * something to split off.
 */
const SplitAndMoveMenu = () => {
  const panel = useMountControls()
  const titleOf = useViewTitle()
  if (!panel) return null
  const { view, destinations, splittable } = panel
  if (destinations.length === 0 && !splittable) return null
  return (
    <Popover
      /* Not the ⋯ every overflow menu uses: this one sits beside the view's
         own ⋯ in a header the view drew, and two identical glyphs an inch
         apart are one menu the reader cannot parse. A panel glyph also says
         what the menu is about — where this thing sits — rather than just
         "there is more". */
      label={<PanelIcon size={14} />}
      title={`Move or split ${titleOf(view)}`}
      triggerClassName={styles.action}
      align="right"
    >
      {(close) => (
        <Menu close={close}>
          {splittable && (
            <>
              {/* The direction belongs to the split rather than to the area,
                  which is why both are offered here and neither is a setting. */}
              <MenuLabel>Split this panel</MenuLabel>
              <MenuItem
                label="Side by side"
                onSelect={() => {
                  panel.split('row')
                  close()
                }}
              />
              <MenuItem
                label="One above the other"
                onSelect={() => {
                  panel.split('column')
                  close()
                }}
              />
            </>
          )}
          {destinations.length > 0 && (
            <>
              <MenuLabel>Move this panel</MenuLabel>
              {destinations.map((area) => (
                <MenuItem
                  key={area}
                  label={`To ${AREA_NAME[area]}`}
                  onSelect={() => {
                    panel.moveTo(area)
                    close()
                  }}
                />
              ))}
            </>
          )}
        </Menu>
      )}
    </Popover>
  )
}

const PanelButton = ({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) => (
  <button type="button" className={styles.action} onClick={onClick} title={label} aria-label={label}>
    {children}
  </button>
)
