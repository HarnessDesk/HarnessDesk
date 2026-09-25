/** Values handed to xterm, which cannot resolve CSS variables on its canvas. */
export type TerminalAppearance = {
  readonly fontFamily: string
  readonly theme: {
    readonly background: string
    readonly foreground: string
    readonly cursor: string
    readonly selectionBackground: string
  }
}

/** Translate the resolved One UI System foundation into xterm options. */
export const terminalAppearance = (root: Element = document.body): TerminalAppearance => {
  const style = getComputedStyle(root)
  const read = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback
  const codeFace = read('--hd-font-code', 'Menlo, monospace')
  return {
    fontFamily: `${codeFace}, Menlo, monospace`,
    theme: {
      background: read('--hd-surface-fill', '#ffffff'),
      foreground: read('--hd-foreground', '#1f1f1f'),
      cursor: read('--hd-accent', '#5676e8'),
      selectionBackground: read('--hd-accent-dim', 'rgba(86, 118, 232, 0.2)'),
    },
  }
}
