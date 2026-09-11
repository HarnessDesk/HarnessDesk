import {
  contributionId,
  GLOBAL_SCOPE,
  pluginInstanceId,
  type ContributionId,
  type HostResult,
} from '@harnessdesk/protocol'

import type { MethodsUnder } from './context.js'

/**
 * The one capability the host contributes itself. The terminal is the host's
 * own workbench tool, not a plugin, so its chip is offered here rather than
 * through the kernel, and resolved here rather than by a plugin.
 */
export const TERMINAL_CHIP = {
  id: contributionId('host:terminal:last-output'),
  owner: pluginInstanceId('HarnessDesk'),
  revision: 0,
  scope: GLOBAL_SCOPE,
  kind: 'context',
  label: 'Last terminal output',
  form: 'resource',
  chip: { description: 'The tail of the most recent terminal — the error is right there.' },
} as const satisfies HostResult<'capability/list'>[number]

/**
 * The extension plane over the wire: plugin lifecycle, what the kernel holds,
 * and the two things the renderer asks the kernel to do — run a command and
 * resolve a composer chip.
 */
export const pluginMethods = {
  'plugin/list': (ctx) => ctx.extensions().plugins(),

  'plugin/setEnabled': async (ctx, params) => {
    await ctx.extensions().setEnabled(params.pluginId, params.enabled)
    return null
  },

  'plugin/configure': async (ctx, params) => {
    await ctx.extensions().reconfigure(params.pluginId, params.config)
    // Written to preferences for every plugin, not only team's: the kernel's
    // copy dies with the process, so a setting that is only there is a
    // setting the settings page shows you having saved and the next launch
    // does not have. The host puts these back in `start()` (#258).
    const stored = ctx.state.state.preferences['pluginSettings']
    const settings =
      stored && typeof stored === 'object' && !Array.isArray(stored)
        ? { ...(stored as Record<string, unknown>) }
        : {}
    settings[params.pluginId] = params.config
    await ctx.state.setPreferences({ pluginSettings: settings })
    // The board and the channel are the host's, not the child's — the
    // plugin is the surface that describes them. So team's settings are
    // applied here too, where the engine that enforces them lives. The
    // older key is kept up to date so a downgrade still finds the rules.
    if (params.pluginId === 'team') {
      await ctx.state.setPreferences({ teamSettings: params.config })
      ctx.settings.applyTeam()
    }
    return null
  },

  'plugin/inspect': (ctx, params) => ctx.extensions().inspectPlugin(params.specifier),

  'plugin/install': async (ctx, params) => ({ pluginId: await ctx.extensions().installPlugin(params.specifier) }),

  'plugin/uninstall': async (ctx, params) => {
    await ctx.extensions().uninstallPlugin(params.pluginId)
    return null
  },

  'capability/list': (ctx, params) => {
    const { kind, ...scope } = params
    const listed = ctx.extensions().list(kind, scope)
    // The terminal is the host's own workbench tool, not a plugin, so its
    // chip is contributed here rather than through the kernel.
    return kind === 'context' ? [...listed, TERMINAL_CHIP] : listed
  },

  'command/run': async (ctx, params) => {
    const handled = await ctx.extensions().runCommand(params.name, params.argument, {
      ...(params.runtime ? { runtime: params.runtime } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    })
    return { handled }
  },

  'context/resolve': async (ctx, params) => {
    if (params.id === TERMINAL_CHIP.id) {
      const last = ctx.terminals.lastOutput()
      if (!last) throw new Error('No terminal has printed anything yet. Open a shell from the dock first.')
      return {
        label: TERMINAL_CHIP.label,
        text: `Terminal in ${last.cwd}${last.exitCode !== null ? ` (exited ${last.exitCode})` : ''}:\n${last.text}`,
      }
    }
    const resolved = await ctx.extensions().resolveOne(params.id as ContributionId, params.ref, {
      ...(params.runtime ? { runtime: params.runtime } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.workspaceRoot ? { workspaceRoot: params.workspaceRoot } : {}),
    })
    if (!resolved) throw new Error('That context provider is no longer available.')
    return resolved
  },
} satisfies MethodsUnder<'plugin/' | 'capability/' | 'command/' | 'context/'>
