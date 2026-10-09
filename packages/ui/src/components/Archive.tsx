import { useCallback, useEffect, useMemo, useState } from 'react'

import type { RuntimeId, RuntimeInfo, SessionId, SessionSummary, WorktreeChanges, HostResult } from '@harnessdesk/protocol'

import { folderName } from '../lib/projects'
import { sessionLabel } from '../lib/sessions'
import { useSnapshot, useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import { DeleteSession } from './DeleteSession'
import { ArchiveIcon, FolderIcon, SearchIcon, UndoIcon } from './Icons'
import { BoardMenuButton, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, Button, EmptyState, Note, PageDescription, PageHead, Row, Rows, Search, SectionHead, Chip, ConfirmDialog, Text, MiddleTruncate } from '../design'
import { IgnoredEntries, UncommittedFiles, describeUncommitted } from './WorktreeAlerts'
import styles from './Archive.module.css'

/**
 * The archive: everything taken out of the session list, and the two things
 * you can do about it.
 *
 * It is a page in Settings rather than a slot in the sidebar, because of what
 * the sidebar is for. Every row up there is something a person reaches for
 * while working, many times a day — start a conversation, see what is left of
 * the plan, open what the agents can do. The archive is the opposite kind of
 * place: you file something into it from a conversation's own ⋯ menu and then
 * do not think about it again until, weeks later, you want one thing back. A
 * permanent slot for a trip somebody makes twice a month spends the sidebar's
 * most valuable space, and the attention of the rows around it, every day for
 * a journey nobody is making. Settings is already where the app keeps the
 * places you go to on purpose — and ⌘K still reaches this one by name.
 *
 * Grouping is by agent, because the archive is per agent whether or not the
 * agent knows it. Codex keeps its own — a thread archived here is archived in
 * Codex Desktop too — while everyone else's mark is HarnessDesk's, and their
 * own window still lists the conversation. Every agent's heading says which,
 * rather than letting the user find out from the other application. The rail
 * this page used to hang off showed that sentence only once you had scoped to
 * a single agent, so the view most people saw never said it at all.
 *
 * Restore is one click and needs no confirmation; Delete has a dialog and is
 * greyed for agents that cannot do it. Same pairing as the session row.
 */
export const ArchiveSection = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([])
  const [unreachable, setUnreachable] = useState<readonly string[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [discarding, setDiscarding] = useState<SessionSummary | null>(null)
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)

  const runtimes = snapshot.runtimes

  /** Read every local page; native archive reconciliation runs in the host. */
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const rows: SessionSummary[] = []
      let cursor: string | undefined
      do {
        const page = await store.transport.request('session/index', {
          runtimes: runtimes.map(runtime => runtime.id), archived: 'only', pageSize: 500,
          ...(cursor ? { cursor } : {}),
        })
        rows.push(...page.data)
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      setSessions(rows)
      setUnreachable([])
    } catch {
      setUnreachable(['The archive'])

    } finally {
      setLoading(false)
    }
  }, [runtimes, store])

  useEffect(() => {
    void load()
  }, [load, snapshot.historyIdentity])

  const needle = query.trim().toLowerCase()
  const shown = useMemo(() => {
    if (needle === '') return sessions
    return sessions.filter(
      (summary) =>
        sessionLabel(summary.title, summary.preview).toLowerCase().includes(needle) ||
        (summary.preview ?? '').toLowerCase().includes(needle) ||
        summary.cwd.toLowerCase().includes(needle),
    )
  }, [needle, sessions])

  // One card per agent that has something, in the order the agents are listed
  // everywhere else. An agent with an empty archive is simply absent: a
  // heading over nothing is a question the reader has to answer themselves.
  const groups = useMemo(
    () =>
      runtimes
        .map((runtime) => ({ runtime, rows: shown.filter((row) => row.runtime === runtime.id) }))
        .filter((group) => group.rows.length > 0),
    [runtimes, shown],
  )

  const restore = async (summary: SessionSummary): Promise<void> => {
    if (await store.unarchiveSession(summary.id as SessionId, summary.runtime as RuntimeId) === false) return
    setSessions(current => current.filter(row => row.id !== summary.id || row.runtime !== summary.runtime))
  }

  return (
    <>
      <PageHead
        title="Archive"
        blurb="Conversations taken out of the list. Nothing here has been deleted; restore one and it goes back where it was."
      />

      {unreachable.length > 0 && (
        <PageDescription>
          The archive could not be read. <Button variant="outline" size="sm" onClick={() => void load()}>Try again</Button>
        </PageDescription>
      )}

      {loading && <PageDescription>Reading the archive…</PageDescription>}

      {!loading && sessions.length > 0 && (
        <Search
          className={styles.search}
          value={query}
          placeholder="Search the archive"
          label="Search archived conversations"
          onChange={setQuery}
        />
      )}

      {!loading && shown.length === 0 && <Empty query={query.trim()} />}

      {!loading &&
        groups.map(({ runtime, rows }) => (
          <section key={runtime.id}>
            <SectionHead
              name={
                <>
                  <span className={styles.mark}>
                    <RuntimeMark runtime={runtime} size={13} />
                  </span>
                  {runtime.presentation.name} · {rows.length}
                </>
              }
            />
            <Note ink="muted" className={styles.note}>{blurbFor(runtime)}</Note>
            <Rows>
              {rows.map((summary) => {
                const deletable = runtime.capabilities.deleteHistory === 'trash'
                return (
                  <Row
                    key={`${summary.runtime}-${summary.id}`}
                    kind="record"
                    mark={<FolderIcon size={16} />}
                    title={sessionLabel(summary.title, summary.preview)}
                    titleChip={summary.worktree?.state === 'kept' ? <KeptChip summary={summary} /> : undefined}
                    desc={`${folderName(summary.cwd)} · last active ${new Date(
                      summary.updatedAt,
                    ).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}`}
                    truncateDesc
                    control={
                      <>
                        <Button variant="outline" size="sm" onClick={() => void restore(summary)}>
                          <UndoIcon size={13} />
                          Restore
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger render={<BoardMenuButton aria-label={`${sessionLabel(summary.title, summary.preview)} actions`} />} />
                          <DropdownMenuContent align="end">
                            {summary.worktree?.state === 'kept' && <DropdownMenuItem onClick={() => setDiscarding(summary)}>Discard worktree…</DropdownMenuItem>}
                            <DropdownMenuItem variant="destructive"
                              disabled={!deletable}
                              title={deletable ? undefined : runtime.capabilities.deleteHistory === 'erase' ? `${runtime.presentation.name} erases it for good, so delete it there` : `${runtime.presentation.name} keeps no way to delete one.`}
                              closeOnClick={deletable}
                              onClick={() => { if (deletable) setDeleting(summary) }}>Delete everywhere…</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </>
                    }
                  />
                )
              })}
            </Rows>
          </section>
        ))}

      {discarding && <DiscardWorktree summary={discarding} onClose={() => { setDiscarding(null); void load() }} />}
      {deleting && (
        <DeleteSession
          summary={deleting}
          onClose={() => {
            setDeleting(null)
            // The dialog closes on success and on cancel alike, so the row is
            // re-read rather than assumed gone: a cancelled delete must leave
            // the archive exactly as it was.
            void load()
          }}
        />
      )}
    </>
  )
}

