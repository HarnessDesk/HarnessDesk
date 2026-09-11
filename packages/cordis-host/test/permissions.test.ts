import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ExtensionKernel, hostAllowed, pathWithin } from '../src/index.js'

/**
 * The permission engine is the boundary between "plugin system" and "arbitrary
 * code execution". These tests are what make that claim checkable.
 */

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))

test('host matching allows exact names and one wildcard label', () => {
  assert.equal(hostAllowed(['api.example.com'], 'api.example.com'), true)
  assert.equal(hostAllowed(['api.example.com'], 'evil.com'), false)
  assert.equal(hostAllowed(['*.example.com'], 'api.example.com'), true)
  assert.equal(hostAllowed(['*.example.com'], 'deep.api.example.com'), true)
  // The wildcard must not match the bare apex, nor a lookalike suffix.
  assert.equal(hostAllowed(['*.example.com'], 'example.com'), false)
  assert.equal(hostAllowed(['*.example.com'], 'notexample.com'), false)
  assert.equal(hostAllowed(['API.Example.COM'], 'api.example.com'), true, 'case-insensitive')
  assert.equal(hostAllowed([], 'api.example.com'), false, 'empty list denies')
})

test('a trailing dot and leading zeros name the same host and port (#172)', () => {
  assert.equal(hostAllowed(['example.com'], 'example.com.'), true, "a name written with the root's dot")
  assert.equal(hostAllowed(['example.com.'], 'example.com'), true)
  assert.equal(hostAllowed(['localhost:03000'], 'localhost:3000'), true, 'a port written with leading zeros')
  assert.equal(hostAllowed(['*.example.com'], 'example.com.'), false, 'the apex is still not the wildcard')
  assert.equal(hostAllowed(['.'], 'example.com'), false, 'a dot alone names nothing')
})

test('ws and wss have their own default ports at the gate (#172)', async (t) => {
  // Only http had been tried through the gate. A fetch of a ws: URL fails after the gate, which is all this needs.
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  const fetcher = (id: string, hosts: string[], url: string) =>
    kernel.load({
      manifest: { id, name: id, permissions: { network: { hosts } } },
      plugin: {
        name: id,
        inject: ['tools', 'http'],
        apply(ctx: any) {
          ctx.tools.register({ name: id, description: '', inputSchema: {}, execute: async () => (await ctx.http.fetch(url)).body })
        },
      },
    })
  await fetcher('ws_80', ['127.0.0.1:80'], 'ws://127.0.0.1/')
  await fetcher('wss_80', ['127.0.0.1:80'], 'wss://127.0.0.1/')
  await fetcher('wss_443', ['127.0.0.1:443'], 'wss://127.0.0.1/')
  await settle()
  const call = async (tool: string) => {
    const result = await kernel.invokeTool(kernel.list('tool').find((entry) => entry.name === tool)!.id, {}, {})
    return result.ok ? 'ok' : result.error
  }
  const denied = /is not in this plugin's allowed hosts/
  assert.doesNotMatch(await call('ws_80'), denied, 'ws: is port 80 to the gate')
  assert.match(await call('wss_80'), denied, 'and wss: is not')
  assert.doesNotMatch(await call('wss_443'), denied, 'wss: is port 443')
})

test('path containment rejects lookalike siblings and escapes', () => {
  assert.equal(pathWithin('/work', '/work/src/a.ts'), true)
  assert.equal(pathWithin('/work', '/work'), true)
  assert.equal(pathWithin('/work', '/workspace/a.ts'), false, 'prefix is not containment')
  assert.equal(pathWithin('/work', '/etc/passwd'), false)
})

test('path containment resolves before comparing, so `..` cannot walk out', () => {
  // The doc comment on `pathWithin` promises this: "Resolution happens before
  // comparison so `..` cannot walk out". A bare prefix test cannot keep that
  // promise, because the escape is spelled inside the prefix.
  assert.equal(pathWithin('/work', '/work/../etc/passwd'), false)
  assert.equal(pathWithin('/work', '/work/sub/../../etc/passwd'), false)
  assert.equal(pathWithin('/work', '/work/./../work-other/a.ts'), false)
  // A `..` that stays inside is still inside.
  assert.equal(pathWithin('/work', '/work/sub/../ok.ts'), true)
  // A root given with a trailing separator means the same root.
  assert.equal(pathWithin('/work/', '/work/a.ts'), true)
  assert.equal(pathWithin('/work/', '/workspace/a.ts'), false)
})

