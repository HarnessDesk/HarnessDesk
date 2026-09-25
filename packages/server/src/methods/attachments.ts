import { dirname } from 'node:path'

import { digestOf } from '@harnessdesk/agent-inventory'
import type { AgentAttachmentsView, AgentOrigin, AttachmentSupport } from '@harnessdesk/protocol'

import { parseAgentDefinition } from '../agent-def.js'
import { readAgentSource } from '../agent-files.js'
import { attachmentFieldEdit } from '../attachments/edit.js'
import { clearAgentNotes, readAgentNotes } from '../attachments/notes.js'
import { incarnationOf } from '../evidence/seen.js'
import {
  defaultSeatRuntime,
  found,
  listedAgentPath,
  originAgent,
  projectOf,
  unusable,
  staleUpdate,
  updatable,
} from './agents.js'
import type { HostContext, MethodsUnder } from './context.js'
import type { AgentEntry } from '@harnessdesk/protocol'

/** A resolved `definitionAt` result, reshaped as the `AgentEntry` `resolveAttachmentDeclarations` reads — `shadows`/`problems` play no part in resolving one Agent's own declarations. */
const asEntry = (
  id: string,
  origin: AgentOrigin,
  at: { readonly path: string; readonly digest: string; readonly definition: NonNullable<ReturnType<typeof parseAgentDefinition>['agent']> },
): AgentEntry => ({
  id: id as AgentEntry['id'],
  origin,
  path: at.path,
  digest: at.digest,
  definition: at.definition,
  shadows: [],
  problems: [],
})

/**
 * Task 5: the person-facing surface over Task 1's declarations/trust and
 * Task 3's frozen Seat receipts — the Agent page's Skills/Servers/Notes
 * sections, and the Library's own per-Seat lookups.
 *
 * Every handler resolves its own subject/folder from `id`/`origin`/`project`
 * — never from a path or a digest a client could have made up — the same
 * discipline `agent/ceiling/*` already holds, whose `updatable` and
 * `listedAgentPath` this reuses rather than re-deriving.
 */

/** The Agent definition and digest at one specific origin — the winner, or one it shadows, read the same way `agent/copy` already reads a non-winning origin. */
const definitionAt = async (
  ctx: HostContext,
  id: string,
  origin: AgentOrigin,
  project: string | undefined,
): Promise<{ readonly folder: string; readonly path: string; readonly definition: ReturnType<typeof parseAgentDefinition>['agent']; readonly digest: string | null }> => {
  const entry = await ctx.agents.read(id, project)
  if (!entry) throw new Error(`There is no Agent called “${id}” here.`)
  const looked = listedAgentPath(ctx, entry, origin, project)
  if (looked.at === 'missing') throw new Error(`There is no ${originAgent(origin)} Agent called “${id}” here.`)
  if (looked.at === 'invalid') throw new Error(`“${id}” is not a real Agent folder.`)
  if (entry.origin === origin) return { folder: dirname(looked.path), path: looked.path, definition: entry.definition, digest: entry.digest }
  const source = await readAgentSource(looked.path)
  const read = parseAgentDefinition(source, id)
  return { folder: dirname(looked.path), path: looked.path, definition: read.agent, digest: digestOf(source) }
}

/** Every registered runtime's measured (or unmeasured) attachment support — the same fallback `host.ts` itself falls back to for one it has not measured. */
const everyRuntimeSupport = (ctx: HostContext): readonly AttachmentSupport[] =>
  ctx.runtimes.all().map((runtime) => {
    const info = ctx.runtimes.infoOf(runtime)
    return (
      info.attachments ?? {
        runtime: String(info.id),
        build: info.version ?? '',
        skills: 'unsupported',
        mcp: 'unsupported',
        suppressUnapproved: false,
        reason: `${info.presentation.name} has not been measured against phase 12’s attachment contract.`,
      }
    )
  })

const requireAttachments = (ctx: HostContext): NonNullable<HostContext['attachments']> => {
  if (!ctx.attachments) throw new Error('This desk is not wired for Agent attachments.')
  return ctx.attachments
}

