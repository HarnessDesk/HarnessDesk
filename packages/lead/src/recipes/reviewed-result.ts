/** Private source, deliberately outside the host's built-in Flow catalogue.
 * Checks are the project's declared checks, run by the worker through its existing
 * tools and judged from desk evidence. No model-generated shell command is inserted. */
const legacyLeadReviewedResultSource = `version: 2
name: Lead reviewed result
inputs: {}
roles:
  implement:
    kind: agent
    uses: [implementer]
    isolate: true
    grant: edit
    independentOf: []
  review:
    kind: agent
    uses: [code-reviewer]
    grant: read
    independentOf: [implement]
  accept:
    kind: person
    outcomes: [accepted, declined]
complete: { accept: [accepted, declined] }
seed:
  role: implement
  title: Implement the approved goal
  detail: Commit the change and run the project's declared required checks. Never publish, merge, delete or wrap the Goal.
rules:
  - id: check-and-review
    on: implement
    when: { every: [committed] }
    then:
      role: review
      title: Check and review the committed result
      detail: Inspect the required check evidence and committed revision independently. Record a structured review and all blocking findings. Missing checks are not approval.
  - id: repair
    on: review
    when: { any: [request-changes] }
    then:
      role: implement
      title: Repair the blocking findings and rerun required checks
  - id: person-acceptance
    on: review
    when: { every: [approve], evidence: [{ review: approve }] }
    then:
      role: accept
      title: Accept or decline the reviewed result
      detail: Acceptance records your decision only. Publishing, merging, deleting and wrapping remain separate actions.
messaging: board-only
budget: { rounds: 10, without-progress: 2 }
wait: 240
`
/** Preserve the exact frozen recipe bytes for journals and running recipe-1 plans. */
export const leadReviewedResultSource = legacyLeadReviewedResultSource
  .replace('Missing checks are not approval.', 'Missing checks are not approval. Approve only on evidence you saw; if you could not verify something, say request-changes and name it.')
  .replace('      title: Repair the blocking findings and rerun required checks', '      title: Repair the blocking findings and rerun required checks\n      detail: Fix only the failed assertions listed; leave the passed ones. Re-run only the failed and errored checks.')
export const leadReviewedResultSourceFor = (revision: string): string | null =>
  revision === 'recipe-1' ? legacyLeadReviewedResultSource : revision === 'recipe-2' ? leadReviewedResultSource : null
export const LEAD_REVIEWED_RESULT = Object.freeze({ id: 'lead-reviewed-result', revision: 'recipe-2', source: leadReviewedResultSource,
  outcomes: Object.freeze(['accepted', 'declined'] as const) })
