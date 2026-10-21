/** Known host refusals that ask for an unopened or changed project to be opened again. */
export const projectNeedsOpening = (text: string): boolean =>
  text.includes('is outside every folder and repository opened here. Open it first.') ||
  text.includes('is outside every open workspace. Open its folder first to read from it.') ||
  /The project checkout changed\. Open the project folder again, then (?:preview|try) again\./.test(text)
