import { useEffect, useState } from 'react'

import type { AgentAttachmentsView, AgentEntry, AttachmentEditPreview, AttachmentReview } from '@harnessdesk/protocol'

import { Banner, Button, CodeText, ConfirmDialog, Dialog, Note, Checkbox, Row, Rows, SectionHead, SummaryItem } from '../design'
import { useSnapshot, useStore } from '../state/context'
import { DiffView } from './Diff'

/**
 * Skills and Servers, editable, from the Agent page — Task 5's replacement
 * for phase 2's read-only Skills row. An empty list reads "Runtime
 * defaults", never "None": decision 7 treats an omitted or empty allowlist
 * as the runtime's own choice, not as nothing at all.
 *
 * Editing offers exactly what an Agent already declared, as a checked list —
 * unchecking and saving narrows the allowlist. Naming a brand new catalogue
 * entry is still done the existing way, in the file itself ("Open in
 * editor"): this dialog edits what is there, it does not add to it from a
 * search a person has not been shown yet.
 *
 * Returns a bare fragment of `SummaryItem`s, meant as a direct child of the
 * Agent page's own `SummaryList` — never a `Banner` of its own: a `<dl>`'s
 * subgrid has no room for one, and a failed read still has to be said
 * somewhere. `onProblem` hands that read-failure to the caller, which draws
 * it outside the list, once, rather than in place of the row it would
 * otherwise stand in.
 */
export const AgentAttachments = ({
  entry,
  onProblem,
}: {
  readonly entry: AgentEntry
  readonly onProblem?: (problem: string | null) => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [view, setView] = useState<AgentAttachmentsView | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [reviewing, setReviewing] = useState(false)

  useEffect(() => {
    let live = true
    setView(null)
    setProblem(null)
    store.readAgentAttachments(entry.id, entry.origin).then(
      (next) => { if (live) setView(next) },
      (error: unknown) => { if (live) setProblem(error instanceof Error ? error.message : String(error)) },
    )
    return () => { live = false }
  }, [entry.id, entry.origin, store])

  useEffect(() => {
    onProblem?.(problem)
    // Cleared on unmount too — a page that stops showing this Agent must not
    // go on showing a Banner for it.
    return () => onProblem?.(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problem])

  if (problem) return null
  if (!view) return null

  const skillNames = view.declarations.filter((one) => one.kind === 'skill').map((one) => one.name)
  const mcpNames = view.declarations.filter((one) => one.kind === 'mcp').map((one) => one.name)
  const editable = entry.origin !== 'builtin'
  const loadable = view.declarations.some((one) => one.identity !== null)
  // Whether any runtime here can scope a Seat at all — a yes/no, never a
  // choice of runtime: which runtime a review is for is the host's answer
  // (the one `agent/seat` will actually seat on), not the first capable row.
  const anyCapable = view.support.some((one) => one.skills === 'scoped' || one.mcp === 'scoped-gated')

  return (
    <>
      <SummaryItem
        label="Skills"
        {...(editable ? { action: <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Edit…</Button> } : {})}
      >
        {view.skillsMode === 'runtime-defaults' ? 'Runtime defaults' : skillNames.join(', ')}
      </SummaryItem>
      <SummaryItem
        label="Servers"
        {...(editable ? { action: <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Edit…</Button> } : {})}
        {...(loadable && anyCapable && snapshot.workspace
          ? {
              note: (
                <span className="inline-flex flex-wrap items-center gap-2">
                  {`Review what this Agent would load in ${snapshot.workspace.name}`}
                  <Button size="sm" variant="outline" onClick={() => setReviewing(true)}>Review & Approve…</Button>
                </span>
              ),
            }
          : {})}
      >
        {view.mcpMode === 'runtime-defaults' ? 'Runtime defaults' : mcpNames.join(', ')}
      </SummaryItem>
      {editing && (
        <AttachmentEditDialog
          entry={entry}
          view={view}
          onClose={() => setEditing(false)}
          onSaved={(next) => { setView(next); setEditing(false) }}
        />
      )}
      {reviewing && snapshot.workspace && (
        <AttachmentReviewDialog entry={entry} root={snapshot.workspace.path} onClose={() => setReviewing(false)} />
      )}
    </>
  )
}

const toggled = (set: ReadonlySet<string>, name: string, on: boolean): ReadonlySet<string> => {
  const next = new Set(set)
  if (on) next.add(name)
  else next.delete(name)
  return next
}

const AttachmentEditDialog = ({
  entry,
  view,
  onClose,
  onSaved,
}: {
  readonly entry: AgentEntry
  readonly view: AgentAttachmentsView
  readonly onClose: () => void
  readonly onSaved: (view: AgentAttachmentsView) => void
}) => {
  const store = useStore()
  const skillDeclarations = view.declarations.filter((one) => one.kind === 'skill')
  const mcpDeclarations = view.declarations.filter((one) => one.kind === 'mcp')
  const [skillsKept, setSkillsKept] = useState<ReadonlySet<string>>(new Set(skillDeclarations.map((one) => one.name)))
  const [mcpKept, setMcpKept] = useState<ReadonlySet<string>>(new Set(mcpDeclarations.map((one) => one.name)))
  const [preview, setPreview] = useState<AttachmentEditPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setPreview(null)
    setProblem(null)
    store.previewAttachmentEdit(entry, [...skillsKept], [...mcpKept]).then(
      (next) => { if (live) setPreview(next) },
      (error: unknown) => { if (live) setProblem(error instanceof Error ? error.message : String(error)) },
    )
    return () => { live = false }
  }, [entry, skillsKept, mcpKept, store])

  const save = (): void => {
    if (!preview || busy) return
    setBusy(true)
    setProblem(null)
    void (async () => {
      try {
        const written = await store.writeAttachmentEdit(entry, [...skillsKept], [...mcpKept], preview.digest)
        const refreshed = await store.readAgentAttachments(written.id, written.origin)
        onSaved(refreshed)
      } catch (error) {
        setBusy(false)
        setProblem(error instanceof Error ? error.message : String(error))
      }
    })()
  }

  return (
    <Dialog
      title={`Edit ${entry.definition?.name ?? entry.id}’s allowlists`}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button variant="default" disabled={busy || !preview} onClick={save}>{busy ? 'Writing…' : 'Save'}</Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <Note>Choosing none for a list uses this runtime’s own defaults — never “nothing loaded”.</Note>
      <SectionHead name="Skills" />
      <Rows>
        {skillDeclarations.length === 0 ? (
          <Row title="No skills are declared here yet" />
        ) : (
          skillDeclarations.map((one) => (
            <Row
              key={one.name}
              title={one.name}
              desc={one.problem ?? undefined}
              control={<Checkbox checked={skillsKept.has(one.name)} onCheckedChange={(next) => setSkillsKept(toggled(skillsKept, one.name, next === true))} />}
            />
          ))
        )}
      </Rows>
      <SectionHead name="Servers" />
      <Rows>
        {mcpDeclarations.length === 0 ? (
          <Row title="No servers are declared here yet" />
        ) : (
          mcpDeclarations.map((one) => (
            <Row
              key={one.name}
              title={one.name}
              desc={one.problem ?? undefined}
              control={<Checkbox checked={mcpKept.has(one.name)} onCheckedChange={(next) => setMcpKept(toggled(mcpKept, one.name, next === true))} />}
            />
          ))
        )}
      </Rows>
      {problem && <Banner tone="danger" title="This cannot be written">{problem}</Banner>}
      {preview && (
        <div className="space-y-2">
          <CodeText>{preview.path}</CodeText>
          <DiffView diff={preview.diff} wrap />
        </div>
      )}
    </Dialog>
  )
}

