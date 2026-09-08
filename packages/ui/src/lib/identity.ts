/** The short brand: 'OpenAI Codex' → Codex, 'Claude Code' → Claude, 'Cursor Agent' → Cursor. */
export const brandOf = (name: string): string =>
  name
    .replace(/^OpenAI\s+/i, '')
    .replace(/\s+(Agent|Code|CLI)$/i, '')
    .trim() || name

/** An email-like account label as a display name: 'olivia.ma@x' → 'Olivia Ma'. */
export const humanizeLabel = (label: string): string => {
  if (!label.includes('@')) return label
  const local = label.split('@')[0] ?? label
  const parts = local.split(/[._-]+/).filter(Boolean)
  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
}
