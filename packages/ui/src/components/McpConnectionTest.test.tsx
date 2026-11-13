import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { runtimeId, type McpTestResult, type RuntimeInfo } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { commandLine, McpConnectionTest, shownValue } from './McpConnectionTest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const one = runtimeId('one')
const signInRuntime = { id: one, name: 'one', capabilities: { mcp: true }, presentation: { name: 'Runtime 1' } } as unknown as RuntimeInfo

const mount = (answers: McpTestResult[], props: { path?: string; cwd?: string; compact?: boolean; readBy?: readonly RuntimeInfo['id'][] } = {}) => {
  const snapshot = { ...emptySnapshot(), status: 'open', runtimes: [signInRuntime] } as AppSnapshot
  const queue = [...answers]
  const request = vi.fn(async () => queue.shift())
  const mcpLogin = vi.fn(async () => {})
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, transport: { request }, mcpLogin } as unknown as AppStore
  act(() => {
    root.render(<StoreProvider store={store}>
      <McpConnectionTest compact={props.compact} name="tools" path={props.path ?? '/home/jane/.one.json'} cwd={props.cwd} readBy={props.readBy ?? [one]} home="/home/jane" />
    </StoreProvider>)
  })
  return { request, mcpLogin }
}

it('still shows its answer under StrictMode, which mounts it twice', async () => {
  const snapshot = { ...emptySnapshot(), status: 'open', runtimes: [] } as AppSnapshot
  const request = vi.fn(async () => ({ ok: true, tools: 2, ms: 4 }))
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, transport: { request } } as unknown as AppStore
  act(() => {
    root.render(<StrictMode><StoreProvider store={store}>
      <McpConnectionTest name="tools" path="/home/jane/.one.json" cwd={undefined} readBy={[]} home="/home/jane" />
    </StoreProvider></StrictMode>)
  })
  await act(async () => button('Test connection')!.click())
  expect(container.textContent).toContain('Connected · 2 tools')
})

const button = (text: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)

it('runs nothing until clicked, then shows the tool count on the row', async () => {
  const { request } = mount([{ ok: true, tools: 12, serverName: 'tools', ms: 40 }])
  expect(request).not.toHaveBeenCalled()
  await act(async () => button('Test connection')!.click())
  expect(request).toHaveBeenCalledWith('library/mcp/test', { name: 'tools', path: '/home/jane/.one.json' })
  expect(container.textContent).toContain('Connected · 12 tools')
})

it('shows a project server’s exact command before running it, and sends back the digest it showed', async () => {
  const { request } = mount([
    {
      ok: false, reason: 'confirm', detail: 'Check it.', ms: 0, digest: 'd1',
      target: { transport: 'stdio', scope: 'project', command: 'npx', args: ['-y', 'tools server'], cwd: '/work/app', launchEnv: [], envNames: ['API_KEY'] },
    },
    { ok: true, tools: 1, ms: 5 },
  ], { path: '/work/app/.mcp.json', cwd: '/work/app' })
  await act(async () => button('Test connection')!.click())
  const dialog = document.querySelector('[role="alertdialog"]')!
  expect(dialog.textContent).toContain("npx -y 'tools server'")
  expect(dialog.textContent).toContain('/work/app')
  expect(dialog.textContent).toContain('API_KEY')
  expect(request).toHaveBeenCalledTimes(1)
  await act(async () => button('Run test')!.click())
  expect(request).toHaveBeenLastCalledWith('library/mcp/test', { name: 'tools', path: '/work/app/.mcp.json', cwd: '/work/app', confirmed: 'd1' })
  expect(container.textContent).toContain('Connected · 1 tool')
})

it('shows the variables that change what starts with their values, the rest by name', async () => {
  mount([{
    ok: false, reason: 'confirm', detail: 'Check it.', ms: 0, digest: 'd1',
    target: {
      transport: 'stdio', scope: 'project', command: 'node', args: ['server.js'], cwd: '/work/app',
      launchEnv: [{ name: 'NODE_OPTIONS', value: '--require ./preload.js' }, { name: 'PATH', value: './bin:/usr/bin' }],
      envNames: ['API_KEY'],
    },
  }], { path: '/work/app/.mcp.json', cwd: '/work/app' })
  await act(async () => button('Test connection')!.click())
  const dialog = document.querySelector('[role="alertdialog"]')!
  const plates = [...dialog.querySelectorAll('pre')].map(node => node.textContent)
  expect(plates).toEqual(['node server.js', 'NODE_OPTIONS=--require ./preload.js\nPATH=./bin:/usr/bin'])
  expect(dialog.textContent).toContain('And its other variables: API_KEY')
  expect(dialog.textContent).not.toContain('API_KEY=')
})

