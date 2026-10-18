import { runtime } from './harness'

/** The README's tiles name the shipped agents; the catalogue keeps its neutral Alpha/Beta/Gamma. */
export const README_RUNTIME_NAMES: Readonly<Record<string, string>> = { Alpha: 'Codex', Beta: 'Claude Code', Gamma: 'Cursor' }

/** The README race's two competitors and its judge. */
export const README_RACE_RUNTIMES = [runtime('codex', 'Codex'), runtime('claude', 'Claude Code'), runtime('cursor', 'Cursor')]
