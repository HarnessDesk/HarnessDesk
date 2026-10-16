/**
 * Every whole window `preview.html?frame-wall=…` can render. Kept apart from
 * the wall itself so a test can read the list without mounting the App: the
 * review board's scenes are held to it (`review/scenes.test.ts`), so a page
 * added here is a page the board has to show.
 */
export const FRAME_WALL_DESTINATIONS = ['navigation', 'conversation', 'draft', 'team', 'team-trigger', 'team-receipt', 'team-run-recorded', 'team-run-not-reached', 'team-run-repeated', 'team-run-equivalent', 'teams', 'agents', 'agent', 'dashboard', 'settings', 'settings-general', 'settings-runtimes', 'settings-navigation', 'settings-search', 'library', 'plugins', 'changes-review', 'left-work'] as const

export type FrameWallDestination = (typeof FRAME_WALL_DESTINATIONS)[number]
