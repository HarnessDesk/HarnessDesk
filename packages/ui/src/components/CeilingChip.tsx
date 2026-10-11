import type { SeatCeiling } from '@harnessdesk/protocol'

import { Chip } from '../design'
import { seatCeilingWords } from '../lib/agents'
import { ceilingTitle, ceilingTone } from '../lib/ceilings'

/** A seat's ceiling and whether its runtime holds it, drawn one way everywhere. */
export const CeilingChip = ({ ceiling, note, showHold = true }: { readonly ceiling: SeatCeiling; readonly note?: string | null; readonly showHold?: boolean }) => (
  <span
    className="inline-flex flex-none"
    title={ceilingTitle(ceiling, note)}
    data-ceiling={ceiling.level}
    data-hold={ceiling.hold}
  >
    <Chip
      tone={ceilingTone()}
      variant={!showHold && ceiling.hold === 'asked' ? 'outline' : 'default'}
    >{seatCeilingWords(showHold ? ceiling : { ...ceiling, hold: 'held' })}</Chip>
  </span>
)