test('a plugin without workspace permission cannot read the workspace', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-perm-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'secret.txt'), 'classified')

  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  kernel.setWorkspace({ root: dir, branch: null })

  await kernel.load({
    manifest: { id: 'nosy', name: 'Nosy' },
    plugin: {
      name: 'nosy',
      inject: ['tools', 'fs'],
      apply(ctx: any) {
        ctx.tools.register({
          name: 'peek',
          description: '',
          inputSchema: {},
          execute: () => ctx.fs.read('secret.txt'),
        })
      },
    },
  })
  await settle()

  const result = await kernel.invokeTool(kernel.list('tool')[0]!.id, {}, {})
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.error : '', /workspace\.read/)
})

test('a plugin granted workspace read can read, but still cannot write', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-perm-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'notes.txt'), 'hello')

  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  kernel.setWorkspace({ root: dir, branch: null })

  await kernel.load({
    manifest: {
      id: 'reader',
      name: 'Reader',
      permissions: { workspace: { read: true, write: false } },
    },
    plugin: {
      name: 'reader',
      inject: ['tools', 'fs'],
      apply(ctx: any) {
        ctx.tools.register({
          name: 'read_notes',
          description: '',
          inputSchema: {},
          execute: () => ctx.fs.read('notes.txt'),
        })
        ctx.tools.register({
          name: 'write_notes',
          description: '',
          inputSchema: {},
          execute: () => ctx.fs.write('notes.txt', 'overwritten'),
        })
      },
    },
  })
  await settle()

  const tools = kernel.list('tool')
  const read = tools.find((entry) => entry.name === 'read_notes')!
  const write = tools.find((entry) => entry.name === 'write_notes')!

  const readResult = await kernel.invokeTool(read.id, {}, {})
  assert.equal(readResult.ok, true)
  assert.equal(readResult.ok && readResult.content[0]?.type === 'text' && readResult.content[0].text, 'hello')

  const writeResult = await kernel.invokeTool(write.id, {}, {})
  assert.equal(writeResult.ok, false)
  assert.match(writeResult.ok === false ? writeResult.error : '', /workspace\.write/)
})

test('workspace permission does not extend outside the open folder', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-perm-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  kernel.setWorkspace({ root: dir, branch: null })

  await kernel.load({
    manifest: {
      id: 'escaper',
      name: 'Escaper',
      permissions: { workspace: { read: true, write: true } },
    },
    plugin: {
      name: 'escaper',
      inject: ['tools', 'fs'],
      apply(ctx: any) {
        ctx.tools.register({
          name: 'escape',
          description: '',
          inputSchema: {},
          execute: () => ctx.fs.read('/etc/hosts'),
        })
        ctx.tools.register({
          name: 'traverse',
          description: '',
          inputSchema: {},
          execute: () => ctx.fs.read('../../../etc/hosts'),
        })
      },
    },
  })
  await settle()

  for (const tool of kernel.list('tool')) {
    const result = await kernel.invokeTool(tool.id, {}, {})
    assert.equal(result.ok, false, `${tool.name} should be denied`)
    assert.match(result.ok === false ? result.error : '', /outside the open workspace/)
  }
})

test('network access is limited to the declared hosts', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())

  await kernel.load({
    manifest: {
      id: 'fetcher',
      name: 'Fetcher',
      permissions: { network: { hosts: ['api.example.com'] } },
    },
    plugin: {
      name: 'fetcher',
      inject: ['tools', 'http'],
      apply(ctx: any) {
        ctx.tools.register({
          name: 'call_elsewhere',
          description: '',
          inputSchema: {},
          execute: () => ctx.http.fetch('https://evil.test/steal'),
        })
      },
    },
  })
  await settle()

  const result = await kernel.invokeTool(kernel.list('tool')[0]!.id, {}, {})
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.error : '', /evil\.test is not in this plugin/)
})

test('UI contribution requires the ui permission', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())

  await kernel.load({
    manifest: { id: 'sneaky-ui', name: 'Sneaky UI' },
    plugin: {
      name: 'sneaky-ui',
      inject: ['ui'],
      apply(ctx: any) {
        ctx.ui.register({ slot: 'sidebar.panel', label: 'Hi', component: 'x' })
      },
    },
  })
  await settle()

  assert.equal(kernel.list('ui').length, 0, 'the contribution was refused')
  const plugin = kernel.plugins()[0]
  assert.equal(plugin?.state.type, 'failed', 'and the plugin reports why it did not load')
})

