import { useEffect, useState } from 'react'

import type { FindingView } from '@harnessdesk/protocol'

import {
  Banner,
  Button,
  Chip,
  CodeText,
  MetaList,
  Note,
  RowButton,
  Rows,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
  ToolPane,
  ToolPaneBody,
  ToolPaneEmptyState,
  ToolPaneHeader,
  ToolPaneMessage,
} from '../design'
import { ReviewIcon } from './Icons'
import { blockingWords, FILTER_LABEL, goalHasBoundPr, lifecycleTone, lifecycleWords, type FindingFilter } from '../lib/findings'
import { useSnapshot, useStore } from '../state/context'
import { FindingDecision } from './FindingDecision'
import { FindingDetail } from './FindingDetail'
import { FindingPublications } from './FindingPublications'
import { FindingRoundStatus } from './FindingRoundStatus'

/**
 * The Goal's findings, as a person reads them: filterable, paged, with the
 * ledger's own words for a claimed repair, a withdrawn row and a publication
 * that has not landed. Every read is explicit — an effect, never a render —
 * and stays on this one Goal: switching away and back reuses the cache
 * `store.loadFindings` already keeps.
 */

const FILTERS: readonly FindingFilter[] = ['all', 'open', 'blocking']

const rowSecondLine = (view: FindingView): string => {
  const bits = [`Raised in round ${view.origin.round}`]
  if (view.restored) bits.push('from a backup')
  return bits.join(' · ')
}

export const GoalFindings = ({ goal }: { readonly goal: string }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const state = snapshot.findings.get(goal)
  const [opened, setOpened] = useState<string | null>(null)
  const [deciding, setDeciding] = useState(false)
  const [publicationPending, setPublicationPending] = useState<boolean | null>(null)
  const [publicationError, setPublicationError] = useState<string | null>(null)

  const run = [...snapshot.flowExecutions.values()].find((one) => one.goal === goal && one.findings)
  const runView = run ? snapshot.findingRuns.get(run.id) : undefined

  useEffect(() => {
    void store.loadFindings(goal, 'all')
  }, [store, goal])

  useEffect(() => {
    if (run) void store.loadFindingRun(goal, run.id)
  }, [store, goal, run?.id])

  const filter = state?.filter ?? 'all'
  const setFilter = (next: FindingFilter): void => {
    if (next === filter) return
    void store.loadFindings(goal, next)
  }

  const goalView = snapshot.goals.get(goal)
  const boundPr = goalHasBoundPr(snapshot.boardEvidence.get(goal))
  const confirmedPublication = goalView?.goal.findingPublication !== false
  const publicationOn = publicationPending ?? confirmedPublication

  const setPublication = async (enabled: boolean): Promise<void> => {
    if (!goalView) return
    setPublicationPending(enabled)
    setPublicationError(null)
    try {
      await store.setFindingPublication(goal, goalView.goal.revision, enabled)
    } catch (error) {
      setPublicationError(error instanceof Error ? error.message : String(error))
    } finally {
      setPublicationPending(null)
    }
  }

  const rows = state?.rows ?? []
  const loadingFirstPage = !state || (state.loading && rows.length === 0)

  return (
    <ToolPane variant="integrated" aria-label="Findings">
      <ToolPaneHeader
        icon={<ReviewIcon />}
        title="Findings"
        subtitle={state?.totals ? `${state.totals.open} open · ${state.totals.blocking} blocking of ${state.totals.all}` : undefined}
        subtitleFace="text"
        actions={
          <Tabs value={filter} onValueChange={(next) => setFilter(next as FindingFilter)}>
            <TabsList aria-label="Filter findings">
              {FILTERS.map((one) => (
                <TabsTrigger key={one} value={one}>{FILTER_LABEL[one]}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        }
      />
      <ToolPaneBody className="flex flex-col gap-3">
        {runView && (
          <>
            <FindingRoundStatus view={runView} />
            {(runView.reason !== null || runView.blocking > 0) && (
              <Button
                variant="outline"
                size="sm"
                disabled={runView.undecidable !== null}
                title={runView.undecidable ?? undefined}
                onClick={() => setDeciding(true)}
              >
                Decide this run
              </Button>
            )}
            {runView.undecidable && <Note>{runView.undecidable}</Note>}
            {!runView.undecidable && <FindingPublications goal={goal} run={runView.run} stamp={runView.stamp} />}
          </>
        )}
        {boundPr ? (
          <Note>
            <span className="flex items-center justify-between gap-3">
              <span>Post closed rounds to the pull request</span>
              <Switch
                checked={publicationOn}
                disabled={publicationPending !== null || !goalView}
                aria-label="Post closed rounds to the pull request"
                onCheckedChange={(checked: boolean) => void setPublication(checked)}
              />
            </span>
          </Note>
        ) : (
          <Note>Local findings — no pull request is bound to this Goal yet.</Note>
        )}
        {publicationError && (
          <Banner tone="danger" title="This preference could not be saved">{publicationError}</Banner>
        )}
        {state?.stale && state.error && (
          <Banner tone="danger" title="These findings could not be reloaded">{state.error}</Banner>
        )}
        {loadingFirstPage ? (
          <ToolPaneMessage>Reading findings…</ToolPaneMessage>
        ) : state!.problem ? (
          <Banner tone="warning" title="This ledger cannot be shown as complete">{state!.problem}</Banner>
        ) : rows.length === 0 ? (
          <ToolPaneEmptyState icon={<ReviewIcon />} title="No findings recorded" />
        ) : (
          <Rows>
            {rows.map((row) => (
              <RowButton
                key={row.id}
                onClick={() => setOpened(row.id)}
                mark={<Chip tone={lifecycleTone(row)}>{lifecycleWords(row)}</Chip>}
                title={
                  <span className="flex min-w-0 items-baseline gap-2">
                    <CodeText size="inherit" className="shrink-0 select-all">{row.id}</CodeText>
                    <span className="min-w-0 truncate">{row.title || 'Untitled finding'}</span>
                  </span>
                }
                desc={
                  <MetaList>
                    {rowSecondLine(row)}
                    {blockingWords(row) === 'Blocking' ? ' · Blocking' : ' · Advisory'}
                  </MetaList>
                }
              />
            ))}
          </Rows>
        )}
        {state?.next && !loadingFirstPage && (
          <Button variant="ghost" size="sm" disabled={state.loadingMore} onClick={() => void store.loadFindings(goal, filter, state.next!)}>
            {state.loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        )}
      </ToolPaneBody>
      {opened && <FindingDetail goal={goal} finding={opened} onClose={() => setOpened(null)} {...(runView ? { decide: runView } : {})} />}
      {deciding && runView && <FindingDecision goal={goal} view={runView} onClose={() => setDeciding(false)} />}
    </ToolPane>
  )
}
