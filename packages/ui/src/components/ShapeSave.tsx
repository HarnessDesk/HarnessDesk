import { useCallback, useEffect, useRef, useState } from 'react'

import type { AuthoringSaveInput, AuthoringSaveResult, AuthoringSavePreview } from '@harnessdesk/protocol'

import { Banner, Button, Dialog, Field, Input, NoteList, RowChoice, Rows, Text } from '../design'
import { wholeTextDiff } from '../lib/diff'
import { useStore } from '../state/context'
import { DiffView } from './Diff'

/**
 * A shape's save, previewed whole before anything is written: scope (for
 * this project or for this Mac), the file name it lands under, and the exact
 * diff `authoring/save/preview` returns — a dependency refusal (a
 * project-only Agent this scope cannot use) included, in the host's own
 * words, never a silent fallback Agent.
 *
 * `input` is the caller's own starting point — the rendered source, and the
 * target it was read or would be created at. Changing scope or the file name
 * here previews a different target with the same source; it never changes
 * what would be written.
 */
export interface ShapeSaveProps {
  readonly input: AuthoringSaveInput
  readonly onSaved: (result: AuthoringSaveResult) => void
  readonly onClose: () => void
}

const FLOW_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

export const ShapeSave = ({ input, onSaved, onClose }: ShapeSaveProps) => {
  const store = useStore()
  const original = input.target
  const [scope, setScope] = useState<'user' | 'project'>(original.origin)
  const [id, setId] = useState(original.kind === 'triggers' ? '' : original.id)
  const [preview, setPreview] = useState<AuthoringSavePreview | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const sequence = useRef(0)

  const root = original.kind === 'flow' ? original.root : undefined

  const runPreview = useCallback((nextScope: 'user' | 'project', nextId: string): void => {
    const mine = ++sequence.current
    setPreview(null)
    setProblem(null)
    if (!FLOW_ID.test(nextId)) {
      setProblem('Choose a file name: lowercase letters, digits, - and _.')
      return
    }
    const target: AuthoringSaveInput['target'] = original.kind === 'agent'
      ? { kind: 'agent', origin: nextScope, id: nextId, ...(root ? { root } : {}) }
      : { kind: 'flow', origin: nextScope, id: nextId, root: root! }
    const originalId = original.kind === 'triggers' ? null : original.id
    const sameTarget = target.kind === original.kind && target.origin === original.origin && target.id === originalId
    store.previewAuthoringSave({
      target,
      expected: sameTarget ? input.expected : null,
      source: input.source,
      ...(input.agents ? { agents: input.agents } : {}),
    }).then(
      (next) => { if (mine === sequence.current) setPreview(next) },
      (error: unknown) => { if (mine === sequence.current) setProblem(error instanceof Error ? error.message : String(error)) },
    )
  }, [input.agents, input.expected, input.source, original, root, store])

  useEffect(() => {
    runPreview(scope, id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const chooseScope = (next: 'user' | 'project'): void => {
    setScope(next)
    runPreview(next, id)
  }
  const changeId = (next: string): void => {
    setId(next)
    runPreview(scope, next)
  }

  const save = async (): Promise<void> => {
    if (!preview?.token || busy) return
    setBusy(true)
    try {
      const result = await store.applyAuthoringSave(preview.token)
      if (result.state === 'applied') {
        onSaved(result)
        return
      }
      setProblem(result.message)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const canSave = preview !== null && preview.token !== null && !busy

  return (
    <Dialog
      title="Save this shape"
      size="lg"
      onClose={onClose}
      footer={(
        <>
          <Button variant="default" disabled={!canSave} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
        </>
      )}
    >
      {root && (
        <Rows role="radiogroup" aria-label="Where it is saved">
          <RowChoice title="For this project" desc="Committed with the code, for everyone who clones it." selected={scope === 'project'} disabled={busy} onClick={() => chooseScope('project')} />
          <RowChoice title="For you" desc="On this Mac only." selected={scope === 'user'} disabled={busy} onClick={() => chooseScope('user')} />
        </Rows>
      )}
      <Field label="File name" hint="Lowercase letters, digits, - and _.">
        {(control) => <Input {...control} disabled={busy} value={id} onChange={(event) => changeId(event.target.value)} />}
      </Field>

      {problem && <Banner tone="danger" title="This could not be saved">{problem}</Banner>}

      {preview && preview.issues.length > 0 && (
        <Banner tone="danger" title="This cannot be saved yet">
          <NoteList>
            {preview.issues.map((one) => <li key={`${one.at}-${one.text}`}><code>{one.at}</code> — {one.text} {one.fix}</li>)}
          </NoteList>
        </Banner>
      )}

      {preview && preview.edits.map((edit) => (
        <div key={edit.path} className="flex flex-col gap-(--hd-space-2)">
          <Text>{edit.path}</Text>
          <DiffView diff={edit.before === null ? edit.after : wholeTextDiff(edit.before, edit.after)} wholeFile={edit.before === null} wrap />
        </div>
      ))}
    </Dialog>
  )
}
