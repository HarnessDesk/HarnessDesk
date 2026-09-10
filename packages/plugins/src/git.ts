import type { ForgeSeat, HarnessContext, HarnessPlugin } from '@harnessdesk/cordis-host'
import type { ForgeReference, ScopeQuery } from '@harnessdesk/protocol'

/**
 * Git tools, available to every agent.
 *
 * Written against the same API a third-party plugin uses — no privileged path.
 * It declares `shell` because it genuinely spawns `git` and `gh`; routing that
 * through `ctx.shell` rather than importing `child_process` is what keeps the
 * permission model honest for HarnessDesk's own code too.
 *
 * Two halves. The reads — status, diff, log, the chips — have always been
 * here. The `pr_*` and `issue_*` tools are how an agent publishes *through
 * the desk*: they reach GitHub with the person's own `gh`, exactly as the
 * agent's own shell would, and add the two things a shell cannot. The pull
 * request is signed for the seat that wrote it — which agent, on which
 * model, at which effort — in the line the person configured below; and what
 * was published is recorded in the conversation, as the object it is, through
 * `ctx.forge`. Both need the `forge` grant, and both are the desk's part of
 * the job; the forge is `gh`'s.
 */

/** Context is for reading, not for flooding a turn: past this, the tail is the agent's to fetch. */
const CONTEXT_LIMIT = 24_000

const cap = (text: string): string =>
  text.length > CONTEXT_LIMIT
    ? `${text.slice(0, CONTEXT_LIMIT)}\n\n[… ${text.length - CONTEXT_LIMIT} more characters; use the git tools for the rest]`
    : text

/** A number from a tool argument or a setting: a finite number, or a string that reads as one. */
const count = (value: unknown): number | null => {
  const read = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isFinite(read) ? read : null
}

/**
 * The line a pull request ends with, unless the person wrote their own or
 * blanked it. `{seat}` is the agent, its model and its effort as one label;
 * the parts are there for anyone composing a different line.
 */
export const DEFAULT_SIGNATURE = '🤖 Generated with [HarnessDesk](https://harnessdesk.app) ({seat})'

/** The line a review opens with; same placeholders, same blank-means-none. */
export const DEFAULT_REVIEW_SIGNATURE = '**Review by {seat} · via HarnessDesk**'

/**
 * A HarnessDesk signature as a body's last line — and only there. A body
 * that quotes the line somewhere in its prose keeps it: the desk replaces
 * what it wrote, never what the author wrote about it.
 */
const SIGNED_BEFORE = /(?:^|\n)🤖 Generated with \[HarnessDesk\]\([^)]*\)[^\n]*$/

/** How much of a body the transcript card is given: the opening, as the forge holds it. */
const EXCERPT_LIMIT = 600

interface GitConfig {
  branchContext?: boolean
  logLimit?: number
  signature?: string
  reviewSignature?: string
}

/**
 * A template with the seat's parts filled in. A part that resolves to
 * nothing takes its separator with it — an agent with no effort control
 * signs "Codex GPT-5.4", never "Codex GPT-5.4 · " — and a template left
 * blank is no signature at all.
 */
export const renderSignature = (template: string, seat: ForgeSeat): string => {
  const parts: Record<string, string> = {
    seat: seat.label,
    agent: seat.agent,
    model: seat.model ?? '',
    effort: seat.effort ?? '',
    version: seat.version ?? '',
  }
  const filled = template.replace(/\{(seat|agent|model|effort|version)\}/g, (_match, key: string) => parts[key] ?? '')
  return filled
    .split(' · ')
    .map((part) => part.replace(/\s{2,}/g, ' ').trim())
    .filter((part) => part !== '')
    .join(' · ')
    .trim()
}

/** The body with the signature as its last line, and any earlier HarnessDesk line gone. */
export const signBody = (body: string, signature: string | null): string => {
  const stripped = body.replace(/\s+$/, '').replace(SIGNED_BEFORE, '').replace(/\s+$/, '')
  if (signature === null || signature === '') return stripped
  return stripped === '' ? signature : `${stripped}\n\n${signature}`
}

