import { useEffect, useState } from 'react'

import type {
  GitFileStatus,
  GitLogPage,
  GitStatus,
  GoalCitation,
  GoalId,
  GoalView,
  MemoryFile,
  MemoryResolution,
} from '@harnessdesk/protocol'

import {
  Banner,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  KeyValue,
  KeyValueRow,
  NativeSelect,
  Note,
  Row,
  Rows,
  SectionHead,
} from '../design'
import { shortSha } from '../lib/evidence'
import { useStore } from '../state/context'
import { DiffView } from './Diff'
import { Markdown } from './Markdown'

/**
 * Project memory: the committed `.harnessdesk/memory/*.md` files a project
 * carries, and the citations a Goal has made into them.
 *
 * `goal: null` is read-only browsing — the existing Project page, where
 * there is no Goal being worked on to cite anything into. A non-null `goal`
 * additionally offers "Cite in this Goal…", which calls the existing
 * `goal/cite` through the store and nothing else; this component never
 * writes project memory itself. `citation` fixes the component to that one
 * citation's retained detail — used from `GoalReceipt`, which owns the
 * dialog chrome and the trigger focus returns to.
 *
 * Opening a citation never starts a turn, loads anything, or approves
 * anything: the retained text is untrusted repository prose (rule 5) and
 * renders through the same sanitized `Markdown` every transcript does.
 */
export const MemoryCitation = ({
  root,
  goal,
  citation,
}: {
  readonly root: string
  readonly goal: GoalId | null
  readonly citation?: GoalCitation
}) => {
  const store = useStore()
  const [head, setHead] = useState<string | null>(null)
  const [files, setFiles] = useState<readonly MemoryFile[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [dirty, setDirty] = useState<readonly GitFileStatus[]>([])
  const [citing, setCiting] = useState<string | null>(null)
  const [opened, setOpened] = useState<GoalCitation | null>(null)

  useEffect(() => {
    if (citation) return
    let live = true
    Promise.all([
      store.transport.request('git/log', { root, scope: 'head', limit: 1 }) as Promise<GitLogPage>,
      store.transport.request('git/status', { root }) as Promise<GitStatus | null>,
    ]).then(
      ([log, status]) => {
        if (!live) return
        setHead(log.commits[0]?.sha ?? null)
        setDirty((status?.files ?? []).filter((one) => one.path.startsWith('.harnessdesk/memory/')))
      },
      () => { if (live) setHead(null) },
    )
    return () => { live = false }
  }, [root, store, citation])

  useEffect(() => {
    if (citation || head === null) return
    let live = true
    setProblem(null)
    store.readMemoryFiles(root, head).then(
      (list) => { if (live) setFiles(list) },
      (error: unknown) => { if (live) setProblem(error instanceof Error ? error.message : String(error)) },
    )
    return () => { live = false }
  }, [root, head, store, citation])

  if (citation) return <CitationDetail root={root} citation={citation} />

  const dirtyPaths = new Set(dirty.map((one) => one.path))
  const rows = (files ?? []).filter((one) => !dirtyPaths.has(one.path))

  return (
    <>
      {problem && <Banner tone="danger" title="Project memory could not be read">{problem}</Banner>}
      {!problem && files === null && dirty.length === 0 && <Note>Reading project memory…</Note>}
      {!problem && rows.length === 0 && dirty.length === 0 && files !== null && (
        <EmptyState tight title="No project memory yet" description="Committed .harnessdesk/memory/*.md files a Goal can cite will appear here." />
      )}
      {(rows.length > 0 || dirty.length > 0) && (
        <Rows>
          {dirty.map((one) => <DirtyMemoryRow key={one.path} root={root} path={one.path} />)}
          {rows.map((file) => (
            <Row
              key={file.path}
              title={file.path}
              {...(file.problem ? { desc: file.problem } : {})}
              control={
                goal && !file.problem && head ? (
                  <Button size="sm" variant="outline" onClick={() => setCiting(file.path)}>Cite in this Goal…</Button>
                ) : undefined
              }
            />
          ))}
        </Rows>
      )}
      {citing && goal && head && (
        <CiteDialog
          root={root}
          goal={goal}
          path={citing}
          at={head}
          onClose={() => setCiting(null)}
          onCited={(made) => { setCiting(null); setOpened(made) }}
        />
      )}
      {opened && (
        <Dialog title={opened.path} size="lg" onClose={() => setOpened(null)}>
          <CitationDetail root={root} citation={opened} />
        </Dialog>
      )}
    </>
  )
}

/** A memory file with uncommitted changes: never offered for citing, and the desk never commits it on a person's behalf. */
const DirtyMemoryRow = ({ root, path }: { readonly root: string; readonly path: string }) => {
  const store = useStore()
  const [viewing, setViewing] = useState(false)
  const [diff, setDiff] = useState<string | null>(null)
  return (
    <>
      <Row
        title={path}
        desc="Commit this file before citing it."
        control={
          <span className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => store.openFile(`${root}/${path}`)}>Open file</Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setViewing((was) => !was)
                if (!viewing && diff === null) {
                  void store.transport
                    .request('git/diff', { root, path })
                    .then((result: { diff: string }) => setDiff(result.diff))
                    .catch(() => setDiff(''))
                }
              }}
            >
              {viewing ? 'Hide changes' : 'View changes'}
            </Button>
          </span>
        }
      />
      {viewing && diff !== null && <DiffView diff={diff} wrap />}
    </>
  )
}

/**
 * A person selects a wrapped source Goal and the committed path/revision
 * already chosen, previews that choice, then confirms. `goal/cite` (through
 * `store.citeMemory`) is the only write this makes, and it is made only
 * here, only on explicit confirmation.
 */
