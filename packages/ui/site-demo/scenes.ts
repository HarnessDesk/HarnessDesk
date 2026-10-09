/** The views approved for live embedding. Later scenes join this one registry. */
export const SCENES = {
  dashboard: { width: 960, height: 600, duration: 16_000, still: 12_000 },
} as const

export type SceneName = keyof typeof SCENES
export const isSceneName = (value: string): value is SceneName => Object.hasOwn(SCENES, value)
