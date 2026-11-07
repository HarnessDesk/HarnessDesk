/** Screenshot pixels, at original resolution and in the captured orientation. */
export interface IosFrame {
  readonly udid: string
  /** Opaque capture identity bound to the device, boot generation and image geometry. */
  readonly frameId: string
  readonly width: number
  readonly height: number
  readonly mimeType: 'image/png'
  readonly url: string
}

export type IosAppearance = 'light' | 'dark' | 'unsupported' | 'unknown'

export interface IosSetup {
  readonly available: boolean
  readonly code: 'ready' | 'xcodeMissing' | 'developerDirectory' | 'license' | 'firstLaunch' | 'platformMissing' | 'runtimeMissing' | 'serviceUnavailable' | 'unsupportedHost'
  readonly message: string
  readonly developerDirectory?: string
  readonly xcodeVersion?: string
}
