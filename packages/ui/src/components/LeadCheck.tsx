import { useEffect, useState } from 'react'
import type { CheckUnseen } from '@harnessdesk/protocol'
import { Banner, Button } from '../design'
import { useSnapshot, useStore } from '../state/context'
import { leadCheckAsk } from './lead-check'
import { RunCheck } from './RunCheck'

/** The project check on the reviewed change is the person's to start. The Lead cannot, so it says so here and the
 * same confirmation the Team board uses shows the exact command first. */
export const LeadCheck = ({ room, needed, revision, label, onError }: {
  readonly room: string; readonly needed: boolean; readonly revision: number; readonly label: string; readonly onError: (error: unknown) => void
}) => {
  const store = useStore(), snapshot = useSnapshot()
  const [asking, setAsking] = useState<{ readonly card: number; readonly unseen: CheckUnseen } | null>(null), [busy, setBusy] = useState(false)
  useEffect(() => { if (needed) void store.loadBoardEvidence(room) }, [store, room, needed, revision])
  const ask = needed ? leadCheckAsk(snapshot.teams.get(room)?.intents ?? [], snapshot.boardEvidence.get(room)) : null
  const run = async (card: number, name: string, answer?: { readonly seen: string; readonly digest: string }) => {
    if (busy) return
    setBusy(true)
    try {
      const result = await store.runCheck(room, card, name, answer)
      if (result.kind === 'unseen') setAsking({ card, unseen: result.unseen })
      else { setAsking(null); await store.loadBoardEvidence(room) }
    } catch (error) { setAsking(null); onError(error) }
    finally { setBusy(false) }
  }
  if (!ask) return null
  return <>
    <Banner actions={<Button disabled={busy} aria-busy={busy} onClick={() => void run(ask.card, ask.name)}>{`Run ${ask.name}`}</Button>}>
      {`The change is reviewed and approved. ${label} is waiting for you to run its project check, ${ask.name}, before the result can be offered.`}
    </Banner>
    {asking && <RunCheck unseen={asking.unseen} card={asking.card} busy={busy} record={false}
      onRun={() => void run(asking.card, asking.unseen.check.name, { seen: asking.unseen.check.run, digest: asking.unseen.digest })} onCancel={() => setAsking(null)} />}
  </>
}
