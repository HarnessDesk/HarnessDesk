import { Button } from '../design'
import { useState } from 'react'

import type { AgentItem } from '@harnessdesk/protocol'

import { describeGroup } from '../lib/group-items'
import { ChevronIcon, ToolIcon } from './Icons'
import { ItemView } from './Items'
import styles from './Items.module.css'

/**
 * A collapsed burst of agent steps.
 *
 * Open while the work is happening, so the user can watch; collapsed once it
 * finishes, so scrollback reads as a conversation rather than a log. Only
 * steps the app could merely template end up in here — a step the agent
 * described in its own words stands outside, see `groupItems` — so what
 * folds away is "Read 2 files, searched 1 time", and the count is the whole
 * of what those rows had to say.
 */

export const StepGroup = ({
  items,
  running,
  root,
  register,
}: {
  items: readonly AgentItem[]
  running: boolean
  root?: string
  register?: 'light'
}) => {
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)

  // Follow the run's state until the user expresses a preference: open while
  // it runs, folded the moment it is over. A group mounted mid-run used to
  // stay open for as long as the transcript was, which left the one burst
  // that happened to be on screen when the turn ended standing while every
  // other folded.
  const expanded = pinned ? open : running

  return (
    <div className={`${styles.item} ${register === 'light' ? 'py-(--hd-space-px)' : 'py-(--hd-space-1)'}`}>
      <div className={styles.group}>
        <Button
          type="button"
          variant="quiet" size="row" className={styles.groupHeader}
          aria-expanded={expanded}
          onClick={() => {
            setPinned(true)
            setOpen(!expanded)
          }}
        >
          <ChevronIcon
            className={styles.chevron}
            size={12}
            {...(expanded ? { 'data-open': '' } : {})}
          />
          <ToolIcon size={13} />
          <span className={styles.groupSummary}>{describeGroup(items)}</span>
          {running && <span className="flex-none size-3 rounded-full border-[1.5px] border-(--hd-border-emphasis) border-t-(--hd-accent) animate-[hd-spin_0.7s_linear_infinite]" />}
        </Button>
        {expanded && (
          <div className={`flex flex-col [&>div]:max-w-none [&>div]:py-0 ${register === 'light' ? 'pl-(--hd-space-5) pb-(--hd-space-0-5) border-t-0 gap-(--hd-space-px)' : 'pt-(--hd-space-0-5) px-(--hd-space-2) pb-(--hd-space-2) border-t border-(--hd-border) gap-(--hd-space-1)'}`}>
            {items.map((item) => (
              <ItemView key={item.id} item={item} root={root} register={register} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
