/** Team confinement and file reads use different host refusals for an unopened folder. */
export const projectNeedsOpening = (text: string): boolean =>
  text.includes('is outside every folder and repository opened here. Open it first.') ||
  text.includes('is outside every open workspace. Open its folder first to read from it.')
