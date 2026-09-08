/**
 * The website's embedded demo: the production renderer, verbatim, over a
 * recorded host. The only seam is the WebSocket global — FakeHostSocket
 * replays a captured session instead of reaching a loopback port. Everything
 * the visitor sees and types runs through the same components, store, and
 * reducer the desktop app ships.
 *
 * URL knobs, set by the embedding page:
 *   ?theme=dark|light — the page owns the theme (postMessage keeps it live).
 *   ?view=hero|handoff|usage|room — which surface the demo opens on. `hero` is
 *     an empty composer waiting for the visitor. `handoff` and `usage` drive
 *     the recorded turn through the real send path at ?pace=fast, then stage
 *     the hand-off draft or open the usage dashboard. `room` opens the staged
 *     room's board, and plays its three moves once the band is on screen.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from '../src/app/App'
import { installPanelComponent } from '../src/slots/PanelBlocks'
import { AppStore } from '../src/state/store'
import { StoreProvider } from '../src/state/context'
import '../src/styles/app.css'

import { FakeHostSocket, NOT_WIRED, RECORDED_PROMPT, ROOM_ID } from './fake-host'
import { guide } from './guide'

// This frame lives inside a page: the app's own focus moves (a new draft
// hands the keyboard to the composer) must never scroll the page that embeds
// it — a same-origin iframe propagates focus scrolling to its parent.
const nativeFocus = HTMLElement.prototype.focus
HTMLElement.prototype.focus = function (options?: FocusOptions) {
  nativeFocus.call(this, { ...(options ?? {}), preventScroll: true })
}

// The transport constructs `new WebSocket(url)`; hand it the recording.
;(window as unknown as { WebSocket: unknown }).WebSocket = FakeHostSocket

installPanelComponent()

const store = new AppStore('ws://demo.invalid/ws')

/**
 * Only what the demo can actually do is on offer; everything else does
 * nothing. The renderer is the shipping one, so it draws controls this page
 * has no host for — add an agent, rename a room, sign in. Those refuse, and
 * the refusal used to arrive as a toast: a red banner naming a limitation of
 * the page, in front of somebody who was only exploring. It is dropped here
 * instead, at the one place every toast passes through, so the control is
 * simply inert. Refusals that belong to a surface being read — the room's
 * channel, where a sent message comes back refused and says why — are
 * written into that surface and are untouched by this.
 */
const raise = store.notice.bind(store)
store.notice = (level, message, action) => {
  if (typeof message === 'string' && message.includes(NOT_WIRED)) return
  raise(level, message, action)
}
;(window as unknown as { __hdStore?: AppStore }).__hdStore = store

const KNOBS = new URL(window.location.href).searchParams
const VIEW = KNOBS.get('view') ?? 'hero'

// The page that embeds this frame owns the theme; the recorded preferences
// carry whichever theme the capture ran in and land at their own pace, so
// the demo asserts the wanted theme through boot rather than racing it.
let wantedTheme: 'dark' | 'light' | null = null
const applyTheme = (theme: string | null) => {
  if (theme !== 'dark' && theme !== 'light') return
  wantedTheme = theme
  store.setTheme(theme)
}
applyTheme(KNOBS.get('theme'))
// Docked, the frame is a picture at 56%: the page says so, and the frames'
// own guidance keeps quiet until it is worth reading. A frame opened on its
// own — no embedding page, no message — is never docked.
let docked = false
window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { hdTheme?: string; hdDocked?: boolean } | null
  if (!data || typeof data !== 'object') return
  if ('hdTheme' in data) applyTheme(data.hdTheme ?? null)
  if ('hdDocked' in data) docked = Boolean(data.hdDocked)
})
const CHROME = { docked: () => docked, theme: (): 'dark' | 'light' => wantedTheme ?? 'light' }

