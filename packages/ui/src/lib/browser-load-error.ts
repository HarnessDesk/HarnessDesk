const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

/** A human-readable explanation for Chromium's net::Error code. */
export const browserLoadFailureMessage = (url: string, errorCode: number): string => {
  const host = hostOf(url)
  if (errorCode === -102) return `Couldn't reach ${host} — the connection was refused`
  if (errorCode === -105) return `Couldn't reach ${host} — the address was not found`
  if (errorCode === -7) return `Loading ${host} timed out`
  if (errorCode <= -200 && errorCode >= -299) return `Couldn't load ${host} — the certificate was rejected`
  return `Couldn't load ${host} — error ${errorCode}`
}
