import { useEffect, useRef, useState } from 'react'

import type { AgentEntry, CeilingLevel, CeilingUpdate as Shown } from '@harnessdesk/protocol'

import { Banner, Button, CodeText, Dialog, Note, RowChoice, Rows } from '../design'
import { updateChoices } from '../lib/ceilings'
import { useStore } from '../state/context'
import { DiffView } from './Diff'

/** Preview and write exactly one Agent ceiling line, from its page. */
export const CeilingUpdate = ({ entry, onClose }: { readonly entry: AgentEntry; readonly onClose: () => void }) => {
  const store = useStore()
  const definition = entry.definition
  const choices = definition ? updateChoices(definition) : []
  const [level, setLevel] = useState<CeilingLevel | null>(choices[0]?.level ?? null)
  const [shown, setShown] = useState<Shown | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const writing = useRef(false)

  useEffect(() => {
    if (level === null) return
    let live = true
    setShown(null)
    setProblem(null)
    store.previewCeiling(entry, level).then(
      (next) => {
        if (live) setShown(next)
      },
      (error: unknown) => {
        if (live) setProblem(error instanceof Error ? error.message : String(error))
      },
    )
    return () => {
      live = false
    }
  }, [entry, level, store])

  if (!definition) return null

  const write = async (): Promise<void> => {
    if (!shown || level === null || writing.current) return
    writing.current = true
    setBusy(true)
    setProblem(null)
    try {
      await store.writeCeiling(entry, level, shown.digest)
      onClose()
    } catch (error) {
      writing.current = false
      setBusy(false)
      setProblem(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <Dialog
      title={`Update ${definition.name}`}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button variant="default" disabled={busy || shown === null} onClick={() => void write()}>
            {busy ? 'Writing…' : 'Write this line'}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <Note>{entry.origin === 'project'
        ? 'An ordinary change in this repository: the git pane shows it, for you to commit with the code.'
        : 'Your own Agent, on this Mac: the change is written to its file and nowhere else.'}</Note>
      <Note>Choose the line its file should say; nothing else in it changes.</Note>
      <Rows role="radiogroup" aria-label="Ceiling line">
        {choices.map((choice) => (
          <RowChoice
            key={choice.level}
            title={choice.label}
            desc={<span className="whitespace-normal">{choice.hint}</span>}
            selected={choice.level === level}
            disabled={busy}
            onClick={() => setLevel(choice.level)}
          />
        ))}
      </Rows>
      {problem && <Banner tone="danger" title="This line cannot be written">{problem}</Banner>}
      {shown && (
        <div className="space-y-2">
          <CodeText>{shown.path}</CodeText>
          <DiffView diff={shown.diff} wrap />
        </div>
      )}
    </Dialog>
  )
}
