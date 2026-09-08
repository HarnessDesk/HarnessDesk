import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

import { useSnapshot, useStore } from '../state/context'
import type { TerminalView } from '../state/layout'
import { useMount } from '../panels/mount'
import { PanelActions } from '../panels/PanelActions'
import { ltr } from './ToolPaneHeader'
import { useTheme } from '../state/theme'
import { PlusIcon } from './Icons'
import styles from './ToolPanes.module.css'

/**
 * One integrated terminal.
 *
 * It used to be a dock: a component that owned a strip along the bottom of the
 * pane area, its own tab bar, its own resize grip, its own collapse and close
 * buttons, and a height in the layout that nothing else could use. All of that
 * was a panel system for exactly one feature — so it is gone, and a terminal is
 * now a view like any other, mounted in the bottom panel by default because
 * that is where a shell belongs, and dockable anywhere its definition allows.
 *
 * What is left is the part that was always specific to a terminal: the process
 * runs inside the runtime's sandbox and the host holds it, so a renderer reload
 * — or a collapse and re-expand — re-attaches to the same shell and redraws
 * what it printed. xterm does the emulation; this ferries bytes both ways, fits
 * the grid to whatever box the panel gave it, and tells the host about resizes.
 *
 * Themed from the design tokens at mount and on theme change, because xterm
 * paints its own canvas and cannot read CSS variables.
 */

const decode = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
const encode = (text: string): string => btoa(unescape(encodeURIComponent(text)))

const themeFor = (): { background: string; foreground: string; cursor: string; selectionBackground: string } => {
  const style = getComputedStyle(document.body)
  const read = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback
  return {
    background: read('--hdp-alias-bg-layer-1', '#ffffff'),
    foreground: read('--hdp-alias-label-primary', '#1f1f1f'),
    cursor: read('--hd-accent', '#5676e8'),
    selectionBackground: read('--hd-accent-dim', 'rgba(86, 118, 232, 0.2)'),
  }
}

/**
 * xterm paints its own canvas and measures glyphs itself, so it needs a real
 * font list — a `var()` it cannot resolve makes the measurement and the paint
 * disagree, and every line wraps at the wrong column.
 */
const fontFor = (): string => {
  const declared = getComputedStyle(document.body).getPropertyValue('--hdp-font-family-code').trim()
  return declared ? `${declared}, Menlo, monospace` : 'Menlo, monospace'
}

/**
 * The terminal, as the panel system mounts it.
 *
 * Takes no props: which shell this is comes from the mount, the same way a file
 * panel learns its path and a repository panel its folder. The header carries
 * only what is this terminal's own — where it is running, and a way to open
 * another beside it. Collapse, close, zoom and the tab strip are the panel's,
 * because they are the same three controls whatever is inside.
 */
export const TerminalSurface = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  const mount = useMount()
  const view = mount?.view.kind === 'terminal' ? mount.view : null
  if (!view) return null
  const runtime = snapshot.runtimes.find((entry) => entry.id === view.runtime)
  return (
    <div className={styles.terminalView}>
      <div
        className={styles.terminalBar}
        title={
          runtime
            ? `Runs inside ${runtime.presentation.name}'s sandbox${view.session ? ', with this conversation’s permissions' : ''}.`
            : undefined
        }
      >
        <span className={styles.subtitle} title={view.cwd}>
          {ltr(view.cwd)}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className={styles.headerButton}
          onClick={() => void store.openTerminal({ cwd: view.cwd })}
          title={`New shell in ${view.cwd}`}
          aria-label="New terminal"
        >
          <PlusIcon size={12} />
        </button>
        {/* Alone in its panel, this row is the only one — so the panel's verbs
            live at the end of it rather than in a strip above saying
            "Terminal" over a bar that already says where the shell is. */}
        <PanelActions />
      </div>
      <TerminalScreen view={view} />
    </div>
  )
}

/** What a terminal's tab is called: the command's first word, else the folder. */
export const terminalName = (view: TerminalView): string =>
  view.command?.[0]?.split('/').pop() ?? view.cwd.split('/').filter(Boolean).at(-1) ?? 'Terminal'

/** The xterm surface for one terminal id; remounts when the id changes. */
const TerminalScreen = ({ view }: { view: TerminalView }) => {
  const store = useStore()
  const theme = useTheme()
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const terminalId = view.terminalId

  useEffect(() => {
    const element = host.current
    if (!element) return
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 12.5,
      fontFamily: fontFor(),
      theme: themeFor(),
      scrollback: 5000,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(element)
    term.current = terminal
    let disposed = false
    setExitCode(null)
    setError(null)

    // Attach first: the scrollback redraws the dock before any live byte.
    void store.transport
      .request('terminal/attach', { terminalId })
      .then((attached) => {
        if (disposed) return
        terminal.write(decode(attached.scrollback))
        if (attached.exitCode !== null) setExitCode(attached.exitCode)
        fit.fit()
        // Take the keyboard: a terminal that opens unfocused leaves keystrokes
        // with whatever had focus before — a sidebar button, at worst, where
        // Space and Enter re-activate it and yank the layout elsewhere.
        terminal.focus()
        void store.transport
          .request('terminal/resize', { terminalId, size: { rows: terminal.rows, cols: terminal.cols } })
          .catch(() => {})
      })
      .catch((thrown: unknown) => {
        if (!disposed) setError(thrown instanceof Error ? thrown.message : String(thrown))
      })

    const offLive = store.onTerminal(terminalId, (notification) => {
      if (notification.method === 'terminal/output') terminal.write(decode(notification.params.data))
      else setExitCode(notification.params.exitCode)
    })

    const onData = terminal.onData((data) => {
      void store.transport.request('terminal/write', { terminalId, data: encode(data) }).catch(() => {})
    })

    // Fit on every size change, but tell the host once the dust settles: a
    // drag produces dozens of sizes a second and the PTY needs the last one.
    let pending: number | null = null
    const observer = new ResizeObserver(() => {
      fit.fit()
      if (pending !== null) window.clearTimeout(pending)
      pending = window.setTimeout(() => {
        pending = null
        void store.transport
          .request('terminal/resize', { terminalId, size: { rows: terminal.rows, cols: terminal.cols } })
          .catch(() => {})
      }, 120)
    })
    observer.observe(element)

    return () => {
      disposed = true
      observer.disconnect()
      if (pending !== null) window.clearTimeout(pending)
      onData.dispose()
      offLive()
      terminal.dispose()
      term.current = null
    }
  }, [store, terminalId])

  useEffect(() => {
    if (term.current) term.current.options.theme = themeFor()
  }, [theme])

  return (
    <>
      <div className={styles.terminalHost} ref={host} />
      {(exitCode !== null || error) && (
        <div className={styles.exited}>
          <span>
            {error
              ? error
              : exitCode === 0
                ? 'Finished.'
                : exitCode === -1
                  ? 'The process ended with the runtime.'
                  : `Exited with code ${exitCode}.`}
          </span>
          <span style={{ flex: 1 }} />
          <button type="button" className={styles.action} onClick={() => void store.restartTerminal(view.terminalId)}>
            {view.command ? 'Run again' : 'New shell'}
          </button>
          <button type="button" className={styles.action} onClick={() => store.closeTerminal(view.terminalId)}>
            Close
          </button>
        </div>
      )}
    </>
  )
}