/** GitHub's own JSON for a pull request, in the fields the tools read. */
interface GhPullRequest {
  number: number
  title: string
  state: 'OPEN' | 'MERGED' | 'CLOSED' | string
  isDraft?: boolean
  url: string
  author?: { login?: string } | null
  additions?: number
  deletions?: number
  changedFiles?: number
  body?: string | null
  headRefName?: string
  baseRefName?: string
}

interface GhIssue {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED' | string
  url: string
  author?: { login?: string } | null
  body?: string | null
  labels?: readonly { name?: string }[]
  comments?: readonly { author?: { login?: string } | null; body?: string; createdAt?: string }[]
}

const PR_FIELDS = 'number,title,state,isDraft,url,author,additions,deletions,changedFiles,body,headRefName,baseRefName'
const ISSUE_FIELDS = 'number,title,state,url,author,body,labels,comments'

const stateOf = (pr: GhPullRequest): ForgeReference['state'] =>
  pr.isDraft ? 'draft' : pr.state === 'OPEN' ? 'open' : pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : null

/** `owner/name`, read off the URL GitHub gave — no second call for a fact the first already carried. */
const repoOf = (url: string): string => {
  const found = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/(?:pull|issues)\/\d+/.exec(url)
  return found?.[1] ?? ''
}

