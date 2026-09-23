import { useCallback, useEffect, useRef, useState } from 'react'

import type { FlowUpdatePreview, FlowUpdateResult } from '@harnessdesk/protocol'

import { Banner, Button, CodeText, Dialog, Note, NoteList } from '../design'
import { wholeTextDiff } from '../lib/diff'
import { useStore } from '../state/context'
import { DiffView } from './Diff'

export interface FlowUpdateProps {
  readonly root: string
  readonly id: string
  readonly mode: 'update' | 'customize'
  readonly onClose: () => void
  readonly onApplied: () => void
}

/**
 * The whole diff before one write: every file Update or Customize would
 * create or replace, in the same idiom `CeilingUpdate` shows its one line in
 * — a design-system `Dialog` and the existing `DiffView`, never a syntax
 * highlighter of our own.
 *
 * Update converts an old project flow in place: its Agents become real
 * files, then the flow file itself is replaced. Customize copies a shipped
 * or your-Mac flow into this project verbatim, no conversion. Either way the
 * preview's token is one-time, so a partial result re-previews for a fresh,
 * journal-bound token before Continue can write again.
 */
export const FlowUpdate = ({ root, id, mode, onClose, onApplied }: FlowUpdateProps) => {
  const store = useStore()
  const [preview, setPreview] = useState<FlowUpdatePreview | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [result, setResult] = useState<FlowUpdateResult | null>(null)
  const [busy, setBusy] = useState(false)
  const writing = useRef(false)

  const load = useCallback((): void => {
    setPreview(null)
    setProblem(null)
    store.previewFlowUpdate(root, id, mode).then(
      (next) => setPreview(next),
      (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
    )
  }, [store, root, id, mode])

  useEffect(() => {
    load()
  }, [load])

  const errors = preview?.problems.filter((one) => one.level === 'error') ?? []
  const canApply = preview !== null && errors.length === 0 && problem === null

  const apply = async (): Promise<void> => {
    if (!preview || !canApply || writing.current) return
    writing.current = true
    setBusy(true)
    try {
      const next = await store.applyFlowUpdate(root, id, preview.token, mode)
      setResult(next)
      if (next.state === 'applied') {
        onApplied()
        onClose()
        return
      }
      // A partial write leaves the used token spent; re-preview against the
      // journal it left, which resumes with a fresh one Continue can spend.
      if (next.state === 'partial') load()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      writing.current = false
      setBusy(false)
    }
  }

  const title = mode === 'update' ? 'Update this flow' : 'Customize this flow'
  const proceedLabel = busy ? 'Writing…' : result?.state === 'partial' ? 'Continue' : mode === 'update' ? 'Write these files' : 'Copy into this project'

  return (
    <Dialog
      title={title}
      size="lg"
      onClose={onClose}
      footer={(
        <>
          <Button variant="default" disabled={busy || !canApply} onClick={() => void apply()}>{proceedLabel}</Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>{result ? 'Close' : 'Cancel'}</Button>
        </>
      )}
    >
      <Note>
        {mode === 'update'
          ? 'This flow is converted to the current format: each Agent it names becomes a real file, then the flow file is replaced in place. Everything written is an ordinary change in this project, and appears in Changes.'
          : 'A copy of this flow is written into this project’s own .harnessdesk/flows, unchanged. It appears in Changes.'}
      </Note>

      {problem && <Banner tone="danger" title="This update cannot be read">{problem}</Banner>}

      {preview && errors.length > 0 && (
        <Banner tone="danger" title="This cannot be applied yet">
          <NoteList>
            {errors.map((one) => (
              <li key={`${one.at}-${one.text}`}>
                <code>{one.at}</code> — {one.text}
              </li>
            ))}
          </NoteList>
        </Banner>
      )}

      {result && result.state !== 'applied' && (
        <Banner tone={result.state === 'partial' ? 'warning' : 'danger'} title={result.state === 'partial' ? 'Partly written' : 'Not applied'}>
          {result.message}
          {result.written.length > 0 && (
            <NoteList>
              {result.written.map((path) => <li key={path}>{path}</li>)}
            </NoteList>
          )}
        </Banner>
      )}

      {preview && !problem && preview.edits.map((edit) => (
        <div key={edit.path} className="flex flex-col gap-(--hd-space-2)">
          <CodeText>{edit.path}</CodeText>
          <DiffView diff={edit.before === null ? edit.after : wholeTextDiff(edit.before, edit.after)} wholeFile={edit.before === null} wrap />
        </div>
      ))}
    </Dialog>
  )
}