/**
 * The one thing each band asks of a visitor, drawn on the frame.
 *
 * The copy beside every band already says it in words; this is the same
 * sentence pointed at the control, for somebody who is looking at the
 * window rather than reading. Only where there is something to do: the
 * hero waits on a composer nobody can miss, and the hand-off opens its own
 * dialog.
 */
const rosterRow = (nickname: string): (() => Element | null) => () => {
  // The tallest element that is still only this agent: the whole row —
  // name, conversation and the job it holds — rather than the line of text
  // the name happens to sit on.
  let best: HTMLElement | null = null
  for (const node of document.querySelectorAll<HTMLElement>('div')) {
    const text = (node.textContent ?? '').trim()
    if (!text.startsWith(nickname) || text.length > 110 || node.childElementCount > 8) continue
    const box = node.getBoundingClientRect()
    if (box.height > 84 || box.width === 0) continue
    if (!best || box.height > best.getBoundingClientRect().height) best = node
  }
  return best
}
const readyCard = (): Element | null =>
  [...document.querySelectorAll<HTMLElement>('div')]
    .filter((node) => node.childElementCount <= 8 && /^#4\b/.test((node.textContent ?? '').trim()))
    .pop() ?? null
let assertsLeft = 16
const assertTimer = window.setInterval(() => {
  if (wantedTheme) store.setTheme(wantedTheme)
  if (--assertsLeft <= 0) window.clearInterval(assertTimer)
}, 250)

/** Polls for the recorded turn's last sentence, then hands over. */
const afterRecordedTurn = (then: () => void) => {
  const deadline = Date.now() + 25_000
  const poll = window.setInterval(() => {
    const done = document.body.innerText.includes('can no longer empty the cart')
    if (!done && Date.now() < deadline) return
    window.clearInterval(poll)
    window.setTimeout(then, 400)
  }, 250)
}

void store
  .connect()
  .then(() => {
    if (VIEW === 'hero') return
    if (VIEW === 'room') {
      if (!ROOM_ID) return
      // The room arrives as a team/changed notification a beat after boot;
      // the sidebar draws it, and that is the sign it can be opened.
      // Guidance hangs off the play signal rather than off whoever sent it,
      // so the observer, the fallback timer and a hand dispatch all get it.
      // Late enough that it lands on a settled board, not over cards moving.
      window.addEventListener(
        'hd-room-play',
        () => {
          window.setTimeout(() => {
            guide(
              [
                {
                  // The last agent in the roster, so the arrow rises out of
                  // empty rail and crosses none of the others on its way.
                  find: rosterRow('Cursor'),
                  text: 'Open an agent',
                  // Below, in the rail's own empty space: to the side is the
                  // board, and a label there covers the work it points from.
                  place: 'below',
                  // Done when a member's conversation has taken the room: it
                  // brings a composer, and the board has none.
                  until: () => document.querySelectorAll('textarea').length > 0,
                },
                // If they opened an agent the board is gone, this finds
                // nothing, and the hint expires without ever being drawn.
                { find: readyCard, text: 'Or move a card', place: 'below' },
              ],
              CHROME,
            )
          }, 9_500)
        },
        { once: true },
      )

      const deadline = Date.now() + 10_000
      const poll = window.setInterval(() => {
        const store_ = store as unknown as { openTeamRoom: (room: string) => void }
        const drawn = [...document.querySelectorAll('[class*="sidebar" i], nav, aside')].some((el) =>
          (el.textContent ?? '').includes('Checkout retry'),
        )
        if (!drawn && Date.now() < deadline) return
        window.clearInterval(poll)
        store_.openTeamRoom(ROOM_ID)
        // The room opens on its chat; the band is about the board, so take
        // the rail's own Board row — the way a person would.
        // The row is a div with a click handler; its title is a leaf whose
        // grandparent carries the "n unclaimed" subtitle. A click on the leaf
        // bubbles to the row — and never to the rail, whose text starts the
        // same way.
        let tries = 0
        const pick = window.setInterval(() => {
          const leaf = [...document.querySelectorAll<HTMLElement>('div, span')].find((el) => {
            if (el.children.length !== 0 || (el.textContent ?? '').trim() !== 'Board') return false
            const near = el.parentElement?.parentElement?.parentElement
            return (near?.textContent ?? '').includes('unclaimed')
          })
          if (leaf) {
            leaf.click()
            window.clearInterval(pick)
          } else if (++tries > 12) {
            window.clearInterval(pick)
          }
        }, 200)
        // Play only when a person can see it: the page preloads this frame
        // 900px early, and a board that has already moved is a board that
        // never did. A same-origin frame measures against the page's viewport.
        const play = () => window.dispatchEvent(new CustomEvent('hd-room-play'))
        if ('IntersectionObserver' in window) {
          const seen = new IntersectionObserver(
            (entries) => {
              if (!entries.some((entry) => entry.intersectionRatio >= 0.3)) return
              seen.disconnect()
              window.setTimeout(play, 900)
            },
            { threshold: [0.3] },
          )
          seen.observe(document.body)
        } else {
          window.setTimeout(play, 8_000)
        }
      }, 250)
      return
    }
    // Drive the recorded turn through the real send path — session/create,
    // turn/queue, the whole flow — so the section opens on a finished
    // conversation. The fake host plays it at ?pace=fast.
    window.setTimeout(() => {
      void store.queue([{ type: 'text', text: RECORDED_PROMPT }])
      afterRecordedTurn(() => {
        if (VIEW === 'handoff') {
          // Open the app's own hand-off dialog — the agent menu on the
          // composer, then its "Hand off to Claude…" entry — so the
          // visitor chooses what travels and presses the button themselves.
          const composer = document.querySelector('textarea')?.closest('div[class*="composer" i]') ?? document
          const agentButton = [...composer.querySelectorAll<HTMLElement>('button')].find(
            (b) => (b.textContent ?? '').trim().startsWith('Codex'),
          )
          agentButton?.click()
          // The menu takes a beat to mount, and its rows answer a pointer
          // rather than `click()` — they are menu items, not buttons, so a
          // bare click leaves the menu open and nothing chosen. Press one
          // the way a mouse does, and keep looking until it is there.
          let tries = 0
          const reach = window.setInterval(() => {
            const entry = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((row) =>
              (row.textContent ?? '').includes('Hand off to Claude'),
            )
            if (entry) {
              window.clearInterval(reach)
              const box = entry.getBoundingClientRect()
              const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, bubbles: true, cancelable: true }
              entry.dispatchEvent(new PointerEvent('pointerdown', { ...at, button: 0, buttons: 1, pointerId: 1, isPrimary: true, pointerType: 'mouse' }))
              entry.dispatchEvent(new MouseEvent('mousedown', { ...at, button: 0, buttons: 1 }))
              entry.dispatchEvent(new PointerEvent('pointerup', { ...at, button: 0, buttons: 0, pointerId: 1, isPrimary: true, pointerType: 'mouse' }))
              entry.dispatchEvent(new MouseEvent('mouseup', { ...at, button: 0, buttons: 0 }))
              entry.dispatchEvent(new MouseEvent('click', { ...at, button: 0, buttons: 0 }))
              return
            }
            if (++tries > 12) {
              window.clearInterval(reach)
              // The menu path drifted; stage the chip directly rather than
              // leaving the section on nothing.
              agentButton?.click()
              void store.continueElsewhere('claude-code')
            }
          }, 200)
        } else if (VIEW === 'usage') {
          // The dashboard's own shortcut, as if the visitor pressed it.
          document.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'u', metaKey: true, bubbles: true, cancelable: true }),
          )
        }
      })
    }, 700)
  })
  .catch((error: unknown) => {
    store.notice('error', error instanceof Error ? error.message : String(error))
  })

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from index.html')

createRoot(container).render(
  <StrictMode>
    <StoreProvider store={store}>
      <App />
    </StoreProvider>
  </StrictMode>,
)