/**
 * What a person is asked to approve before this Agent's declared content may
 * ever load, for one runtime: the exact bytes, never a promise to fetch them
 * again later. Built on `ConfirmDialog` on purpose — decision 10 calls for
 * its existing accidental-click protection (no initial affirmative focus, a
 * held Enter or a backdrop click must not approve) rather than a bespoke
 * dialog that would have to earn that protection again.
 */
const AttachmentReviewDialog = ({
  entry,
  root,
  onClose,
}: {
  readonly entry: AgentEntry
  readonly root: string
  readonly onClose: () => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [review, setReview] = useState<AttachmentReview | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [approved, setApproved] = useState(false)
  // A value shown only as set can change what a server does; approving asks the person to say they know it.
  const [acknowledged, setAcknowledged] = useState(false)
  const hidden = review?.hidden ?? []

  useEffect(() => {
    let live = true
    store.reviewAttachments(entry.id, entry.origin, root).then(
      (next) => { if (live) setReview(next) },
      (error: unknown) => { if (live) setProblem(error instanceof Error ? error.message : String(error)) },
    )
    return () => { live = false }
  }, [entry.id, entry.origin, root, store])

  // Rule 8: a runtime is named by its presentation, never its id.
  const runtimeName = review
    ? (snapshot.runtimes.find((one) => String(one.id) === review.runtime)?.presentation.name ?? 'this agent')
    : 'this agent'

  if (approved) {
    return (
      <Dialog title="Approved" onClose={onClose} footer={<Button variant="default" onClick={onClose}>Done</Button>}>
        <Note>{runtimeName} may now load exactly the bytes just reviewed, the next time this Agent is seated.</Note>
      </Dialog>
    )
  }

  return (
    <ConfirmDialog
      title={`Approve what ${runtimeName} would load?`}
      confirmLabel="Approve"
      // Approving is not destroying anything, and nothing can be approved
      // before the exact content it approves has been read and shown.
      tone="default"
      pending={!review || (hidden.length > 0 && !acknowledged)}
      busy={busy}
      onCancel={onClose}
      onConfirm={() => {
        if (!review) return
        setBusy(true)
        setProblem(null)
        void (async () => {
          try {
            await store.approveAttachments(review.token, hidden.length > 0 && acknowledged)
            setApproved(true)
          } catch (error) {
            setBusy(false)
            setProblem(error instanceof Error ? error.message : String(error))
          }
        })()
      }}
    >
      {problem && <Banner tone="danger" title="This could not be reviewed">{problem}</Banner>}
      {review && (
        <div className="space-y-2">
          <Note>{review.consequence}</Note>
          <Note>Effective ceiling: {review.effectiveCeiling}</Note>
          {review.files.map((file) => (
            <div key={file.path} className="space-y-1">
              <CodeText>{file.path}</CodeText>
              <CodeText as="pre">{file.text}</CodeText>
            </div>
          ))}
          {hidden.length > 0 && (
            <Rows>
              <Row
                title="I know what the hidden values are"
                // A fact that varies: which values this review could not show.
                desc={`Shown only as set: ${hidden.join(', ')}. A value like this can change what the server does, and the approval covers it exactly.`}
                control={<Checkbox checked={acknowledged} onCheckedChange={(next) => setAcknowledged(next === true)} aria-label="I know what the hidden values are" />}
              />
            </Rows>
          )}
        </div>
      )}
    </ConfirmDialog>
  )
}