/**
 * Nothing to show, and why — two different reasons that must not be given the
 * same words.
 *
 * A search with no hits blames the search. An archive that is empty is the one
 * worth explaining, since someone seeing it has probably never archived
 * anything and the way to is a menu they have not opened. Saying
 * `Nothing matches ""` for that — which is what one shared branch did — blames
 * a search nobody ran.
 */
const Empty = ({ query }: { query: string }) => {
  if (query !== '') {
    return (
      <Rows>
        <EmptyState
          variant="row"
          icon={<SearchIcon size={15} />}
          title={`Nothing here matches “${query}”`}
          description="Search covers the name, the opening message and the folder."
        />
      </Rows>
    )
  }
  return (
    <Rows>
      <EmptyState
        variant="row"
        icon={<ArchiveIcon size={15} />}
        title="Nothing is archived"
        description="Archive one from its ⋯ menu in the sidebar; Restore puts it back."
      />
    </Rows>
  )
}

/**
 * Where this agent's archive actually lives, said plainly.
 *
 * The difference is visible from the other application, so hiding it only
 * means the user meets it there instead: a Codex thread archived here is
 * archived in Codex Desktop, and a Claude Code conversation archived here is
 * still in Claude Code's own list.
 */
const blurbFor = (runtime: RuntimeInfo): string =>
  runtime.capabilities.archiveHistory
    ? `${runtime.presentation.name} keeps this archive itself, so a conversation archived here is archived in its own window too.`
    : `${runtime.presentation.name} has no archive of its own, so HarnessDesk keeps the mark. The conversation is untouched and still listed in ${runtime.presentation.name}’s own window.`