const excerptOf = (body: string | null | undefined): string | null => {
  const text = (body ?? '').trim()
  if (text === '') return null
  return text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT).trimEnd()}…` : text
}

/** `gh`'s failures in a person's words, since the agent will repeat them to one. */
const ghFailure = (args: readonly string[], said: string): string => {
  const line = said.trim().split('\n').find((entry) => entry.trim() !== '') ?? ''
  if (/ENOENT|spawn gh|command not found/i.test(said)) {
    return 'gh is not installed, or not on the PATH HarnessDesk was started with. Install GitHub CLI and run `gh auth login`.'
  }
  if (/not logged in|not logged into|gh auth login|HTTP 401/i.test(said)) {
    return 'gh is not signed in. Run `gh auth login` in a terminal, then try again.'
  }
  return line || `gh ${args[0] ?? ''} ${args[1] ?? ''} failed.`
}

const text = { type: 'string' } as const

export const gitPlugin: HarnessPlugin = {
  manifest: {
    id: 'git',
    name: 'Git',
    description:
      'Git tools: status, diff, log and branch context; pull requests, reviews and issues on GitHub through gh, signed for the conversation and recorded in it.',
    permissions: { workspace: { read: true, write: false }, shell: true, forge: true },
    configSchema: {
      type: 'object',
      properties: {
        branchContext: {
          type: 'boolean',
          title: 'Tell the agent the current branch',
          description: 'Adds the branch name to every turn as context.',
          default: true,
        },
        logLimit: {
          type: 'number',
          title: 'Commits to show by default',
        },
        signature: {
          type: 'string',
          title: 'Pull request signature',
          description:
            'Ends every pull request an agent opens or edits from a conversation. {seat} is the agent, its model and its effort; {agent}, {model}, {effort} and {version} are the parts. Leave empty to sign nothing.',
          default: DEFAULT_SIGNATURE,
        },
        reviewSignature: {
          type: 'string',
          title: 'Review signature',
          description: 'Opens every review an agent posts from a conversation. Same placeholders; leave empty for none.',
          default: DEFAULT_REVIEW_SIGNATURE,
        },
      },
    },
  },
  plugin: {
    name: 'git',
    inject: ['tools', 'context', 'shell', 'workspace', 'forge'],
    apply(ctx: HarnessContext, config: GitConfig) {
      const git = async (args: readonly string[]): Promise<string> => {
        if (!ctx.workspace.root) throw new Error('No workspace is open.')
        const result = await ctx.shell.run('git', args)
        if (result.exitCode !== 0 && !result.stdout) {
          throw new Error(result.stderr.trim() || `git ${args[0]} failed`)
        }
        return result.stdout.trim()
      }

      // gh uses the person's own login; HarnessDesk holds no token. A
      // minute, because a create waits on GitHub and the person's network.
      const gh = async (args: readonly string[]): Promise<string> => {
        if (!ctx.workspace.root) throw new Error('No workspace is open.')
        const result = await ctx.shell.run('gh', args, { timeoutMs: 60_000 })
        if (result.exitCode !== 0) throw new Error(ghFailure(args, `${result.stderr}\n${result.stdout}`))
        return result.stdout.trim()
      }

      const viewPullRequest = async (selector: string): Promise<GhPullRequest> =>
        JSON.parse(await gh(['pr', 'view', selector, '--json', PR_FIELDS])) as GhPullRequest

      /** The pull request a call names, or the one for the current branch when it names none. */
      const selectorOf = (number: unknown): string =>
        typeof number === 'number' && Number.isFinite(number) && number > 0
          ? String(number)
          : typeof number === 'string' && number.trim() !== ''
            ? number.trim().replace(/^#/, '')
            : ''

      const pullRequestFor = async (number: unknown): Promise<GhPullRequest> => {
        const selector = selectorOf(number)
        if (selector !== '') return viewPullRequest(selector)
        try {
          return await viewPullRequest('')
        } catch (error) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)} — no pull request number was given, and the current branch has none open.`,
          )
        }
      }

      /**
       * The seat this call is made from, or null when the desk cannot say —
       * a call with no conversation behind it, or a host with no forge plane.
       * Null signs nothing: an invented seat would be a false signature.
       */
      const seatFor = async (scope: ScopeQuery): Promise<ForgeSeat | null> => {
        try {
          return await ctx.forge.seat(scope)
        } catch {
          return null
        }
      }

      const signatureFor = (seat: ForgeSeat | null, template: string | undefined, fallback: string): string | null => {
        if (seat === null) return null
        const chosen = template === undefined ? fallback : template
        const rendered = renderSignature(chosen, seat)
        return rendered === '' ? null : rendered
      }

      const viaOf = async (): Promise<ForgeReference['via']> => {
        try {
          return (await ctx.forge.identity()).via
        } catch {
          return 'gh'
        }
      }

      const referenceOf = (
        pr: GhPullRequest,
        fields: Pick<ForgeReference, 'kind' | 'action' | 'via'> & { url?: string; signature?: string | null },
      ): ForgeReference => ({
        kind: fields.kind,
        action: fields.action,
        repo: repoOf(pr.url),
        number: pr.number,
        url: fields.url ?? pr.url,
        title: pr.title ?? null,
        state: stateOf(pr),
        author: pr.author?.login ?? null,
        additions: typeof pr.additions === 'number' ? pr.additions : null,
        deletions: typeof pr.deletions === 'number' ? pr.deletions : null,
        files: typeof pr.changedFiles === 'number' ? pr.changedFiles : null,
        excerpt: excerptOf(pr.body),
        via: fields.via,
        signature: fields.signature ?? null,
      })

      /**
       * The record, made after the forge has the thing. A record that could
       * not be written is a note on the result, never a failure: the pull
       * request exists, and telling the agent otherwise would have it open
       * another.
       */
      const publish = async (reference: ForgeReference, scope: ScopeQuery): Promise<string | null> => {
        try {
          await ctx.forge.publish(reference, scope)
          return null
        } catch (error) {
          return `(Not recorded in the conversation: ${error instanceof Error ? error.message : String(error)})`
        }
      }

      const seatNote = (seat: ForgeSeat | null, signature: string | null): string =>
        signature !== null
          ? `Signed for ${seat?.label ?? 'this seat'}.`
          : seat === null
            ? 'Unsigned: the desk could not tell which conversation made this call.'
            : 'Unsigned: the signature is switched off in the Git plugin’s settings.'

      const describePullRequest = (pr: GhPullRequest): string => {
        const state = stateOf(pr)
        const head = [
          `#${pr.number} ${pr.title}`,
          `${state ?? pr.state.toLowerCase()} · ${repoOf(pr.url)}`,
          [
            pr.author?.login ? `${pr.author.login} wants to merge` : 'merges',
            pr.headRefName ? `${pr.headRefName} into ${pr.baseRefName ?? '?'}` : '',
            typeof pr.additions === 'number' ? `· +${pr.additions} −${pr.deletions ?? 0}` : '',
            typeof pr.changedFiles === 'number' ? `· ${pr.changedFiles} file${pr.changedFiles === 1 ? '' : 's'}` : '',
          ]
            .filter((part) => part !== '')
            .join(' '),
          pr.url,
        ].join('\n')
        const body = (pr.body ?? '').trim()
        return body === '' ? head : `${head}\n\n${body}`
      }

      ctx.tools.register({
        name: 'git_status',
        description: 'Show the working tree status of the open workspace.',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => (await git(['status', '--short', '--branch'])) || 'clean',
      })

      ctx.tools.register({
        name: 'git_diff',
        description: 'Show uncommitted changes, optionally limited to one path.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Limit the diff to this path.' },
            staged: { type: 'boolean', description: 'Show staged changes instead.' },
          },
        },
        execute: async (args: { path?: string; staged?: boolean }) => {
          const argv = ['diff', '--no-color']
          if (args?.staged) argv.push('--cached')
          if (args?.path) argv.push('--', args.path)
          return (await git(argv)) || 'no changes'
        },
      })

      ctx.tools.register({
        name: 'git_log',
        description: 'Show recent commits.',
        inputSchema: {
          type: 'object',
          properties: { limit: { type: 'number', description: 'How many commits (default 20).' } },
        },
        execute: async (args: { limit?: unknown }) => {
          /* A limit that is not a number survived `??`, which stops only null
             and undefined, and Math.max and Math.min both answer NaN for it —
             so git was asked for `-NaN` commits and refused. The schema says
             number; an agent is free to send a string anyway. So the first of
             the asked limit, the configured one and 20 that reads as a number
             wins, and a fraction is cut to the whole commits under it. #97. */
          const limit = Math.min(Math.max(Math.trunc(count(args?.limit) ?? count(config?.logLimit) ?? 20), 1), 200)
          return git(['log', `-${limit}`, '--oneline', '--no-color'])
        },
      })

      // ------------------------------------------------------- the forge

      ctx.tools.register({
        name: 'pr_create',
        description:
          'Open a pull request on GitHub for the current branch, through HarnessDesk. The branch must already be pushed to its remote — this never pushes, and says what to run when it is not. The description is signed for this conversation’s seat (agent, model, effort) by the desk; do not add a signature or a “Generated with” line of your own. Use this rather than `gh pr create`: the pull request is then recorded in the conversation.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'The pull request title.' },
            body: { type: 'string', description: 'The description, in GitHub Markdown. Do not hard-wrap prose; GitHub renders every newline.' },
            base: { type: 'string', description: 'The branch to merge into. Defaults to the repository’s default branch.' },
            draft: { type: 'boolean', description: 'Open it as a draft.' },
          },
          required: ['title', 'body'],
        },
        execute: async (args: { title: string; body: string; base?: string; draft?: boolean }, scope) => {
          const title = String(args.title ?? '').trim()
          const body = String(args.body ?? '')
          if (title === '') throw new Error('A pull request needs a title.')
          const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
          if (branch === 'HEAD') throw new Error('The workspace is on a detached HEAD; check out a branch first.')
          const upstream = await ctx.shell.run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
          if (upstream.exitCode !== 0) {
            throw new Error(
              `Branch ${branch} has not been pushed. Push it first — \`git push -u origin ${branch}\` — then call pr_create again; this tool never pushes.`,
            )
          }
          const unpushed = await git(['rev-list', '--count', '@{u}..HEAD'])
          if (unpushed !== '0') {
            throw new Error(
              `${unpushed} commit${unpushed === '1' ? ' is' : 's are'} not pushed yet. Run \`git push\`, then call pr_create again; this tool never pushes.`,
            )
          }
          const existing = JSON.parse(
            await gh(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url']),
          ) as readonly { number: number; url: string }[]
          if (existing.length > 0 && existing[0]) {
            throw new Error(
              `Pull request #${existing[0].number} is already open for ${branch}: ${existing[0].url}. Use pr_update to change it.`,
            )
          }
          const seat = await seatFor(scope)
          const signature = signatureFor(seat, config?.signature, DEFAULT_SIGNATURE)
          const argv = ['pr', 'create', '--head', branch, '--title', title, '--body', signBody(body, signature)]
          if (typeof args.base === 'string' && args.base.trim() !== '') argv.push('--base', args.base.trim())
          if (args.draft === true) argv.push('--draft')
          const created = await gh(argv)
          const url = created.split('\n').map((line) => line.trim()).find((line) => /^https?:\/\//.test(line)) ?? ''
          const pr = await viewPullRequest(url || branch)
          const note = await publish(
            referenceOf(pr, { kind: 'pullRequest', action: 'opened', via: await viaOf(), signature }),
            scope,
          )
          return [`Opened pull request #${pr.number}: ${pr.title}`, pr.url, seatNote(seat, signature), note]
            .filter((line) => line !== null && line !== '')
            .join('\n')
        },
      })

      ctx.tools.register({
        name: 'pr_update',
        description:
          'Change a pull request’s title, description or base branch, through HarnessDesk. A new description is signed for this conversation’s seat, replacing any earlier HarnessDesk line; do not write one yourself. Names the pull request by number, or takes the one open for the current branch.',
        inputSchema: {
          type: 'object',
          properties: {
            number: { type: 'number', description: 'The pull request number. Omit for the current branch’s.' },
            title: text,
            body: { type: 'string', description: 'The whole new description, in GitHub Markdown.' },
            base: { type: 'string', description: 'A new base branch.' },
          },
        },
        execute: async (args: { number?: number; title?: string; body?: string; base?: string }, scope) => {
          const current = await pullRequestFor(args.number)
          const seat = await seatFor(scope)
          const signature = signatureFor(seat, config?.signature, DEFAULT_SIGNATURE)
          const argv = ['pr', 'edit', String(current.number)]
          let changed = 0
          if (typeof args.title === 'string' && args.title.trim() !== '') {
            argv.push('--title', args.title.trim())
            changed += 1
          }
          if (typeof args.body === 'string') {
            argv.push('--body', signBody(args.body, signature))
            changed += 1
          }
          if (typeof args.base === 'string' && args.base.trim() !== '') {
            argv.push('--base', args.base.trim())
            changed += 1
          }
          if (changed === 0) throw new Error('Nothing to change: give a title, a body or a base.')
          await gh(argv)
          const pr = await viewPullRequest(String(current.number))
          const note = await publish(
            referenceOf(pr, {
              kind: 'pullRequest',
              action: 'updated',
              via: await viaOf(),
              signature: typeof args.body === 'string' ? signature : null,
            }),
            scope,
          )
          return [
            `Updated pull request #${pr.number}: ${pr.title}`,
            pr.url,
            typeof args.body === 'string' ? seatNote(seat, signature) : null,
            note,
          ]
            .filter((line) => line !== null && line !== '')
            .join('\n')
        },
      })

      ctx.tools.register({
        name: 'pr_review',
        description:
          'Post a review on a pull request — approve, request changes, or comment — through HarnessDesk. The review opens with a line naming this conversation’s seat; do not add one. Names the pull request by number, or takes the one open for the current branch.',
        inputSchema: {
          type: 'object',
          properties: {
            number: { type: 'number', description: 'The pull request number. Omit for the current branch’s.' },
            event: { type: 'string', enum: ['approve', 'request_changes', 'comment'], description: 'The verdict.' },
            body: { type: 'string', description: 'The review, in GitHub Markdown.' },
          },
          required: ['event', 'body'],
        },
        execute: async (args: { number?: number; event: string; body: string }, scope) => {
          const flag =
            args.event === 'approve'
              ? '--approve'
              : args.event === 'request_changes'
                ? '--request-changes'
                : args.event === 'comment'
                  ? '--comment'
                  : null
          if (flag === null) throw new Error('event must be approve, request_changes or comment.')
          const body = String(args.body ?? '').trim()
          if (body === '' && flag !== '--approve') throw new Error('A review that is not an approval needs a body.')
          const pr = await pullRequestFor(args.number)
          const seat = await seatFor(scope)
          const signature = signatureFor(seat, config?.reviewSignature, DEFAULT_REVIEW_SIGNATURE)
          const signed = signature === null ? body : body === '' ? signature : `${signature}\n\n${body}`
          await gh(['pr', 'review', String(pr.number), flag, '--body', signed])
          // `gh pr review` prints no address for what it posted; the API knows.
          let url = pr.url
          try {
            const last = await gh(['api', `repos/${repoOf(pr.url)}/pulls/${pr.number}/reviews`, '--jq', '.[-1].html_url'])
            if (/^https?:\/\//.test(last)) url = last
          } catch {
            // The pull request's own address is a fine second best.
          }
          const note = await publish(
            referenceOf(pr, { kind: 'review', action: 'posted', via: await viaOf(), url, signature }),
            scope,
          )
          const verdict = args.event === 'approve' ? 'Approved' : args.event === 'request_changes' ? 'Requested changes on' : 'Commented on'
          return [`${verdict} pull request #${pr.number}: ${pr.title}`, url, seatNote(seat, signature), note]
            .filter((line) => line !== null && line !== '')
            .join('\n')
        },
      })

      ctx.tools.register({
        name: 'pr_comment',
        description:
          'Leave a comment on a pull request’s conversation, through HarnessDesk. Comments are not signed. Names the pull request by number, or takes the one open for the current branch.',
        inputSchema: {
          type: 'object',
          properties: {
            number: { type: 'number', description: 'The pull request number. Omit for the current branch’s.' },
            body: { type: 'string', description: 'The comment, in GitHub Markdown.' },
          },
          required: ['body'],
        },
        execute: async (args: { number?: number; body: string }, scope) => {
          const body = String(args.body ?? '').trim()
          if (body === '') throw new Error('A comment needs a body.')
          const pr = await pullRequestFor(args.number)
          const posted = await gh(['pr', 'comment', String(pr.number), '--body', body])
          const url = posted.split('\n').map((line) => line.trim()).find((line) => /^https?:\/\//.test(line)) ?? pr.url
          const note = await publish(referenceOf(pr, { kind: 'comment', action: 'posted', via: await viaOf(), url }), scope)
          return [`Commented on pull request #${pr.number}: ${pr.title}`, url, note]
            .filter((line) => line !== null && line !== '')
            .join('\n')
        },
      })

      ctx.tools.register({
        name: 'pr_view',
        description:
          'Read a pull request: title, state, author, branches, size and description. Names it by number, or takes the one open for the current branch.',
        inputSchema: {
          type: 'object',
          properties: { number: { type: 'number', description: 'The pull request number. Omit for the current branch’s.' } },
        },
        execute: async (args: { number?: number }) => cap(describePullRequest(await pullRequestFor(args?.number))),
      })

      ctx.tools.register({
        name: 'pr_checks',
        description: 'The CI checks on a pull request, each with its state and link. Names it by number, or takes the one open for the current branch.',
        inputSchema: {
          type: 'object',
          properties: { number: { type: 'number', description: 'The pull request number. Omit for the current branch’s.' } },
        },
        execute: async (args: { number?: number }) => {
          const pr = await pullRequestFor(args?.number)
          // `gh pr checks` exits non-zero when a check failed; the list is
          // still the answer, so the exit code is read only when there is none.
          const result = await ctx.shell.run(
            'gh',
            ['pr', 'checks', String(pr.number), '--json', 'name,state,bucket,link,workflow'],
            { timeoutMs: 60_000 },
          )
          const raw = result.stdout.trim()
          if (raw === '' && result.exitCode !== 0) {
            throw new Error(ghFailure(['pr', 'checks'], `${result.stderr}\n${result.stdout}`))
          }
          const checks = raw === '' ? [] : (JSON.parse(raw) as readonly { name?: string; state?: string; bucket?: string; link?: string; workflow?: string }[])
          if (checks.length === 0) return `No checks on pull request #${pr.number}.`
          const mark = (bucket: string | undefined, state: string | undefined): string =>
            bucket === 'pass' ? '✓' : bucket === 'fail' ? '✗' : bucket === 'pending' ? '…' : bucket === 'skipping' ? '–' : (state ?? '?')
          return [
            `Checks on pull request #${pr.number}:`,
            ...checks.map(
              (check) =>
                `${mark(check.bucket, check.state)} ${check.name ?? '?'}${check.workflow ? ` (${check.workflow})` : ''}${check.link ? ` ${check.link}` : ''}`,
            ),
          ].join('\n')
        },
      })

      ctx.tools.register({
        name: 'issue_view',
        description: 'Read a GitHub issue: title, state, labels, body and discussion.',
        inputSchema: {
          type: 'object',
          properties: { number: { type: 'number', description: 'The issue number.' } },
          required: ['number'],
        },
        execute: async (args: { number: number }) => {
          const selector = selectorOf(args?.number)
          if (selector === '') throw new Error('Which issue? Give its number.')
          const issue = JSON.parse(await gh(['issue', 'view', selector, '--json', ISSUE_FIELDS])) as GhIssue
          const labels = (issue.labels ?? []).map((label) => label.name).filter((name): name is string => Boolean(name))
          const head = [
            `#${issue.number} ${issue.title}`,
            `${issue.state.toLowerCase()} · ${repoOf(issue.url)}${issue.author?.login ? ` · opened by ${issue.author.login}` : ''}${labels.length > 0 ? ` · ${labels.join(', ')}` : ''}`,
            issue.url,
          ].join('\n')
          const body = (issue.body ?? '').trim()
          const discussion = (issue.comments ?? [])
            .map((comment) => `${comment.author?.login ?? 'someone'}${comment.createdAt ? ` (${comment.createdAt})` : ''}:\n${(comment.body ?? '').trim()}`)
            .join('\n\n')
          return cap([head, body, discussion === '' ? '' : `Discussion:\n${discussion}`].filter((part) => part !== '').join('\n\n'))
        },
      })

      ctx.tools.register({
        name: 'issue_comment',
        description: 'Leave a comment on a GitHub issue, through HarnessDesk. Comments are not signed.',
        inputSchema: {
          type: 'object',
          properties: {
            number: { type: 'number', description: 'The issue number.' },
            body: { type: 'string', description: 'The comment, in GitHub Markdown.' },
          },
          required: ['number', 'body'],
        },
        execute: async (args: { number: number; body: string }, scope) => {
          const selector = selectorOf(args?.number)
          if (selector === '') throw new Error('Which issue? Give its number.')
          const body = String(args.body ?? '').trim()
          if (body === '') throw new Error('A comment needs a body.')
          const issue = JSON.parse(await gh(['issue', 'view', selector, '--json', 'number,title,state,url,author'])) as GhIssue
          const posted = await gh(['issue', 'comment', String(issue.number), '--body', body])
          const url = posted.split('\n').map((line) => line.trim()).find((line) => /^https?:\/\//.test(line)) ?? issue.url
          const note = await publish(
            {
              kind: 'comment',
              action: 'posted',
              repo: repoOf(issue.url),
              number: issue.number,
              url,
              title: issue.title ?? null,
              state: issue.state === 'OPEN' ? 'open' : issue.state === 'CLOSED' ? 'closed' : null,
              author: issue.author?.login ?? null,
              additions: null,
              deletions: null,
              files: null,
              excerpt: excerptOf(body),
              via: await viaOf(),
              signature: null,
            },
            scope,
          )
          return [`Commented on issue #${issue.number}: ${issue.title}`, url, note]
            .filter((line) => line !== null && line !== '')
            .join('\n')
        },
      })

      // Chips: context the user attaches on purpose (docs/extending.md).
      // "Write the commit message", "review what I did", "why does this fail"
      // all start with the working tree; pasting it was the chore.
      ctx.context.register({
        label: 'Uncommitted changes',
        form: 'resource',
        chip: { description: 'The working tree: status, unstaged and staged diffs.' },
        resolve: async () => {
          const status = await git(['status', '--short', '--branch'])
          const unstaged = await git(['diff', '--no-color'])
          const staged = await git(['diff', '--no-color', '--cached'])
          const parts = [`Status:\n${status || 'clean'}`]
          if (unstaged) parts.push(`Unstaged changes:\n${unstaged}`)
          if (staged) parts.push(`Staged changes:\n${staged}`)
          return cap(parts.join('\n\n'))
        },
      })

      // "Do this issue" and "review this PR" are the two most common ways a
      // task starts. gh uses the user's own login; HarnessDesk holds no token.
      ctx.context.register({
        label: 'GitHub issue or PR',
        form: 'resource',
        chip: {
          description: 'Title, body and discussion of an issue or pull request, through gh.',
          prompt: 'Issue or PR URL, or #123',
          /* The URL only, on purpose. `match` is what turns a *paste* into
             this chip, and a bare `#123` pasted on its own is as often a colour
             — a grey such as `#333333` copied from a design tool, pasted into
             a sentence — as an issue: it would leave the message and become a
             chip that cannot resolve. The shorthand belongs to the prompt,
             which says so: typed there, `#123` is the reference and resolves
             below. #52 asked for it here; this is why it is not. */
          match: String.raw`https?://github\.com/[^/\s]+/[^/\s]+/(?:issues|pull)/\d+`,
        },
        resolve: async (_scope, ref) => {
          const target = (ref ?? '').trim()
          if (!target) throw new Error('Which issue or pull request? Give a URL or a number.')
          const kinds = target.includes('/pull/') ? ['pr'] : target.includes('/issues/') ? ['issue'] : ['issue', 'pr']
          let lastError: unknown = null
          for (const kind of kinds) {
            try {
              const number = target.replace(/^#/, '')
              // `view` gives the item — title, state, author, body; `--comments`
              // gives only the discussion. Both, in that order, capped as one.
              const item = await gh([kind, 'view', number])
              let comments = ''
              try {
                comments = await gh([kind, 'view', number, '--comments'])
              } catch {
                // A discussion that will not load is not a reason to lose the item.
              }
              const sections = [`${kind === 'pr' ? 'Pull request' : 'Issue'} ${target}`, item]
              if (comments.trim()) sections.push(`Discussion:\n${comments}`)
              return cap(sections.join('\n\n'))
            } catch (error) {
              lastError = error
            }
          }
          throw lastError instanceof Error ? lastError : new Error(`Could not read ${target}.`)
        },
      })

      // The branch is small, stable, and almost always relevant, so it is
      // context rather than something the agent must spend a tool call on.
      if (config?.branchContext === false) return

      ctx.context.register({
        label: 'Git',
        resolve: async () => {
          if (!ctx.workspace.root) return ''
          try {
            return `The workspace is on git branch \`${await git(['rev-parse', '--abbrev-ref', 'HEAD'])}\`.`
          } catch {
            return ''
          }
        },
      })
    },
  },
}
