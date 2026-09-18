import { Component, type ErrorInfo, type ReactNode } from 'react'

import { Button } from '../design'

/**
 * One screen's crash is one screen's crash.
 *
 * React unmounts the whole root on an uncaught render error, so without this
 * a single broken frame blanks the page and takes every other screen — and
 * the reason to open this page at all — with it.
 *
 * It logs as well as renders, because a component going blank sends most
 * people to DevTools before the page; and the message is a button, because
 * an error boundary latches — without a way to clear it, fixing the bug and
 * letting HMR swap the module still shows the old error until a full reload.
 */
export class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[preview] a frame threw while rendering', error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <Button variant="destructive" size="panel"
          type="button"
          className="block text-left"
          onClick={() => this.setState({ error: null })}
          title="Render this frame again — use it after fixing the cause."
        >
          This screen threw while rendering: {this.state.error.message}
          <span className="mt-1 block text-muted-foreground">Click to retry.</span>
        </Button>
      )
    }
    return this.props.children
  }
}