test('a plugin can say where its panel may be docked, and it survives the trip', async (t) => {
  /*
   * `mounts` turns a contribution from an occupant of a fixed slot into a
   * *panel* the person can move, expand and close. The declaration starts
   * here, in the plugin's own call, and has to arrive on the contribution the
   * renderer reads — the field existed in the protocol and in the docs before
   * it existed in `UiSpec`, so a plugin that followed the documentation had
   * its list silently dropped and got a fixed slot instead.
   */
  const kernel = new ExtensionKernel({ trusted: ['coverage'] })
  t.after(() => kernel.dispose())

  await kernel.load({
    manifest: { id: 'coverage', name: 'Coverage' },
    plugin: {
      name: 'coverage',
      inject: ['ui'],
      apply(ctx: any) {
        ctx.ui.register({
          slot: 'sidebar.panel',
          mounts: ['right', 'bottom'],
          label: 'Coverage',
          component: 'hd.panel',
        })
      },
    },
  })
  await settle()

  const [contribution] = kernel.list('ui') as readonly { mounts?: readonly string[]; slot?: string }[]
  assert.deepEqual(contribution?.mounts, ['right', 'bottom'])
  // `slot` stays alongside it: it is what a build with no panel system draws.
  assert.equal(contribution?.slot, 'sidebar.panel')
})

test('a contribution that names no areas stays an occupant of its slot', async (t) => {
  const kernel = new ExtensionKernel({ trusted: ['plain'] })
  t.after(() => kernel.dispose())

  await kernel.load({
    manifest: { id: 'plain', name: 'Plain' },
    plugin: {
      name: 'plain',
      inject: ['ui'],
      apply(ctx: any) {
        ctx.ui.register({ slot: 'sidebar.panel', label: 'Plain', component: 'hd.panel' })
      },
    },
  })
  await settle()

  // Absent, not empty: the renderer reads the presence of the field as "this
  // is a panel", so an empty array would make every old contribution one.
  const [contribution] = kernel.list('ui') as readonly { mounts?: readonly string[] }[]
  assert.equal(contribution?.mounts, undefined)
})

test('trusted plugins bypass the manifest, third-party ones never do', async (t) => {
  const kernel = new ExtensionKernel({ trusted: ['builtin'] })
  t.after(() => kernel.dispose())

  await kernel.load({
    manifest: { id: 'builtin', name: 'Built-in feature' },
    plugin: {
      name: 'builtin',
      inject: ['ui'],
      apply(ctx: any) {
        ctx.ui.register({ slot: 'settings.section', label: 'General', component: 'settings.general' })
      },
    },
  })
  await settle()

  assert.equal(kernel.list('ui').length, 1)
  assert.equal(kernel.plugins()[0]?.permissions.shell, true)
})

test('a port in the address is compared only where a pattern names one', () => {
  // #21: the gate compared `host`, which carries the port, so `localhost` never matched localhost:3000.
  assert.equal(hostAllowed(['localhost'], 'localhost:3000'), true)
  assert.equal(hostAllowed(['*.internal.net'], 'api.internal.net:8443'), true)
  assert.equal(hostAllowed(['localhost:3000'], 'localhost:3000'), true)
  assert.equal(hostAllowed(['localhost:3000'], 'localhost:4000'), false, 'a pattern with a port allows that port alone')
  assert.equal(hostAllowed(['localhost:3000'], 'localhost'), false)
  assert.equal(hostAllowed(['[::1]'], '[::1]:8080'), true, "an IPv6 address's own colons are not a port")
  assert.equal(hostAllowed(['::1'], '[::1]:8080'), true, 'nor are they where the pattern leaves the brackets out')
  assert.equal(hostAllowed(['[::1]:8080'], '[::1]:9090'), false)
  assert.equal(hostAllowed(['example.com'], 'example.com.evil.net:443'), false)
})

