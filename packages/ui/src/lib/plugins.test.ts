import { describe, expect, it } from 'vitest'

import type { PluginInstance } from '@harnessdesk/protocol'

import { isSuperseded, livePlugins, supersededPlugins } from './plugins'

/**
 * The one thing the roster has to get right: a plugin that shipped as an
 * example, was installed from there, and later became part of the app is one
 * plugin with two copies — not two plugins.
 */

const plugin = (id: string, kind: 'builtin' | 'local'): PluginInstance =>
  ({
    instanceId: `${id}:${kind}`,
    identity: { id, name: id, source: kind === 'builtin' ? { kind } : { kind, path: '/x' } },
  }) as unknown as PluginInstance

describe('the plugin roster', () => {
  it('keeps the built-in and sets its installed namesake aside', () => {
    const all = [plugin('browser', 'builtin'), plugin('browser', 'local'), plugin('git', 'builtin')]
    expect(livePlugins(all).map((entry) => entry.instanceId)).toEqual([
      'browser:builtin',
      'git:builtin',
    ])
    expect(supersededPlugins(all).map((entry) => entry.instanceId)).toEqual(['browser:local'])
  })

  it('leaves an installed plugin alone when nothing shipped over it', () => {
    const all = [plugin('git', 'builtin'), plugin('linear', 'local')]
    expect(supersededPlugins(all)).toEqual([])
    expect(livePlugins(all)).toHaveLength(2)
    expect(isSuperseded(plugin('linear', 'local'), all)).toBe(false)
  })

  it('never supersedes a built-in', () => {
    const all = [plugin('browser', 'builtin'), plugin('browser', 'local')]
    expect(isSuperseded(plugin('browser', 'builtin'), all)).toBe(false)
  })
})
