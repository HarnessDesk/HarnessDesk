import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createPullRequest, DEFAULT_SIGNATURE, deskMarked, renderSignature, signDescription, unmarked, type GhPullRequest } from '@harnessdesk/plugins'
import { leadPlanRuns, leadPublicationEvidenceRevision, type LeadAcceptanceEvidence, type LeadJournal, type LeadPublicationSource } from '@harnessdesk/lead'
import type { ForgeReference, LeadProject, SeatRecord } from '@harnessdesk/protocol'
import type { ForgePlane } from '../forge.js'
import { shellCheckoutIdentity } from '../worktree.js'
import { HARDENED_GIT_CONFIG, hardenedNetworkGit, rawPushUrl, githubRepositoryFromUrl } from '../git-hardening.js'
import { repositoryOf } from '../findings/publication.js'
import { verifyPublicationSource, type LeadPrCandidate, type LeadPrFollowOptions } from './pr-follow.js'

const run = promisify(execFile)
interface PublicationPorts {
  readonly journal: LeadJournal
  readonly allowLocalFile?: boolean
  readonly project: LeadProject
  readonly forge: Pick<ForgePlane, 'publicationAllowed' | 'seat' | 'identity' | 'publish'>
  readonly seats: () => readonly SeatRecord[]
  readonly evidence: (runId: string) => Promise<LeadAcceptanceEvidence>
  readonly publications: (source: LeadPublicationSource) => Promise<readonly ForgeReference[]>
  readonly signature: () => string | undefined
  readonly gh?: (cwd: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>
}
/** Host adapters around the plugin's create path; none of these capabilities enter Lead's tool set. */
export const leadPublicationPorts = (port: PublicationPorts): Pick<LeadPrFollowOptions, 'source' | 'find' | 'create'> => {
  const gitResult = async (cwd: string, args: readonly string[]) => {
    try {
      const result = await run('git', ['-C', cwd, ...HARDENED_GIT_CONFIG, ...args], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
      return { ...result, exitCode: 0 }
    } catch (error) {
      const result = error as { stdout?: string; stderr?: string; code?: number }
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.code ?? -1 }
    }
  }
  const git = async (cwd: string, args: readonly string[]) => {
    const result = await gitResult(cwd, args)
    if (result.exitCode !== 0) throw new Error('lead-publication-git-unavailable')
    return result.stdout.trim()
  }
  const gh = async (cwd: string, args: readonly string[]) => {
    if (port.gh) {
      const result = await port.gh(cwd, args)
      if (result.exitCode !== 0) throw new Error('lead-publication-forge-unavailable')
      return result.stdout.trim()
    }
    const result = await run('gh', [...args], { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
    return result.stdout.trim()
  }
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
    const live = JSON.parse(await gh(source.cwd, ['api', `repos/${source.repository}/pulls/${pr.number}`])) as {
      number: number; state: string; head: { sha: string; ref: string; repo: { full_name: string } | null }; base: { repo: { full_name: string } }
    }
    if (live.number !== pr.number || live.state !== 'open' || live.head?.repo?.full_name !== source.repository ||
      live.base?.repo?.full_name !== source.repository || live.head.ref !== source.branch || live.head.sha !== pr.head)
      throw new Error('lead-publication-pr-changed')
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
        const [worker, project] = await Promise.all([shellCheckoutIdentity(cwd), shellCheckoutIdentity(port.project.path)])
        if (!worker || !project || worker.gitCommonDir !== project.gitCommonDir) throw new Error('lead-publication-repository-changed')
        const branch = await git(cwd, ['symbolic-ref', '--short', 'HEAD']), head = await git(cwd, ['rev-parse', 'HEAD'])
        if (branch !== seat.checkout.branch || evidence.revision !== head || !evidence.complete || !evidence.spendComplete)
          throw new Error('lead-publication-evidence-changed')
        const remotes = (await git(cwd, ['remote'])).split('\n').filter(Boolean)
        const remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0]! : ''
        if (!remote) throw new Error('lead-publication-remote-unverifiable')
        const configuredUrl = await rawPushUrl(cwd, remote)
        const remoteRepo = githubRepositoryFromUrl(configuredUrl)
        if (!contract.publicationRepository || remoteRepo !== contract.publicationRepository) throw new Error('lead-publication-repository-changed')
        const remoteUrl = configuredUrl.startsWith('https:') ? `https://github.com/${contract.publicationRepository}.git` : `git@github.com:${contract.publicationRepository}.git`
        if (card.publication === 'push' && (!card.publicationSource || card.publicationSource.runId !== run.runId ||
          card.publicationSource.reviewedHead !== head || card.publicationSource.evidenceRevision !== leadPublicationEvidenceRevision(evidence))) throw new Error('lead-card-stale')
        const repo = JSON.parse(await gh(cwd, ['repo', 'view', contract.publicationRepository, '--json', 'nameWithOwner,url,defaultBranchRef'])) as {
          nameWithOwner: string; url: string; defaultBranchRef?: { name?: string }
        }
        if (!remoteRepo || remoteRepo !== repo.nameWithOwner || repo.url !== `https://github.com/${remoteRepo}` || !repo.defaultBranchRef?.name)
          throw new Error('lead-publication-repository-changed')
        sources.push({ repository: repo.nameWithOwner, cwd, remote, remoteUrl, defaultBranch: repo.defaultBranchRef.name, branch, head,
          runId: run.runId, teamId: run.teamId, runtime: seat.session.runtime, sessionId: seat.session.sessionId })
      }
      // Publication of a multi-step result needs one unambiguous worker checkout.
      if (sources.length !== 1) throw new Error('lead-publication-workers-conflict')
      await verifyPublicationSource(sources[0]!)
      await allowed(sources[0]!)
      return sources[0]!
    },
    find: async (source, recovering) => {
      await allowed(source)
      const listed = JSON.parse(await gh(source.cwd, ['pr', 'list', '--repo', source.repository, '--head', source.branch, '--state', 'open', '--json', 'number,url,headRefName,headRefOid,body,isCrossRepository,headRepositoryOwner'])) as
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
      await verifyPublicationSource(source)
      await allowed(source)
      const published = await hardenedNetworkGit(source.cwd, ['ls-remote', '--heads', source.remoteUrl, `refs/heads/${source.branch}`], { allowLocalFile: port.allowLocalFile })
      if (published.split(/\s/)[0] !== source.head) throw new Error('lead-publication-remote-head-changed')
      const seat = await port.forge.seat(source), template = port.signature() ?? DEFAULT_SIGNATURE
      if (!seat) throw new Error('lead-publication-seat-unavailable')
      const read = async (selector: string) => JSON.parse(await gh(source.cwd, ['pr', 'view', selector, '--repo', source.repository, '--json', 'number,title,state,url,body,headRefName,headRefOid'])) as GhPullRequest & { headRefOid: string }
      const publicationGit = async (args: readonly string[]) => {
        const verb = args.findIndex(arg => ['ls-remote', 'fetch', 'push'].includes(arg))
        if (verb < 0) return gitResult(source.cwd, args)
        const command = args.slice(verb).map(arg => arg === source.remote ? source.remoteUrl : arg)
        try { return { stdout: await hardenedNetworkGit(source.cwd, command, { allowLocalFile: port.allowLocalFile }), stderr: '', exitCode: 0 } }
        catch (error) { const result = error as { stdout?: string; stderr?: string; code?: number }; return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.code ?? -1 } }
      }
      const pr = await createPullRequest({ git: async args => { const result = await publicationGit(args); if (result.exitCode !== 0) throw new Error('lead-publication-git-unavailable'); return result.stdout.trim() }, runGit: publicationGit,
        gh: args => gh(source.cwd, [...args, '--repo', source.repository]), viewPullRequest: read, publicationAllowed: () => allowed(source),
        description: async body => `${deskMarked(signDescription(unmarked(body), template, seat))}\n\n<!-- harnessdesk:lead:${port.journal.state.budget!.logicalGoalId}:${port.journal.state.publication!.id} -->`,
      }, { title: contract.goal.split(/\r?\n/)[0]!.slice(0, 256), body: contract.goal })
      const fresh = await read(String(pr.number)), verified = await verifiedCandidate(source, fresh)
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