const inventoryTitle = (changes: WorktreeChanges): string =>
  `${changes.modified} modified, ${changes.untracked} untracked files; ${changes.ignoredCount} ignored entries`

const KeptChip = ({ summary }: { summary: SessionSummary }) => {
  const store = useStore()
  const [title, setTitle] = useState('The worktree stayed. Review it before discarding.')
  useEffect(() => {
    let cancelled = false
    void store.transport.request('worktree/changes', { path: summary.worktree!.path })
      .then(changes => { if (!cancelled) setTitle(inventoryTitle(changes)) }).catch(() => {})
    return () => { cancelled = true }
  }, [store, summary.worktree?.path])
  return <Chip tone="warning" size="sm" title={title}>Worktree kept</Chip>
}

const DiscardWorktree = ({ summary, onClose }: { summary: SessionSummary; onClose: () => void }) => {
  const store = useStore()
  const [preview, setPreview] = useState<HostResult<'session/worktreePreview'> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void store.transport.request('session/worktreePreview', { runtime: summary.runtime, sessionId: summary.id })
      .then(value => { if (!cancelled) setPreview(value) })
      .catch(thrown => { if (!cancelled) setError(String(thrown)) })
    return () => { cancelled = true }
  }, [store, summary])
  const discard = async () => {
    if (!preview) return
    setBusy(true)
    try {
      const result = await store.transport.request('session/discardWorktree', { runtime: summary.runtime, sessionId: summary.id, stamp: preview.stamp })
      if (result.discarded) onClose()
      else { setPreview(result.preview ?? null); setError('The worktree changed. Review this list and confirm again.') }
    } catch (thrown) { setError(thrown instanceof Error ? thrown.message : String(thrown)); setPreview(null) }
    finally { setBusy(false) }
  }
  const changes = preview?.changes
  return <ConfirmDialog title="Discard worktree?" confirmLabel="Discard worktree" busyLabel="Discarding…"
    tone="destructive" busy={busy} pending={!preview} onConfirm={() => void discard()} onCancel={onClose}>
    <p><Text as="span" role="subject"><MiddleTruncate>{summary.worktree?.path ?? ''}</MiddleTruncate></Text><br />
      The folder and its uncommitted and ignored content go. The branch is kept. There is no undo.</p>
    {error && <Note tone="bad">{error}</Note>}
    {error && !preview && <Button variant="outline" size="sm" onClick={() => {
      setError(null)
      void store.transport.request('session/worktreePreview', { runtime: summary.runtime, sessionId: summary.id })
        .then(setPreview).catch(thrown => setError(String(thrown)))
    }}>Review again</Button>}
    {!changes && !error && <p>Checking for unsaved work…</p>}
    {changes && changes.modified + changes.untracked > 0 && <UncommittedFiles className="mb-3" changes={changes}
      title={`This would discard ${describeUncommitted(changes)}`}>Commit or stash them first to keep them.</UncommittedFiles>}
    {changes && <IgnoredEntries changes={changes} />}
  </ConfirmDialog>
}
