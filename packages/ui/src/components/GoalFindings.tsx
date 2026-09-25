import { useEffect, useState } from 'react'

import type { FindingView } from '@harnessdesk/protocol'

import {
  Banner,
  Button,
  Chip,
  CodeText,
  MetaList,
  NativeSelect,
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
import { goalRunLabel, goalRunOf, goalRunsOf } from '../lib/goal-run'
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

  const goalView = snapshot.goals.get(goal)
  /* The same run the room's header reads, among those keeping findings (#890),
     unless the person chose an earlier one to read as history. */
  const live = goalRunOf(goal, goalView, snapshot.flowExecutions, (one) => Boolean(one.findings))
  const runs = goalRunsOf(goal, snapshot.flowExecutions)
  const [chosen, setChosen] = useState<string | null>(null)
  const run = (chosen ? runs.find((one) => one.id === chosen) : undefined) ?? live
  const runView = run ? snapshot.findingRuns.get(run.id) : undefined
  // A finding a run of this Goal raised is decided against that run, whichever one is shown.
  const openedRow = opened ? (state?.rows ?? []).find((one) => one.id === opened) : undefined
  const originRun = openedRow && openedRow.origin.goal === goal && runs.some((one) => one.id === openedRow.origin.run)
    ? openedRow.origin.run
    : null
  const decideView = originRun ? snapshot.findingRuns.get(originRun) : runView
  // A verdict on a finding outlives the run that raised it while its Goal is open; the host refuses once it is not (or came from a backup).
  const goalOpen = goalView !== undefined && goalView.goal.state === 'open'

  useEffect(() => {
    void store.loadFindings(goal, 'all')
  }, [store, goal])

  useEffect(() => {
    if (run) void store.loadFindingRun(goal, run.id)
  }, [store, goal, run?.id])

  useEffect(() => {
    if (originRun && originRun !== run?.id) void store.loadFindingRun(goal, originRun)
  }, [store, goal, originRun, run?.id])

  const filter = state?.filter ?? 'all'
  const setFilter = (next: FindingFilter): void => {
    if (next === filter) return
    void store.loadFindings(goal, next)
  }

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
  // Where an earlier run's open findings went: here, still decidable, each against its own run.
  const fromEarlier = run
    ? rows.filter((one) => one.origin.goal === goal && one.origin.run !== run.id && runs.some((other) => other.id === one.origin.run) &&
      one.lifecycle.state === 'open' && !one.lifecycle.confirmed).length
    : 0

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
        {runs.length > 1 && run && (
          <NativeSelect aria-label="Run" value={run.id} onChange={(event) => setChosen(event.target.value)}>
            {runs.map((one, index) => (
              <option key={one.id} value={one.id}>{goalRunLabel(one, index, runs.length)}</option>
            ))}
          </NativeSelect>
        )}
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
        {fromEarlier > 0 && (
          <Note>
            {`${fromEarlier} open finding${fromEarlier === 1 ? ' here was' : 's here were'} raised by an earlier run of this Goal. Open one to decide it yourself; it is decided against the run that raised it.`}
          </Note>
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
                title={
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate">{row.title || 'Untitled finding'}</span>
                    <CodeText size="inherit" className="shrink-0 select-all">{row.id}</CodeText>
                  </span>
                }
                desc={
                  <MetaList>
                    {rowSecondLine(row)}
                    {blockingWords(row) === 'Blocking' ? ' · Blocking' : ' · Advisory'}
                  </MetaList>
                }
                control={<Chip tone={lifecycleTone(row)}>{lifecycleWords(row)}</Chip>}
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
      {opened && (
        <FindingDetail
          goal={goal}
          finding={opened}
          onClose={() => setOpened(null)}
          {...(decideView ? { decide: decideView, verdictAfterRun: goalOpen } : {})}
        />
      )}
      {deciding && runView && <FindingDecision goal={goal} view={runView} onClose={() => setDeciding(false)} />}
    </ToolPane>
  )
}