test('a plugin allowed a host reaches it on the port in the address, and one allowed a port reaches that port alone', async (t) => {
  // #21, through the gate every plugin request passes.
  const server = createServer((_request, response) => response.end('ok'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const { port } = server.address() as AddressInfo
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  const fetcher = (id: string, tool: string, hosts: string[], url: string) =>
    kernel.load({
      manifest: { id, name: id, permissions: { network: { hosts } } },
      plugin: {
        name: id,
        inject: ['tools', 'http'],
        apply(ctx: any) {
          ctx.tools.register({ name: tool, description: '', inputSchema: {}, execute: async () => (await ctx.http.fetch(url)).body })
        },
      },
    })
  const here = `http://127.0.0.1:${port}/`
  await fetcher('any-port', 'fetch_any', ['127.0.0.1'], here)
  await fetcher('this-port', 'fetch_this', [`127.0.0.1:${port}`], here)
  await fetcher('other-port', 'fetch_other', [`127.0.0.1:${port + 1}`], here)
  // A URL leaves its scheme's own port out; a pattern naming that port still matches it.
  await fetcher('scheme-port', 'fetch_scheme', ['127.0.0.1:80'], 'http://127.0.0.1/')
  await fetcher('wrong-port', 'fetch_wrong', ['127.0.0.1:443'], 'http://127.0.0.1/')
  await settle()

  const call = (tool: string) => kernel.invokeTool(kernel.list('tool').find((entry) => entry.name === tool)!.id, {}, {})
  const text = (result: Awaited<ReturnType<typeof call>>): string =>
    result.ok ? result.content.map((part) => (part.type === 'text' ? part.text : '')).join('') : result.error
  const denied = /is not in this plugin's allowed hosts/
  assert.equal(text(await call('fetch_any')), 'ok')
  assert.equal(text(await call('fetch_this')), 'ok')
  assert.match(text(await call('fetch_other')), denied)
  // Past the gate, whatever port 80 on this machine does with the request.
  assert.doesNotMatch(text(await call('fetch_scheme')), denied)
  assert.match(text(await call('fetch_wrong')), denied)
})

test('a pattern that is not a host allows nothing, rather than more than it says', () => {
  // Round 1 of #160: read loosely, `[::1]evil` was `[::1]` and `localhost:` was `localhost`, each on every port.
  for (const pattern of ['[::1]evil', 'localhost:', 'localhost:abc', '[::1]:', '[::1', ':3000', 'a:b:c:zz']) {
    assert.equal(hostAllowed([pattern], 'localhost:3000'), false, pattern)
    assert.equal(hostAllowed([pattern], '[::1]:80'), false, pattern)
  }
  assert.equal(hostAllowed(['[::ffff:7f00:1]'], '[::ffff:7f00:1]:80'), true, 'the control: a well-formed IPv6 pattern still matches')
})

test('an IPv6 address is reached by its bracketed name, through the gate', async (t) => {
  // Round 1 of #160: the IPv6 reading was pinned on `hostAllowed` alone.
  const server = createServer((_request, response) => response.end('ok'))
  const listening = await new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false))
    server.listen(0, '::1', () => resolve(true))
  })
  if (!listening) return t.skip('this machine has no IPv6 loopback')
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const { port } = server.address() as AddressInfo
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  const here = `http://[::1]:${port}/`
  const fetcher = (id: string, tool: string, hosts: string[]) =>
    kernel.load({
      manifest: { id, name: id, permissions: { network: { hosts } } },
      plugin: {
        name: id,
        inject: ['tools', 'http'],
        apply(ctx: any) {
          ctx.tools.register({ name: tool, description: '', inputSchema: {}, execute: async () => (await ctx.http.fetch(here)).body })
        },
      },
    })
  await fetcher('bracketed', 'fetch_bracketed', ['[::1]'])
  await fetcher('bare', 'fetch_bare', ['::1'])
  await fetcher('other-port', 'fetch_other', [`[::1]:${port + 1}`])
  await settle()
  const call = (tool: string) => kernel.invokeTool(kernel.list('tool').find((entry) => entry.name === tool)!.id, {}, {})
  const text = (result: Awaited<ReturnType<typeof call>>): string =>
    result.ok ? result.content.map((part) => (part.type === 'text' ? part.text : '')).join('') : result.error
  assert.equal(text(await call('fetch_bracketed')), 'ok')
  assert.equal(text(await call('fetch_bare')), 'ok')
  assert.match(text(await call('fetch_other')), /is not in this plugin's allowed hosts/)
})

test('an IPv6 pattern is compared the way a URL writes the address, and a wildcard keeps to its port', () => {
  // Round 2 of #160: a URL compresses an IPv6 address, and a pattern written out in full never matched it.
  assert.equal(hostAllowed(['[0:0:0:0:0:0:0:1]'], '[::1]:80'), true)
  assert.equal(hostAllowed(['0:0:0:0:0:0:0:1'], '[::1]:80'), true)
  assert.equal(hostAllowed(['[::1::2]'], '[::1]:80'), false, 'not an address at all')
  // A wildcard with a port keeps to it.
  assert.equal(hostAllowed(['*.internal.net:8443'], 'api.internal.net:8443'), true)
  assert.equal(hostAllowed(['*.internal.net:8443'], 'api.internal.net:443'), false)
  assert.equal(hostAllowed(['*:3000'], 'anything.example:3000'), true)
  assert.equal(hostAllowed(['*:3000'], 'anything.example:3001'), false)
})
