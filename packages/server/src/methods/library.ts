import { join } from 'node:path'

import { applyLibrary, planLibrary, readDefinition, readLibrary } from '@harnessdesk/agent-inventory'
import { runtimeId } from '@harnessdesk/protocol'

import type { MethodsUnder } from './context.js'

/**
 * One library, every agent: the skills and MCP servers on the machine, which
 * agents load each one, and the plan/apply pair that writes into an agent's
 * own configuration.
 */
export const libraryMethods = {
  'library/read': (ctx, params) => readLibrary(ctx.runtimes.inventory(), { cwd: params.cwd }),

  'library/definition': (ctx, params) =>
    // Synchronous and small: one file and a bounded directory listing.
    // It is not worth a worker, and the sheet that asked for it wants it
    // in the same frame it opened in.
    readDefinition(
      { kind: params.kind, name: params.name, path: params.path },
      params.cwd !== undefined ? { cwd: params.cwd } : {},
    ),

  'library/plan': (ctx, params) =>
    // Plan touches nothing; what it answers with is the evidence the
    // person confirms. The same brand-deduped roster as the read, so a
    // column and its install target can never disagree about which
    // runtime an agent is.
    planLibrary(ctx.runtimes.inventory(), params.intents, {
      libraryDir: join(ctx.state.directory, 'library'),
      cwd: params.cwd,
    }),

  'library/apply': async (ctx, params) => {
    // Writing into another program's configuration is the most
    // destructive thing this app does. The engine re-checks every
    // target — inside a known root, not read-only, unchanged since the
    // plan's digest — because these ops crossed a socket; and every op,
    // done or failed, lands in the audit log with its backup's address.
    const results = await applyLibrary(params.ops, {
      libraryDir: join(ctx.state.directory, 'library'),
      cwd: params.cwd,
    })
    const opById = new Map(params.ops.map((one) => [one.id, one]))
    for (const result of results) {
      const op = opById.get(result.id)
      if (!op || result.outcome === 'skipped') continue
      ctx.audit.append({
        at: Date.now(),
        runtime: op.targetRuntime ?? runtimeId('host'),
        sessionId: '',
        // The workspace the write was made from, so it shows in that
        // workspace's Activity view rather than being dropped by its root
        // filter (library writes land in $HOME, not under the workspace).
        ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
        kind: 'library/write',
        op: `${op.kind}/${op.action}`,
        name: op.name,
        path: op.targetPath,
        status: result.outcome,
        ...(result.backupPath !== undefined ? { backupPath: result.backupPath } : {}),
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
      })
    }
    return results
  },

  'library/usage': (ctx) => ctx.libraryUsage().read(),
} satisfies MethodsUnder<'library/'>
