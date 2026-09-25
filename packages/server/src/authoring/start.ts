import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'

import type {
  FlowPreview,
  FlowProblem,
  FlowStartTarget,
  FrontDoorPreview,
  FrontDoorPreviewInput,
  GoalView,
  ShapeBindingValue,
  StartContext,
} from '@harnessdesk/protocol'

import { CHANGED_PREVIEW, type FlowPreviews } from '../flow-preview.js'
import { parseFlowPolicy } from '../flow-policy.js'
import { REVIEW_OWN_GOAL } from '../flow-execution.js'
import { GOAL_TAKEN } from '../goals/operations.js'
import { isRevisionName } from '../git-revision.js'
import { readShapeLayout } from './model.js'

/**
 * A front-door start: what it is about, resolved on the host, and the phase-6
 * dry run bound to it.
 *
 * A branch, a pull request, a diff or a working tree arrives as an input to
 * resolve, never as a fact: a branch name to its commit, a pull request number
 * to its head and base through the person's own forge client in that project,
 * a diff's two ends to complete commit ids, a working tree to a bounded digest
 * of what is uncommitted in it. Git and the forge are run with argument
 * vectors, never a shell, and nothing here follows a URL or builds a command
 * from input text.
 *
 * The preview it mints is strict: every Seat must hold its ceiling, and the
 * token binds the target's facts and the reused Goal's revision beside the
 * text. `flow/start-goal` re-resolves the target before it consumes it, so a
 * branch that moved, a diff that changed or a Goal that took work needs a new
 * preview. A working tree is never a committed head: its `head` is null and
 * it says so.
 */

/** Everything a target resolved to; its canonical JSON is what a token binds. */
export interface TargetFacts {
  readonly kind: StartContext['kind']
  readonly label: string
  readonly branch: string | null
  readonly pr: number | null
  readonly base: string | null
  readonly head: string | null
  /** A sha256 of the diff's bytes (and, for a working tree, its untracked files' contents), or null. */
  readonly diff: string | null
  readonly dirty: boolean
}

export interface ContextPort {
  /** Git in `root`, as one argument vector. Throws when git exits non-zero. */
  git(root: string, args: readonly string[]): Promise<string>
  /** A pull request in the project, read through the person's own forge client; null when there is none. */
  pullRequest(root: string, number: number): Promise<{ readonly head: string; readonly base: string; readonly headRef: string } | null>
}

export interface FrontDoorPort {
  /** Refuses a folder that is not open here. */
  confine(root: string): Promise<void>
  readonly context: ContextPort
  readonly previews: Pick<FlowPreviews, 'preview'>
  /** The Goal as it stands now, or a refusal. */
  goal(id: string): Promise<GoalView>
  /** Whether this Goal is ready to take work (open, dependencies wrapped, no unfinished operation). */
  canDispatch(id: string): { ok: true } | { ok: false; reason: string }
  /** Whether an existing Goal is already reserved for a run. */
  reserved(id: string): boolean
}

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const UNTRACKED_LIMIT = 1000

const digest = (...parts: readonly string[]): string => {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(`${Buffer.byteLength(part)}:`).update(part)
  return hash.digest('hex')
}

