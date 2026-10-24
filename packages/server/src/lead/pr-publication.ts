import { DEFAULT_SIGNATURE, deskMarked, renderSignature, signDescription, unmarked, type GhPullRequest } from '@harnessdesk/plugins'
import { leadPlanRuns, leadPublicationEvidenceRevision, type LeadAcceptanceEvidence, type LeadJournal, type LeadPublicationSource } from '@harnessdesk/lead'
import type { ForgeReference, LeadProject, SeatRecord } from '@harnessdesk/protocol'
import type { ForgePlane } from '../forge.js'
import type { GitGateway, GitTarget } from '../git-gateway/index.js'
import { repositoryOf } from '../findings/publication.js'
import { verifyPublicationSource, type LeadPrCandidate, type LeadPrFollowOptions } from './pr-follow.js'

interface PublicationPorts {
  readonly journal: LeadJournal
  readonly gateway: GitGateway
  readonly project: LeadProject
  readonly forge: Pick<ForgePlane, 'publicationAllowed' | 'seat' | 'identity' | 'publish'>
  readonly seats: () => readonly SeatRecord[]
  readonly evidence: (runId: string) => Promise<LeadAcceptanceEvidence>
  readonly publications: (source: LeadPublicationSource) => Promise<readonly ForgeReference[]>
  readonly signature: () => string | undefined
}
/** Lead policy and signature adapter over the shared host gateway; no write capability enters the worker's tool set. */
export const leadPublicationPorts = (port: PublicationPorts): Pick<LeadPrFollowOptions, 'source' | 'find' | 'create'> => {
  const target = (source: LeadPublicationSource): GitTarget => ({ repository: source.repository, branch: source.branch, sha: source.head,
    previousSha: port.journal.state.pr?.head ?? null, requester: { kind: 'lead-goal', id: port.journal.state.budget!.logicalGoalId } })
  const allowed = async (source: LeadPublicationSource) => {
    const result = await port.forge.publicationAllowed(source)
    if (!result.ok) throw new Error('lead-publication-embargoed')
  }
  const candidate = (pr: { number: number; headRefName?: string; headRefOid?: string; url: string }): LeadPrCandidate => {
    const repository = repositoryOf(pr.url, pr.number)
    if (!repository || !pr.headRefName || !/^[a-f0-9]{40,64}$/.test(pr.headRefOid ?? '')) throw new Error('lead-publication-pr-unverifiable')
    return { repository, number: pr.number, branch: pr.headRefName, head: pr.headRefOid! }
  }
  const verifiedCandidate = async (source: LeadPublicationSource, row: Parameters<typeof candidate>[0]) => {
    const pr = candidate(row)
    const live = JSON.parse(await port.gateway.findPullRequest({ ...target(source), number: pr.number })) as {
      number: number; url: string; state: string; headRefName: string; headRefOid: string; isCrossRepository?: boolean; headRepositoryOwner?: { login: string }
    }
    if (live.number !== pr.number || live.state.toLowerCase() !== 'open' || repositoryOf(live.url, live.number) !== source.repository ||
      live.isCrossRepository !== false || live.headRepositoryOwner?.login.toLowerCase() !== source.repository.split('/')[0]!.toLowerCase() ||
      live.headRefName !== source.branch || live.headRefOid !== pr.head) throw new Error('lead-publication-pr-changed')
    return pr
  }
  return {
    source: async (card, contract) => {
      if (contract.project.id !== port.project.id || contract.project.path !== port.project.path) throw new Error('lead-publication-project-changed')
      const runs = leadPlanRuns(port.journal.state)
      const sources: LeadPublicationSource[] = []
      for (const run of runs) {
        const seats = port.seats().filter(seat => !seat.restored && seat.board === run.teamId && seat.role === 'implement' && seat.checkout.project === port.project.path)
          .sort((a, b) => b.openedAt - a.openedAt)
        const seat = seats[0]
        if (!seat?.checkout.branch) throw new Error('lead-publication-worker-missing')
        const evidence = await port.evidence(run.runId), cwd = seat.checkout.cwd
        const [worker, project] = await Promise.all([port.gateway.inspectCheckout(cwd).catch(() => null), port.gateway.inspectCheckout(port.project.path).catch(() => null)])
        if (!worker || !project || worker.commonDir !== project.commonDir) throw new Error('lead-publication-repository-changed')
        const { branch, sha: head } = worker
        if (!branch || branch !== seat.checkout.branch || evidence.revision !== head || !evidence.complete || !evidence.spendComplete)
          throw new Error('lead-publication-evidence-changed')
        if (!contract.publicationRepository) throw new Error('lead-publication-repository-changed')
        const remote = 'origin', remoteUrl = `https://github.com/${contract.publicationRepository}.git`
        if (card.publication === 'push' && (!card.publicationSource || card.publicationSource.runId !== run.runId ||
          card.publicationSource.reviewedHead !== head || card.publicationSource.evidenceRevision !== leadPublicationEvidenceRevision(evidence))) throw new Error('lead-card-stale')
        const repo = await port.gateway.repository(contract.publicationRepository)
        if (repo.nameWithOwner !== contract.publicationRepository || repo.url !== `https://github.com/${contract.publicationRepository}` || !repo.defaultBranchRef?.name)
          throw new Error('lead-publication-repository-changed')
        sources.push({ repository: repo.nameWithOwner, cwd, remote, remoteUrl, defaultBranch: repo.defaultBranchRef.name, branch, head,
          runId: run.runId, teamId: run.teamId, runtime: seat.session.runtime, sessionId: seat.session.sessionId })
      }
      // Publication of a multi-step result needs one unambiguous worker checkout.
      if (sources.length !== 1) throw new Error('lead-publication-workers-conflict')
      await verifyPublicationSource(sources[0]!, port.gateway)
      await allowed(sources[0]!)
      return sources[0]!
    },
    find: async (source, recovering) => {
      await allowed(source)
      const listed = JSON.parse(await port.gateway.findPullRequest(target(source))) as
        { number: number; url: string; headRefName: string; headRefOid: string; body?: string; isCrossRepository?: boolean; headRepositoryOwner?: { login: string } }[]
      if (!Array.isArray(listed)) throw new Error('lead-publication-pr-unverifiable')
      const rows = listed.filter(row => row.isCrossRepository !== true && (!row.headRepositoryOwner || row.headRepositoryOwner.login.toLowerCase() === source.repository.split('/')[0]!.toLowerCase()))
      if (rows.length > 1) throw new Error('lead-publication-pr-unverifiable')
      const publications = await port.publications(source), owned = port.journal.state.pr
      const verified: LeadPrCandidate[] = []
      for (const row of rows) {
        const pr = await verifiedCandidate(source, row)
        if (!(owned && pr.repository === owned.repository && pr.number === owned.number) &&
          !publications.some(ref => ref.kind === 'pullRequest' && ref.action === 'opened' && ref.repo === pr.repository && ref.number === pr.number) &&
          !(recovering && row.body?.includes(`<!-- harnessdesk:lead:${port.journal.state.budget?.logicalGoalId}:${port.journal.state.publication?.id} -->`)))
          throw new Error('lead-publication-unrelated-pr')
        verified.push(pr)
      }
      return verified
    },
    create: async (source, _card, contract) => {
      await verifyPublicationSource(source, port.gateway)
      await allowed(source)
      if (await port.gateway.remoteHead(source.repository, source.branch) !== source.head) throw new Error('lead-publication-remote-head-changed')
      const seat = await port.forge.seat(source), template = port.signature() ?? DEFAULT_SIGNATURE
      if (!seat) throw new Error('lead-publication-seat-unavailable')
      const body = `${deskMarked(signDescription(unmarked(contract.goal), template, seat))}\n\n<!-- harnessdesk:lead:${port.journal.state.budget!.logicalGoalId}:${port.journal.state.publication!.id} -->`
      const url = await port.gateway.createPullRequest({ ...target(source), title: contract.goal.split(/\r?\n/)[0]!.slice(0, 256), body, base: source.defaultBranch })
      const match = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)$/.exec(url)
      if (!match) throw new Error('lead-publication-pr-unverifiable')
      const fresh = JSON.parse(await port.gateway.findPullRequest({ ...target(source), number: Number(match[1]) })) as GhPullRequest & { headRefOid: string }
      const verified = await verifiedCandidate(source, fresh)
      if (verified.repository !== source.repository || verified.branch !== source.branch || verified.head !== source.head) throw new Error('lead-publication-pr-changed')
      const identity = await port.forge.identity(source)
      // A missing transcript receipt never means creation should be retried. Recovery uses the marked PR.
      await port.forge.publish({ kind: 'pullRequest', action: 'opened', repo: verified.repository, number: verified.number, url: fresh.url,
        title: fresh.title, state: 'open', author: fresh.author?.login ?? null, additions: fresh.additions ?? null, deletions: fresh.deletions ?? null,
        files: fresh.changedFiles ?? null, excerpt: fresh.body?.slice(0, 500) ?? null, via: identity.via, signature: template.trim() ? renderSignature(template, seat) || null : null }, source).catch(() => {})
      return verified
    },
  }
}
