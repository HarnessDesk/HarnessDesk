import { ComposerStalenessContent } from './composer-staleness-content'
import { ComposerSlotsContent } from './composer-slots-content'
import { useTheme } from '../state/theme'
import { Frame } from './main'

export const ComposerSlotsFrames = () => {
  useTheme()
  return (
  <Frame id="composer-slots" title="Composer — fixed slots">
    <ComposerSlotsContent />
    <ComposerStalenessContent />
  </Frame>
  )
}