const CiteDialog = ({
  root,
  goal,
  path,
  at,
  onClose,
  onCited,
}: {
  readonly root: string
  readonly goal: GoalId
  readonly path: string
  readonly at: string
  readonly onClose: () => void
  readonly onCited: (citation: GoalCitation) => void
}) => {
  const store = useStore()
  const [sources, setSources] = useState<readonly GoalView[] | null>(null)
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    store.transport.request('goal/list', { root }).then(
      (views: readonly GoalView[]) => { if (live) setSources(views.filter((one) => one.goal.state === 'wrapped')) },
      (error: unknown) => { if (live) setProblem(error instanceof Error ? error.message : String(error)) },
    )
    return () => { live = false }
  }, [root, store])

  const source = sources?.find((one) => one.goal.id === selected) ?? null

  const confirm = (): void => {
    if (!source || busy) return
    setBusy(true)
    setProblem(null)
    void (async () => {
      try {
        const receipt = await store.readGoalReceipt(source.goal.id)
        if (!receipt) throw new Error('Choose an existing wrapped receipt.')
        const made: GoalCitation = { goal: source.goal.id, receipt: receipt.id, project: root, path, at }
        await store.citeMemory(goal, made)
        onCited(made)
      } catch (error) {
        setBusy(false)
        setProblem(error instanceof Error ? error.message : String(error))
      }
    })()
  }

  return (
    <ConfirmDialog title="Cite in this Goal?" confirmLabel="Cite in this Goal" tone="default" busy={busy} pending={!source} onCancel={onClose} onConfirm={confirm}>
      <KeyValue>
        <KeyValueRow label="File">{path}</KeyValueRow>
        <KeyValueRow label="Revision">{shortSha(at)}</KeyValueRow>
      </KeyValue>
      {sources === null ? (
        <Note>Reading wrapped Goals…</Note>
      ) : sources.length === 0 ? (
        <Banner tone="warning" title="Nothing to cite from">No Goal in this project is wrapped yet.</Banner>
      ) : (
        <NativeSelect aria-label="Source Goal" value={selected} onChange={(event) => setSelected(event.target.value)}>
          <option value="">Choose a wrapped Goal…</option>
          {sources.map((one) => <option key={one.goal.id} value={one.goal.id}>{one.goal.sentence}</option>)}
        </NativeSelect>
      )}
      {source && <Note>{`Source Goal: ${source.goal.sentence}`}</Note>}
      {problem && <Banner tone="danger" title="This cannot be cited">{problem}</Banner>}
    </ConfirmDialog>
  )
}

/**
 * One citation's retained detail: file, revision, source Goal sentence and
 * "Source selected by you" — never a digest as a title. A missing source
 * Goal or an unreadable revision says so honestly, beside the retained text
 * and the Seats that were there when it was captured, without ever
 * suggesting an active session.
 */
const CitationDetail = ({ root, citation }: { readonly root: string; readonly citation: GoalCitation }) => {
  const store = useStore()
  const key = JSON.stringify(citation)
  const [read, setRead] = useState<
    | { readonly key: string; readonly value: MemoryResolution }
    | { readonly key: string; readonly problem: string }
    | null
  >(null)

  useEffect(() => {
    let live = true
    store.readMemoryCitation(root, citation).then(
      (value) => { if (live) setRead({ key, value }) },
      (error: unknown) => { if (live) setRead({ key, problem: error instanceof Error ? error.message : String(error) }) },
    )
    return () => { live = false }
    // `citation` is captured by `key` — every field of it changes `key` too.
  }, [root, key, store])

  if (!read || read.key !== key) return <Note>Reading this citation…</Note>
  if ('problem' in read) return <Banner tone="danger" title="This citation could not be read">{read.problem}</Banner>

  const result = read.value
  if (result.state === 'unavailable') {
    return (
      <>
        <KeyValue>
          <KeyValueRow label="File">{citation.path}</KeyValueRow>
          <KeyValueRow label="Revision">{shortSha(citation.at)}</KeyValueRow>
        </KeyValue>
        <Banner tone="warning" title="The original source was not retained">{result.reason}</Banner>
      </>
    )
  }

  const { snapshot, sourceAvailable, revisionAvailable, restored } = result

  return (
    <>
      <KeyValue>
        <KeyValueRow label="File">{citation.path}</KeyValueRow>
        <KeyValueRow label="Revision">
          {revisionAvailable ? shortSha(citation.at) : `${shortSha(citation.at)} — Original revision unavailable`}
        </KeyValueRow>
        <KeyValueRow label="Source Goal">
          {sourceAvailable ? snapshot.receipt.sentence : `${snapshot.receipt.sentence} — Source Goal unavailable; retained copy`}
        </KeyValueRow>
        <KeyValueRow label="Origin">Source selected by you</KeyValueRow>
        {restored && <KeyValueRow label="History">Restored from a backup</KeyValueRow>}
      </KeyValue>
      <Markdown text={snapshot.text} document />
      {snapshot.seats.length > 0 && (
        <>
          <SectionHead name="Seats" />
          <Rows>
            {snapshot.seats.map((seat) => (
              <Row
                key={seat.id}
                title={seat.agent ? `${seat.agent.name} · ${seat.seatLabel}` : seat.seatLabel}
              />
            ))}
          </Rows>
        </>
      )}
      {snapshot.missingSeatIds.length > 0 && (
        <Note>{`${snapshot.missingSeatIds.length} of this receipt’s Seats are no longer kept.`}</Note>
      )}
    </>
  )
}
