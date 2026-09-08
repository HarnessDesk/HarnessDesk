import { useCallback, useEffect, useMemo, useState } from 'react'

import type { RuntimeId, RuntimeInfo, SessionId, SessionSummary } from '@harnessdesk/protocol'

import { folderName } from '../lib/projects'
import { sessionLabel } from '../lib/sessions'
import { useSnapshot, useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import { DeleteSession } from './DeleteSession'
import { ArchiveIcon, FolderIcon, SearchIcon, UndoIcon } from './Icons'
import { Btn, PageHead, Row, Rows, Search, SectionHead, kit } from '../design/primitives/Kit'
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
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)

  const runtimes = snapshot.runtimes

  /**
   * Every agent's archive, asked for in parallel and merged.
   *
   * An agent that cannot answer — not started, or down — is named rather than
   * counted as empty: "no archived conversations" and "one agent did not
   * answer" look identical otherwise, and only one of them means the archive
   * is empty.
   */
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const pages = await Promise.all(
        runtimes.map(async (runtime) => {
          try {
            const page = await store.transport.request('session/list', {
              runtime: runtime.id,
              archived: 'only',
            })
            return { rows: page.data, failed: null as string | null }
          } catch {
            return { rows: [] as readonly SessionSummary[], failed: runtime.presentation.name }
          }
        }),
      )
      setSessions(pages.flatMap((page) => page.rows).sort((a, b) => b.updatedAt - a.updatedAt))
      setUnreachable(pages.map((page) => page.failed).filter((name): name is string => name !== null))
    } finally {
      setLoading(false)
    }
  }, [runtimes, store])

  useEffect(() => {
    void load()
  }, [load])

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
    setSessions((current) =>
      current.filter((row) => row.id !== summary.id || row.runtime !== summary.runtime),
    )
    await store.unarchiveSession(summary.id as SessionId, summary.runtime as RuntimeId)
  }

  return (
    <>
      <PageHead
        title="Archive"
        blurb="Conversations taken out of the list. Nothing here has been deleted; restore one and it goes back where it was."
      />

      {unreachable.length > 0 && (
        <p className={kit.pageBlurb}>
          {unreachable.length === 1
            ? unreachable[0]
            : `${unreachable.slice(0, -1).join(', ')} and ${unreachable[unreachable.length - 1]}`}{' '}
          could not be asked, so nothing of {unreachable.length === 1 ? 'its' : 'theirs'} is listed here.
        </p>
      )}

      {loading && <p className={kit.pageBlurb}>Reading every agent’s archive…</p>}

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
                    <RuntimeMark runtime={runtime} size={15} />
                  </span>
                  {runtime.presentation.name} · {rows.length}
                </>
              }
            />
            <p className={styles.note}>{blurbFor(runtime)}</p>
            <Rows>
              {rows.map((summary) => {
                const deletable = runtime.capabilities.deleteHistory
                return (
                  <Row
                    key={`${summary.runtime}-${summary.id}`}
                    mark={<FolderIcon size={15} />}
                    title={sessionLabel(summary.title, summary.preview)}
                    desc={`${folderName(summary.cwd)} · last active ${new Date(
                      summary.updatedAt,
                    ).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}`}
                    control={
                      <>
                        <Btn small onClick={() => void restore(summary)}>
                          <UndoIcon size={13} />
                          Restore
                        </Btn>
                        <Btn
                          small
                          variant="danger"
                          disabled={!deletable}
                          title={
                            deletable
                              ? undefined
                              : `${runtime.presentation.name} keeps no way to delete one.`
                          }
                          onClick={() => setDeleting(summary)}
                        >
                          Delete…
                        </Btn>
                      </>
                    }
                  />
                )
              })}
            </Rows>
          </section>
        ))}

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
        <Row
          mark={<SearchIcon size={15} />}
          title={`Nothing here matches “${query}”`}
          desc="Search covers the name, the opening message and the folder."
        />
      </Rows>
    )
  }
  return (
    <Rows>
      <Row
        mark={<ArchiveIcon size={15} />}
        title="Nothing is archived"
        desc="Archive a conversation from its ⋯ menu in the sidebar. It leaves the list and waits here; nothing about it is lost, and Restore puts it back."
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