/** A single revision, never an option or a range; then git's own verdict on it as one commit. */
const commitOf = async (port: ContextPort, root: string, revision: string): Promise<string> => {
  if (!isRevisionName(revision)) throw new Error(`“${revision}” is not one revision name.`)
  let out: string
  try {
    out = (await port.git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`])).trim()
  } catch {
    throw new Error(`There is no commit “${revision}” in this project.`)
  }
  if (!FULL_SHA.test(out)) throw new Error(`There is no commit “${revision}” in this project.`)
  return out
}

const short = (sha: string): string => sha.slice(0, 8)

/** The facts one start context resolves to, read now. `root` is already confined. */
export async function resolveContext(port: ContextPort, context: StartContext): Promise<TargetFacts> {
  const root = context.root
  switch (context.kind) {
    case 'project':
      return { kind: 'project', label: 'this project', branch: null, pr: null, base: null, head: null, diff: null, dirty: false }
    case 'branch': {
      if (!isRevisionName(context.branch)) throw new Error(`“${context.branch}” is not a branch name.`)
      try {
        await port.git(root, ['check-ref-format', '--branch', context.branch])
      } catch {
        throw new Error(`“${context.branch}” is not a branch name.`)
      }
      const head = await commitOf(port, root, `refs/heads/${context.branch}`).catch(() => {
        throw new Error(`There is no branch “${context.branch}” in this project.`)
      })
      // Its base, when the project says what its default branch is; unknown otherwise, and said so.
      let base: string | null = null
      try {
        const upstream = (await port.git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])).trim()
        if (upstream.startsWith('refs/remotes/') && isRevisionName(upstream)) {
          const merged = (await port.git(root, ['merge-base', '--end-of-options', head, upstream])).trim()
          base = FULL_SHA.test(merged) ? merged : null
        }
      } catch {
        base = null
      }
      return { kind: 'branch', label: `branch ${context.branch}`, branch: context.branch, pr: null, base, head, diff: null, dirty: false }
    }
    case 'pull-request': {
      if (!Number.isSafeInteger(context.number) || context.number < 1) throw new Error('A pull request is named by its number.')
      const pr = await port.pullRequest(root, context.number)
      if (!pr) throw new Error(`There is no pull request #${context.number} in this project.`)
      if (!FULL_SHA.test(pr.head) || !FULL_SHA.test(pr.base)) throw new Error(`Pull request #${context.number} could not be read to its commits.`)
      // Its Seats work at its head, each in a checkout cut from it, so that commit has to be here already.
      if (await commitOf(port, root, pr.head).catch(() => null) !== pr.head) {
        throw new Error(`Pull request #${context.number}’s head commit is not in this project yet. Fetch it, then review it again.`)
      }
      return {
        kind: 'pull-request', label: `pull request #${context.number}`, branch: isRevisionName(pr.headRef) ? pr.headRef : null,
        pr: context.number, base: pr.base, head: pr.head, diff: null, dirty: false,
      }
    }
    case 'diff': {
      const from = await commitOf(port, root, context.from)
      const to = await commitOf(port, root, context.to)
      const bytes = await port.git(root, ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--end-of-options', from, to])
      return { kind: 'diff', label: `changes from ${short(from)} to ${short(to)}`, branch: null, pr: null, base: from, head: to, diff: digest(bytes), dirty: false }
    }
    case 'working-diff': {
      let base: string | null = null
      try {
        base = await commitOf(port, root, 'HEAD')
      } catch {
        base = null
      }
      const tracked = base === null ? '' : await port.git(root, ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--end-of-options', base])
      const status = await port.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
      const untracked = (await port.git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
      if (untracked.length > UNTRACKED_LIMIT) throw new Error(`This working tree has more than ${UNTRACKED_LIMIT} untracked files, so it cannot be reviewed as one snapshot.`)
      const contents = untracked.length === 0 ? '' : await port.git(root, ['hash-object', '--no-filters', '--', ...untracked])
      // Never a committed head: the snapshot is what is on disk now, on top of `base`.
      return {
        kind: 'working-diff', label: 'the working tree (not committed)', branch: null, pr: null, base, head: null,
        diff: digest(tracked, status, untracked.join('\0'), contents), dirty: status.length > 0,
      }
    }
  }
}

/** What a run is handed of its target; null for a plain project, which works where the project is. */
export const startTarget = (facts: TargetFacts): FlowStartTarget | null =>
  facts.kind === 'project'
    ? null
    : { kind: facts.kind, label: facts.label, base: facts.base, head: facts.head, pr: facts.pr, dirty: facts.dirty }

/** The canonical form a token binds: key order fixed. */
export const factsKey = (facts: TargetFacts): string =>
  JSON.stringify([facts.kind, facts.label, facts.branch, facts.pr, facts.base, facts.head, facts.diff, facts.dirty])

/** What one bound input takes from a resolved target; null when this kind of start has none. */
const boundValue = (facts: TargetFacts, value: ShapeBindingValue): string | null => {
  switch (value) {
    case 'branch': return facts.branch
    case 'base': return facts.base
    // A working tree has no committed head to bind: never HEAD in its place.
    case 'head': return facts.head
    case 'pr': return facts.pr === null ? null : String(facts.pr)
    case 'diff': return facts.base !== null && facts.head !== null ? `${facts.base}..${facts.head}` : null
  }
}

const refusedPreview = (flow: FlowPreview, problems: readonly FlowProblem[]): FlowPreview => ({ ...flow, token: null, problems: [...flow.problems, ...problems] })

/** The front door's dry run: context resolved, inputs bound, Goal checked, and the strict phase-6 preview. */
export async function previewStart(port: FrontDoorPort, input: FrontDoorPreviewInput): Promise<FrontDoorPreview> {
  const context = input.context
  await port.confine(context.root)
  const facts = await resolveContext(port.context, context)
  const problems: FlowProblem[] = []
  const parsed = parseFlowPolicy(input.source)
  const policy = parsed.document?.format === 'agents' ? parsed.document.flow : null
  const vars: Record<string, string> = { ...input.vars }
  if (policy) {
    const layout = readShapeLayout(policy)
    for (const issue of layout.issues) problems.push({ level: 'warning', at: issue.at, text: issue.text })
    const front = layout.layout.frontDoor
    if (front?.contexts && !front.contexts.includes(context.kind)) {
      problems.push({ level: 'error', at: 'layout.frontDoor.contexts', text: `This shape does not start from ${facts.label}. Choose a start it names, or edit the shape.` })
    }
    for (const binding of front?.bindings ?? []) {
      /* A fact this start does not have falls back to the input's own
         written default — a branch has no pull request, a working tree no
         committed head — and a shape that wrote none is refused. Either way
         the value is the start's, never typed over. */
      const value = boundValue(facts, binding.value) ?? policy.inputs.find((one) => one.id === binding.input)?.default ?? null
      if (value === null) {
        problems.push({ level: 'error', at: `inputs.${binding.input}`, text: `This shape fills “${binding.input}” from the ${binding.value}, which ${facts.label} does not have.` })
        continue
      }
      if (input.vars[binding.input] !== undefined && input.vars[binding.input] !== value) {
        problems.push({ level: 'error', at: `inputs.${binding.input}`, text: `“${binding.input}” comes from ${facts.label}, so it cannot be typed as something else.` })
        continue
      }
      vars[binding.input] = value
    }
  }
  let goal: FrontDoorPreview['goal'] = null
  if (input.goal && facts.head !== null) {
    // A Goal a person made was never pinned to this commit: a review of it starts its own.
    problems.push({ level: 'error', at: 'goal', text: REVIEW_OWN_GOAL })
  }
  if (input.goal) {
    goal = { id: input.goal.id, revision: input.goal.revision }
    let view: GoalView | null = null
    try {
      view = await port.goal(input.goal.id)
    } catch {
      view = null
    }
    const ready = view ? port.canDispatch(input.goal.id) : { ok: false as const, reason: '' }
    if (!view || view.goal.state !== 'open' || view.goal.root !== context.root || view.goal.revision !== input.goal.revision
      || view.board.intents.length > 0 || view.members.length > 0 || !ready.ok || port.reserved(input.goal.id)) {
      problems.push({ level: 'error', at: 'goal', text: GOAL_TAKEN })
    }
  }
  const flow = await port.previews.preview(context.root, input.source, vars, undefined, {
    requireHeld: true,
    target: { context, facts: factsKey(facts), resolved: startTarget(facts) },
    goal,
  })
  const blocked = problems.some((one) => one.level === 'error')
  /* Decision 6: independence from the author is known only when the author
     is a Seat of this run — a project start whose shape keeps a reviewer
     independent of its own builder. A branch, a pull request or a diff was
     written by somebody outside the run, whose provider nothing here knows. */
  const independence = context.kind === 'project' && policy?.roles.some((role) => role.kind === 'agent' && role.independentOf.length > 0) ? 'known' : 'unknown'
  return {
    flow: blocked || problems.length > 0 ? (blocked ? refusedPreview(flow, problems) : { ...flow, problems: [...flow.problems, ...problems] }) : flow,
    target: { label: facts.label, base: facts.base, head: facts.head, dirty: facts.dirty, independence },
    vars,
    source: input.source,
    sentence: `${policy?.name ?? 'Flow'} — ${facts.label}`,
    goal,
  }
}

// --------------------------------------------------------------- host reads

const exec = (file: string, args: readonly string[], cwd: string, maxBuffer: number): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { cwd, timeout: 20_000, maxBuffer, encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })

/** The host's own git and forge reads, bounded, argument vectors only. */
export const hostContextPort = (gh: (args: readonly string[], cwd: string) => Promise<{ readonly stdout: string; readonly exitCode: number }>): ContextPort => ({
  git: (root, args) => exec('git', ['-C', root, '--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], root, 16 * 1024 * 1024),
  pullRequest: async (root, number) => {
    const read = await gh(['pr', 'view', String(number), '--json', 'number,headRefOid,baseRefOid,headRefName'], root)
    if (read.exitCode !== 0) return null
    try {
      const value = JSON.parse(read.stdout) as { number?: unknown; headRefOid?: unknown; baseRefOid?: unknown; headRefName?: unknown }
      if (value.number !== number || typeof value.headRefOid !== 'string' || typeof value.baseRefOid !== 'string') return null
      return { head: value.headRefOid, base: value.baseRefOid, headRef: typeof value.headRefName === 'string' ? value.headRefName : '' }
    } catch {
      return null
    }
  },
})

export { CHANGED_PREVIEW }
