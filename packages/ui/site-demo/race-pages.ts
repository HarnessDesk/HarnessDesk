/**
 * Where the race's two pages are served inside the built demo (public/race/),
 * keyed by the loopback address each lane's Browser shows (README_RACE_URLS).
 * Kept apart from race.tsx so the entry can map them without loading the race.
 */
export const RACE_PAGES: Readonly<Record<string, string>> = {
  'http://localhost:30000/': 'race/codex.html',
  'http://localhost:30020/': 'race/claude.html',
}
