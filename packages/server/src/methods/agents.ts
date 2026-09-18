import { confine } from '../workspace.js'
import type { HostContext, MethodsUnder } from './context.js'

/**
 * The Agent roster, read.
 *
 * Reads only. Writing an Agent is editing a file, and the desk has an editor
 * plane for that — a second write path for the same file is a second answer to
 * "what does this Agent say".
 *
 * Neither verb catches. A roster directory that exists and cannot be read
 * fails the call, naming the path and the reason, because a person can act on
 * that and cannot act on a roster that is quietly empty. One `AGENT.md` that
 * cannot be read or parsed is not a failure of the call: it arrives as an
 * entry with no definition and a problem saying why, and goes out as it came.
 */
export const agentMethods = {
  'agent/list': async (ctx, params) => ctx.agents.list(projectOf(ctx, params.project)),
  'agent/read': async (ctx, params) => ctx.agents.read(params.id, projectOf(ctx, params.project)),
} satisfies MethodsUnder<'agent/'>

/**
 * The project a request named, held to the folders opened here.
 *
 * A project's Agents are read from beneath it, and `project` crossed a socket
 * the host trusts nothing from: unconfined, a request could have the host list
 * `.harnessdesk/agents` under any directory on the disk and read what is in it.
 * So it answers to the rule every other path the renderer names answers to —
 * `worktree/create`'s root, a terminal's folder — and what is read is the path
 * that was checked, not the text that arrived.
 *
 * `id` needs no such check while the roster matches it against its own listing
 * and never joins it onto a path. A roster that learned to open one Agent's
 * file directly would have to hold `id` to a single path segment first.
 */
const projectOf = (ctx: HostContext, project: string | undefined): string | undefined =>
  project === undefined ? undefined : confine(project, ctx.workspaces.openRoots())
