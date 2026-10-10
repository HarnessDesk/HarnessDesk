import { Button } from '../design'
import { CrossIcon, ExpandIcon, RestoreIcon } from '../components/Icons'
import { useMountControls } from './mount'
import { useViewTitle } from './views'

/** Work-level Fill and close survive the retirement of dock arrangement controls. */
export const MainWorkActions = () => {
  const panel = useMountControls(), titleOf = useViewTitle()
  if (!panel || panel.area !== 'main') return null
  return <>
    <Button variant="ghost" size="icon-sm" {...(!panel.canClose ? { edge: 'end' as const, edgeGlyph: 14 } : {})} aria-label={panel.zoom ? 'Back to the layout' : 'Fill the window'}
      title={panel.zoom ? 'Back to the layout' : 'Fill the window'} onClick={() => panel.setZoom(panel.zoom ?? panel.zoomScope)}>
      {panel.zoom ? <RestoreIcon size={14} /> : <ExpandIcon size={14} />}
    </Button>
    {panel.canClose && <Button variant="ghost" size="icon-sm" edge="end" edgeGlyph={14} aria-label={`Close ${titleOf(panel.view)}`} title={`Close ${titleOf(panel.view)}`} onClick={panel.close}><CrossIcon size={14} /></Button>}
  </>
}
