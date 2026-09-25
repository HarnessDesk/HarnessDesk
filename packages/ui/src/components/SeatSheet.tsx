import type { SeatFix } from '@harnessdesk/protocol'

import { fixWords, leftWords, markFor, reasonWords } from '../lib/agents'
import { useSnapshot } from '../state/context'
import type { SeatRefusal } from '../state/store'
import { RuntimeMark } from './BrandIcons'
import { BriefIcon } from './Icons'
import { Button, Dialog, Fieldset, Row, Rows } from '../design'

/**
 * The refusal sheet: an Agent that could not be seated here, and nothing
 * opened — or, on the rarer path, a seat that opened and was then closed,
 * shown with what it left behind.
 *
 * A list with a fix on every line — every candidate in the order the Agent
 * asked for them, the reason each was passed over, and the one thing that
 * removes it — because a refusal a person cannot act on is a dead end with
 * better manners. Beneath it, *Edit seats for this Mac*, the fix when every
 * candidate is wrong for this machine.
 */
export const SeatSheet = ({
  refusal,
  onClose,
  onFix,
}: {
  readonly refusal: SeatRefusal
  readonly onClose: () => void
  readonly onFix: (fix: SeatFix) => void
}) => {
  const snapshot = useSnapshot()
  return (
    <Dialog
      title={`${refusal.name} can’t be seated here`}
      icon={<BriefIcon size={15} />}
      size="sm"
      onClose={onClose}
      footer={
        /* The proceeding action first; the footer paints it rightmost. */
        <>
          <Button variant="default" onClick={() => onFix({ kind: 'seats' })}>
            Edit seats for this Mac
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <Fieldset
        legend={
          refusal.opened
            ? 'It was not started — every seat it tried is shown below, with what each left behind.'
            : refusal.blocked
              ? 'Nothing was opened. It could not be weighed at all:'
              : 'Nothing was opened. Each seat it would take, in its order, and what stands in the way:'
        }
      >
        <Rows>
          {refusal.blocked && <Row title={refusal.blocked} />}
          {!refusal.blocked && refusal.candidates.length === 0 && (
            <Row title="It names no seat to try" desc="Add a seat for this Mac, or name one in its file." />
          )}
          {refusal.candidates.map((candidate, index) => {
            const why = [
              candidate.reason ? reasonWords(candidate.reason, candidate.runtimeName) : 'Not reached',
              candidate.left ? leftWords(candidate.left, candidate.runtimeName) : null,
            ]
              .filter((part): part is string => part !== null)
              .join('. ')
            const fix = candidate.fix
            return (
              <Row
                key={`${index}-${candidate.label}`}
                mark={<RuntimeMark runtime={markFor(candidate, snapshot.runtimes)} size={16} />}
                title={candidate.label}
                desc={why}
                {...(fix
                  ? {
                      control: (
                        <Button size="sm" variant="outline" onClick={() => onFix(fix)}>
                          {fixWords(fix, candidate.runtimeName)}
                        </Button>
                      ),
                    }
                  : {})}
              />
            )
          })}
        </Rows>
      </Fieldset>
    </Dialog>
  )
}