export const attachmentMethods = {
  'attachment/agent': async (ctx, params) => {
    const project = await projectOf(ctx, params.project)
    const at = await definitionAt(ctx, params.id, params.origin, project)
    if (!at.definition || at.digest === null) {
      throw new Error(`${at.path} cannot be read as an Agent, so its attachments cannot be shown.`)
    }
    const { declarations } = await requireAttachments(ctx).declarations(
      asEntry(params.id, params.origin, { path: at.path, digest: at.digest, definition: at.definition }),
      project ?? '',
    )
    const view: AgentAttachmentsView = {
      agent: params.id,
      origin: params.origin,
      agentDigest: at.digest,
      skillsMode: at.definition.skills.length === 0 ? 'runtime-defaults' : 'allowlist',
      mcpMode: at.definition.mcp.length === 0 ? 'runtime-defaults' : 'allowlist',
      declarations,
      support: everyRuntimeSupport(ctx),
    }
    return view
  },

  'attachment/edit/preview': async (ctx, params) => {
    const { path, folder } = await updatable(ctx, params)
    const source = await readAgentSource(path)
    const edit = attachmentFieldEdit(source, { skills: params.skills, mcp: params.mcp })
    if ('refused' in edit) throw new Error(`${path} cannot be updated: ${edit.refused}.`)
    const parsed = parseAgentDefinition(edit.next, params.id)
    const brokenBy = parsed.problems.find((one) => one.level === 'error')
    if (brokenBy) throw new Error(`This change would leave ${path} unreadable: ${brokenBy.at} — ${brokenBy.text}.`)
    void folder
    return { path, digest: digestOf(source), diff: edit.diff }
  },

  'attachment/edit/write': async (ctx, params) => {
    const { path, project } = await updatable(ctx, params)
    await ctx.authoring.rewriteAgent({ origin: params.origin, id: params.id, ...(project ? { root: project } : {}) }, (source) => {
      if (digestOf(source) !== params.digest) throw new Error(staleUpdate(path))
      const edit = attachmentFieldEdit(source, { skills: params.skills, mcp: params.mcp })
      if ('refused' in edit) throw new Error(`${path} cannot be updated: ${edit.refused}.`)
      const parsed = parseAgentDefinition(edit.next, params.id)
      const brokenBy = parsed.problems.find((one) => one.level === 'error')
      if (brokenBy) throw new Error(`This change would leave ${path} unreadable: ${brokenBy.at} — ${brokenBy.text}.`)
      return edit.next
    }, staleUpdate(path))
    ctx.push({ method: 'agent/changed', params: { project: params.origin === 'project' ? (project ?? null) : null } })
    return found(await ctx.agents.read(params.id, project), { id: params.id, origin: params.origin, path })
  },

  'attachment/notes': async (ctx, params) => {
    const project = await projectOf(ctx, params.project)
    const at = await definitionAt(ctx, params.id, params.origin, project)
    return readAgentNotes(at.folder, params.origin !== 'builtin')
  },

  'attachment/notes/clear': async (ctx, params) => {
    const project = await projectOf(ctx, params.project)
    const at = await definitionAt(ctx, params.id, params.origin, project)
    return clearAgentNotes(at.folder, params.digest)
  },

  'attachment/review': async (ctx, params) => {
    const attachments = requireAttachments(ctx)
    // `root` names the project this Agent would actually be *seated* in —
    // never re-derived from the Agent's own origin, which for a `user`
    // Agent is a different folder entirely. `seatAgent` binds trust to
    // `incarnationOf(project ?? params.cwd)`, i.e. exactly this same
    // project; reviewing against any other root would freeze an approval
    // the real Seat could never actually match.
    const root = await projectOf(ctx, params.root)
    if (!root) throw new Error('Choose the project this Agent would be seated in.')
    const at = await definitionAt(ctx, params.id, params.origin, root)
    if (!at.definition || at.digest === null) {
      throw new Error(`${at.path} cannot be read as an Agent, so nothing here can be reviewed.`)
    }
    // The runtime the Seat will actually run on — the one `agent/seat`
    // chooses by default — unless a caller names one: an approval is bound
    // to a runtime build, so reviewing for any other runtime would approve
    // something the real Seat never checks.
    const runtimeName = params.runtime ?? (await defaultSeatRuntime(ctx, at.definition))
    if (!runtimeName) throw new Error(`${at.definition.name} cannot be seated on any runtime here, so there is nothing to review yet.`)
    const runtime = ctx.runtimes.get(runtimeName)
    if (!runtime) throw new Error(`There is no runtime called “${runtimeName}” to review this Agent against.`)
    const { resolved } = await attachments.declarations(
      asEntry(params.id, params.origin, { path: at.path, digest: at.digest, definition: at.definition }),
      root,
    )
    const incarnation = await incarnationOf(root)
    // The Agent's own ceiling — the most any Seat of it can run at. The
    // grant this records covers any Seat at or below it (`AttachmentTrust
    // .permits` compares with `reaches`), so a default `edit` seating of a
    // `merge` Agent is covered by the one review, and a raised ceiling in
    // the Agent's file is not.
    return attachments.trust.preview(
      {
        project: root,
        incarnation,
        agent: params.id,
        origin: params.origin,
        agentDigest: at.digest,
        runtime: runtimeName,
        build: ctx.runtimes.infoOf(runtime).version ?? '',
        ceiling: at.definition.ceiling,
      },
      resolved,
      { runtimeName: ctx.runtimes.infoOf(runtime).presentation.name },
    )
  },

  'attachment/approve': async (ctx, params) => {
    await requireAttachments(ctx).trust.approve(params.token, { acknowledgeHidden: params.acknowledgeHidden === true })
    return null
  },

  'attachment/seat': async (ctx, params) => requireAttachments(ctx).seatRecord(params.seat),
} satisfies MethodsUnder<'attachment/'>