it('spells out characters that reorder or hide text, and cuts a long value with a count', async () => {
  mount([{
    ok: false, reason: 'confirm', detail: 'Check it.', ms: 0, digest: 'd1',
    target: {
      transport: 'stdio', scope: 'project', command: 'node', cwd: '/work/app', launchEnv: [], envNames: [],
      args: ['run\u202Esj.txt', 'a\u200Bb', 'x'.repeat(2_500)],
    },
  }], { path: '/work/app/.mcp.json', cwd: '/work/app' })
  await act(async () => button('Test connection')!.click())
  const dialog = document.querySelector('[role="alertdialog"]')!
  const plate = dialog.querySelector('pre')!.textContent ?? ''
  expect(plate).toContain('run⟨U+202E⟩sj.txt')
  expect(plate).toContain('a⟨U+200B⟩b')
  expect(plate).not.toMatch(/[\u202E\u200B]/)
  expect(plate.endsWith('…')).toBe(true)
  expect(dialog.textContent).toMatch(/[\d,]+ more characters are not shown\./)
  expect(dialog.textContent).toContain('changes the order of the text')
})

it('a value is shown sanitised, its controls spelled, and cut at its limit', () => {
  expect(shownValue('a\nb\u202Ec', 100)).toEqual({ text: 'a⟨U+000A⟩b⟨U+202E⟩c', cut: 0, marked: true })
  expect(shownValue('<b>x</b>', 100).text).toBe('<b>x</b>')
  expect(shownValue('abcdef', 4)).toEqual({ text: 'abcd…', cut: 2, marked: false })
})

it('busy says why', async () => {
  mount([{ ok: false, reason: 'busy', detail: '4 tests are already running. Try again when one finishes.', ms: 0 }])
  await act(async () => button('Test connection')!.click())
  expect(container.textContent).toContain('Busy')
  expect(container.textContent).toContain('4 tests are already running.')
})

it('Cancel runs nothing', async () => {
  const { request } = mount([{
    ok: false, reason: 'confirm', detail: 'Check it.', ms: 0, digest: 'd1',
    target: { transport: 'http', scope: 'project', url: 'https://tools.example.com/mcp', headerNames: ['Authorization'] },
  }], { path: '/work/app/.mcp.json', cwd: '/work/app' })
  await act(async () => button('Test connection')!.click())
  expect(document.querySelector('[role="alertdialog"]')!.textContent).toContain('https://tools.example.com/mcp')
  await act(async () => button('Cancel')!.click())
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  expect(request).toHaveBeenCalledTimes(1)
})

it('a failure says its reason; its server output is sanitised text', async () => {
  mount([{ ok: false, reason: 'spawnFailed', detail: 'It exited (code 3) before it answered initialize.', ms: 9, stderr: '\u001b[31m<img src=x onerror=alert(1)>boom\u001b[0m' }])
  await act(async () => button('Test connection')!.click())
  expect(container.textContent).toContain('Did not start')
  expect(container.textContent).toContain('It exited (code 3) before it answered initialize.')
  expect(container.querySelector('img')).toBeNull()
  expect(container.querySelector('pre')!.textContent).toBe('<img src=x onerror=alert(1)>boom')
})

it('needs sign-in points to the agent’s own sign-in', async () => {
  const { mcpLogin } = mount([{ ok: false, reason: 'needsSignIn', detail: 'It asks for sign-in.', ms: 3 }])
  await act(async () => button('Test connection')!.click())
  expect(container.textContent).toContain('Needs sign-in')
  await act(async () => button('Sign in')!.click())
  expect(mcpLogin).toHaveBeenCalledWith('tools', one)
})

it('quotes a command line the way it would be typed', () => {
  expect(commandLine('node', ['server.js', '--name', "it's here"])).toBe(`node server.js --name 'it'\\''s here'`)
})

it('list action keeps the result on one line, with failure detail on hover', async () => {
  const { request } = mount([{ ok: false, reason: 'spawnFailed', detail: 'Missing executable.', ms: 0, stderr: 'output' }], { compact: true })
  await act(async () => button('Test')!.click())
  expect(request).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain('Did not start')
  expect(container.textContent).not.toContain('Missing executable.')
  expect(container.querySelector('[title="Missing executable."]')).not.toBeNull()
  expect(container.querySelector('[data-slot="desc-lines"]')).toBeNull()
  expect(container.querySelector('details')).toBeNull()
})

it('rapid clicks start only one request, and leave Test disabled until it finishes', async () => {
  const snapshot = { ...emptySnapshot(), status: 'open', runtimes: [] } as AppSnapshot
  let finish!: (answer: McpTestResult) => void
  const request = vi.fn(() => new Promise<McpTestResult>(resolve => { finish = resolve }))
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, transport: { request } } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><McpConnectionTest compact name="tools" path="/home/jane/.one.json" cwd={undefined} readBy={[]} home="/home/jane" /></StoreProvider>))
  await act(async () => { button('Test')!.click(); button('Test')!.click() })
  expect(request).toHaveBeenCalledTimes(1)
  expect(button('Testing…')!.disabled).toBe(true)
  await act(async () => finish({ ok: true, tools: 1, ms: 8 }))
  expect(button('Test')!.disabled).toBe(false)
})

it('needs sign-in explains ownership when no reading agent offers its own sign-in', async () => {
  mount([{ ok: false, reason: 'needsSignIn', detail: 'It asks for sign-in.', ms: 3 }], { readBy: [] })
  await act(async () => button('Test connection')!.click())
  expect(container.textContent).toContain('Needs sign-in')
  expect(container.textContent).toContain('Its agent signs in to it, not this page.')
  expect(button('Sign in')).toBeUndefined()
})
