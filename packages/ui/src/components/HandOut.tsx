import { useMemo, useState } from 'react'

import type { Intent, RuntimeId, SessionId, TeamPeerInfo } from '@harnessdesk/protocol'

import { Btn, Dialog, Textarea } from '../design'
import { useStore } from '../state/context'
import styles from './HandOut.module.css'

/**
 * The open cards handed to the idle members, one each, in one action.
 *
 * A room of 138 conversations each given its own page was, before this, 138
 * posts typed or scripted one at a time: 138 round trips, 138 board writes,
 * 138 rows in the channel and ten seconds of the channel filling up. The
 * pairing here is the obvious one — open cards in board order, idle members
 * in rail order, one each — and the message is one template whose slots the
 * host fills per member. Cards past the last idle member stay open; members
 * past the last card are left alone. What each member will read is shown
 * before anything is sent, because a template is easy to get wrong and a
 * hundred copies of a wrong sentence are a hundred wrong turns.
 */
export const SLOTS = ['card', 'title', 'detail', 'files', 'member'] as const

export const DEFAULT_TEMPLATE =
  'Take card #{{card}} — {{title}}.\n{{detail}}\n' +
  'Claim it with claim_work (intent {{card}}), do the work, and complete it with complete_claim when it is done. ' +
  'Then call claim_next and do that card too; keep going until it says nothing is left. ' +
  'Reply here with what you did, in three lines.'

export const fill = (template: string, vars: Readonly<Record<string, string>>): string =>
  template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  )

/**
 * By name first, then in order.
 *
 * A member is often named after its job — a conversation titled `/about`
 * in a room whose cards say "Audit /about" — and it should get that card
 * and not whichever one is next in line. The desk knows both lists and does
 * the matching itself, exactly, rather than asking a hundred members to
 * find their own name in a hundred cards: that was a hundred tool calls and
 * a race on the first card. A member whose name matches nothing takes the
 * next unmatched card in board order.
 */
const mentions = (card: Intent, name: string): boolean => {
  const needle = name.trim().toLowerCase()
  if (needle === '') return false
  const hay = `${card.title}\n${card.detail ?? ''}\n${card.files.join('\n')}`.toLowerCase()
  const at = hay.indexOf(needle)
  if (at < 0) return false
  // A whole word, not a prefix: `/admin` must not take `/admin/blog`.
  const after = hay[at + needle.length]
  return after === undefined || !/[A-Za-z0-9_-]/.test(after) && after !== '/'
}

export const pairUp = (
  intents: readonly Intent[],
  peers: readonly TeamPeerInfo[],
): readonly { readonly card: Intent; readonly member: TeamPeerInfo; readonly byName: boolean }[] => {
  const open = intents.filter((one) => one.state === 'open' && !one.claim)
  const idle = peers.filter((one) => !one.busy)
  const taken = new Set<number>()
  const byName = new Map<string, Intent>()
  for (const member of idle) {
    const name = member.title ?? ''
    const card = name ? open.find((one) => !taken.has(one.id) && mentions(one, name)) : undefined
    if (card) {
      taken.add(card.id)
      byName.set(`${member.runtime}\u0000${member.sessionId}`, card)
    }
  }
  const rest = open.filter((one) => !taken.has(one.id))
  let next = 0
  const pairs: { card: Intent; member: TeamPeerInfo; byName: boolean }[] = []
  for (const member of idle) {
    const named = byName.get(`${member.runtime}\u0000${member.sessionId}`)
    if (named) {
      pairs.push({ card: named, member, byName: true })
      continue
    }
    const card = rest[next]
    if (!card) continue
    next += 1
    pairs.push({ card, member, byName: false })
  }
  return pairs
}

export const varsFor = (card: Intent, member: TeamPeerInfo): Record<string, string> => ({
  card: String(card.id),
  title: card.title,
  detail: card.detail ?? '',
  files: card.files.join(', '),
  member: member.nickname,
})

export const HandOut = ({
  room,
  intents,
  peers,
  onClose,
  onTrouble,
}: {
  readonly room: string
  readonly intents: readonly Intent[]
  readonly peers: readonly TeamPeerInfo[]
  readonly onClose: () => void
  readonly onTrouble: (message: string | null) => void
}) => {
  const store = useStore()
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const pairs = useMemo(() => pairUp(intents, peers), [intents, peers])
  const openCards = intents.filter((one) => one.state === 'open' && !one.claim).length
  const idle = peers.filter((one) => !one.busy).length
  const first = pairs[0]
  const preview = first ? fill(template, varsFor(first.card, first.member)) : ''

  const send = async (): Promise<void> => {
    if (pairs.length === 0 || busy) return
    setBusy(true)
    setProblem(null)
    try {
      const tally = await store.teamHandout(
        room,
        template,
        pairs.map(({ card, member }) => ({
          runtime: member.runtime as RuntimeId,
          sessionId: member.sessionId as SessionId,
          vars: varsFor(card, member),
        })),
      )
      onTrouble(
        tally.refused > 0
          ? `${tally.refused} of ${pairs.length} could not be handed out; the channel says which.`
          : null,
      )
      onClose()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Hand out the open cards"
      size="md"
      onClose={onClose}
      footer={
        <>
          <Btn variant="primary" disabled={busy || pairs.length === 0 || template.trim() === ''} onClick={() => void send()}>
            {busy ? 'Handing out…' : `Hand out ${pairs.length} ${pairs.length === 1 ? 'card' : 'cards'}`}
          </Btn>
          <Btn disabled={busy} onClick={onClose}>
            Cancel
          </Btn>
        </>
      }
    >
      <div className={styles.body}>
        <p className={styles.hint} data-slot="handout-pairing">
          {pairs.length === 0
            ? openCards === 0
              ? 'Nothing is open on the board.'
              : 'Nobody in the room is idle right now.'
            : `${pairs.length} open ${pairs.length === 1 ? 'card' : 'cards'} to ${pairs.length} idle ${pairs.length === 1 ? 'member' : 'members'}, one each` +
              (pairs.some((one) => one.byName) ? ` (${pairs.filter((one) => one.byName).length} matched by name)` : '') +
              (openCards > pairs.length ? `; ${openCards - pairs.length} more ${openCards - pairs.length === 1 ? 'card stays' : 'cards stay'} open` : '') +
              (idle > pairs.length ? `; ${idle - pairs.length} ${idle - pairs.length === 1 ? 'member gets' : 'members get'} nothing` : '') +
              '.'}
        </p>

        <label className={styles.field}>
          <span className={styles.label}>What every member is told</span>
          <Textarea
            aria-label="What every member is told"
            className={styles.area}
            rows={7}
            value={template}
            onChange={(event) => setTemplate(event.target.value)}
          />
          <span className={styles.hint}>
            Slots the host fills per member: {SLOTS.map((slot) => `{{${slot}}}`).join(' · ')}
          </span>
        </label>

        {first && (
          <div className={styles.field}>
            <span className={styles.label}>
              What {first.member.nickname} will read, for card #{first.card.id}
            </span>
            <pre className={styles.preview} data-slot="handout-preview">
              {preview}
            </pre>
          </div>
        )}

        {problem && (
          <p className={styles.problem} role="alert">
            {problem}
          </p>
        )}
      </div>
    </Dialog>
  )
}
