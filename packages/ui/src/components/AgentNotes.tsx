import { useEffect, useState } from 'react'

import type { AgentEntry, AgentNotesView } from '@harnessdesk/protocol'

import { Banner, Button, ConfirmDialog, Row, Rows, SectionHead } from '../design'
import { useStore } from '../state/context'
import { Markdown } from './Markdown'

/**
 * `NOTES.md`, beside this Agent's own file (decisions 17/18) — visible, and
 * clearable, from the Agent page. Rendered through the same sanitizer every
 * other transcript surface uses: this file is committed prose from a
 * repository, untrusted the same way any of it is. Clearing is a deliberate
 * person action naming exactly the file and its Git consequence; it never
 * removes the Agent or any skill beside it, and it never reaches into a Seat
 * already using the notes it read at open.
 */
export const AgentNotes = ({ entry }: { readonly entry: AgentEntry }) => {
  const store = useStore()
  const [view, setView] = useState<AgentNotesView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    setError(null)
    store.readAgentNotes(entry.id, entry.origin).then(
      (next) => { if (live) setView(next) },
      (problem: unknown) => { if (live) setError(problem instanceof Error ? problem.message : String(problem)) },
    )
    return () => { live = false }
  }, [entry.id, entry.origin, store])

  if (error) return <Banner tone="danger" title="Notes could not be read">{error}</Banner>
  if (!view) return null

  return (
    <>
      <SectionHead name="Notes" />
      <Rows>
        {view.text === null ? (
          <Row title="This Agent has no notes." />
        ) : view.problem ? (
          <Row title={view.problem} />
        ) : (
          <Row
            title={view.text.trim() === '' ? 'This Agent’s notes are empty.' : <Markdown text={view.text} document />}
            control={view.writable ? <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>Clear…</Button> : undefined}
          />
        )}
      </Rows>
      {confirming && view.text !== null && view.digest && (
        <ConfirmDialog
          title="Clear this Agent’s notes?"
          confirmLabel="Clear notes"
          tone="destructive"
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setBusy(true)
            void (async () => {
              try {
                const cleared = await store.clearAgentNotes(entry.id, entry.origin, view.digest!)
                setView(cleared)
                setConfirming(false)
              } catch (problem) {
                setError(problem instanceof Error ? problem.message : String(problem))
              } finally {
                setBusy(false)
              }
            })()
          }}
        >
          {view.path} is written empty. Its Git history keeps the removed text; a Seat already carrying these notes keeps its own copy.
        </ConfirmDialog>
      )}
    </>
  )
}
