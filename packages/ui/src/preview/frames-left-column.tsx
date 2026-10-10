import { LeftColumnBoard } from '../design/explorer/boards-compositions'
import { FRAME } from '../design'
import { useTheme } from '../state/theme'
export const LeftColumnProbe = () => {
  useTheme()
  return <div data-frame-id="frame-wall" data-destination="left-column-probe"
  style={{ width: FRAME.sidebar.width, height: '100vh' }}><LeftColumnBoard /></div>
}
