import { contributionId, GLOBAL_SCOPE, type CapabilityContribution, type PluginInstance } from '@harnessdesk/protocol'
import { frameDestinationStore } from './frame-destination-store'
import { previewStore } from './harness'
import { framePageIds, framePageRoute } from './frame-page-route'

const browserTools = (owner: PluginInstance['instanceId']): CapabilityContribution[] => {
  const tools = [
    ['browser_open', 'Open a page', "Open a URL in the browser and return a screenshot. A screenshot's pixels are the coordinates a click takes."],
    ['browser_screenshot', 'Screenshot', 'Screenshot the browser as it is right now — the viewport, the whole scrollable page, or one element.'],
    ['browser_read_page', 'Read the page', 'What is on the page: an accessibility outline whose interactive parts carry ref_N handles the other tools take, or the page as plain text. Prefer this over measuring a screenshot. A password or one-time-code field reads as "secret filled" or "secret empty" rather than carrying its value — that is deliberate and not a gap to work around; you can still fill one with browser_fill.'],
    ['browser_click', 'Click', 'Click an element by its ref, or at screenshot pixels (origin top-left). Returns a fresh screenshot.'],
    ['browser_pointer', 'Pointer', 'Pointer gestures beyond a click: hover to open a menu, scroll a list, or drag one place to another.'],
    ['browser_key', 'Press a key', 'Press a key, optionally several times and with modifiers held — use Enter, Tab, Escape, Backspace, Delete, Home, End, PageUp, PageDown, ArrowLeft, ArrowUp, ArrowRight, ArrowDown, space, or a single character. Returns a fresh screenshot.'],
    ['browser_type', 'Type', 'Type a whole string, optionally into a field named by its ref first, and optionally press Enter after. For a select, a checkbox, or replacing an existing value, use browser_fill.'],
    ['browser_fill', 'Fill a form', 'Set a form control to a value — text field, textarea, select (by value or label), or checkbox (true/false). Fires the events a framework listens for, so the form really does hold the value.'],
    ['browser_page', 'The page itself', 'The page itself: go back or forward, reload, wait for something to appear, emulate a device or colour scheme, save it as a PDF file, or hand files to a file input.'],
    ['browser_console', 'Read the console', "What the page has logged since it was opened — console calls, uncaught exceptions, and the browser's own complaints (a blocked load, a CSP refusal)."],
    ['browser_network', 'Read network activity', "What the page asked the network for since it was opened, one line per request. Pass a requestId to read that response's body in full."],
    ['browser_evaluate', 'Run page script', 'Evaluate a JavaScript expression in the page and return its JSON value — for state a screenshot cannot show, like a score variable. Its result is returned unredacted, so an expression that reads a password or card field puts that value in the transcript: this tool does what you ask it, and what you ask for is on you.'],
    ['browser_cdp', 'Use browser protocol', 'Send any browser debugging protocol command to the page and return its result — Accessibility, DOM, Storage, Performance, Debugger, anything the other tools do not model. With events: true, read the raw event stream instead. Results come back as the protocol gives them, with none of the redaction browser_read_page applies — Accessibility.getFullAXTree and DOM.getOuterHTML both carry secret field values.'],
    ['browser_close', 'Close the browser', 'Close the browser and end its profile session.'],
  ] as const
  return tools.map(([name, title, description]) => ({
    id: contributionId(`browser/${name}`), owner, revision: 1, scope: GLOBAL_SCOPE,
    kind: 'tool' as const, namespace: 'browser', name, title, description, inputSchema: { type: 'object' },
  } satisfies CapabilityContribution))
}

/** Synthetic plugin states served through the shared App destination. */
export const pluginsDestinationStore = (query: URLSearchParams) => {
const fixture = previewStore()
const snapshot = fixture.getSnapshot()
const first = snapshot.plugins[0]!
const configured = { ...first, identity: { ...first.identity, id: 'browser', name: 'Browser', description: 'Open, see, click and type in a browser — read its page, console and network, and drive it with protocol commands.' }, contributions: browserTools(first.instanceId), configSchema: { type: 'object', properties: {
  greeting: { type: 'string', title: 'Greeting', default: 'Ready to help' },
  enabled: { type: 'boolean', title: 'Include context', default: true },
} }, config: { greeting: 'Ready to help' } }
const failed = { ...first, instanceId: 'fixture-failed' as typeof first.instanceId,
  identity: { ...first.identity, id: 'fixture-failed', name: 'Unavailable helper', source: { kind: 'local' as const, path: '/work/plugins/sample' } },
  state: { type: 'failed' as const, message: 'Synthetic manifest could not be loaded.' } }
Object.assign(snapshot, { plugins: [configured, ...snapshot.plugins.slice(1), failed] })
const store = frameDestinationStore(fixture)
const request = store.transport.request.bind(store.transport)
store.transport.request = (async (method, params) => {
  if (method === 'capability/list') {
    if (query.get('frame-plugin-pending') === '1') return new Promise(() => {})
    return snapshot.contributions.filter(contribution => contribution.kind === (params as { kind: string }).kind)
  }
  if (method === 'plugin/inspect') return { id: 'sample', name: 'Sample plugin', permissions: ['Read workspace files'], alreadyInstalled: false }
  if (method === 'plugin/list') return snapshot.plugins
  if (method === 'plugin/install' || method === 'plugin/configure' || method === 'plugin/setEnabled' || method === 'plugin/uninstall') return undefined
  return request(method, params as never)
}) as typeof store.transport.request
const route = framePageRoute(query, framePageIds(snapshot))
if (route) store.openDestination(query.get('frame-plugin-page') === 'failed'
  ? { kind: 'plugins', section: 'installed', id: failed.instanceId } : route)
return store
}
