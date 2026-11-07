/** Device operations only. Native executable selection and process ownership stay in the host. */
export type PixelPoint = { x: number; y: number }
export type TimedPoint = PixelPoint & { tMs: number }
export type IosKey = 'return' | 'delete' | 'left' | 'right' | 'up' | 'down' | 'selectAll' | 'undo'
export type IosOrientation = 'portrait' | 'portraitUpsideDown' | 'landscapeLeft' | 'landscapeRight'
export type IosAction =
  | { kind: 'tap'; x: number; y: number; frameId?: string }
  | { kind: 'longPress'; x: number; y: number; durationMs: number; frameId?: string }
  | { kind: 'swipe'; from: PixelPoint; to: PixelPoint; durationMs: number; frameId?: string }
  | { kind: 'drag'; path: readonly TimedPoint[]; frameId?: string }
  | { kind: 'pinch'; center: PixelPoint; startDistance: number; endDistance: number; durationMs: number; frameId?: string }
  | { kind: 'rotateGesture'; center: PixelPoint; radius: number; angleDegrees: number; durationMs: number; frameId?: string }
  | { kind: 'text'; text: string }
  | { kind: 'key'; key: IosKey; count: number }
  | { kind: 'button'; button: 'home' | 'lock' | 'side'; durationMs: number }
  | { kind: 'rotateDevice'; orientation: IosOrientation }
  | { kind: 'keyboard'; visible: boolean }
export interface IosFrame {
  readonly udid: string
  readonly frameId: string
  readonly width: number
  readonly height: number
  readonly mimeType: 'image/png'
  readonly url: string
  /** Measured interface rotation in clockwise quarter turns. */
  readonly rotation?: 0 | 1 | 2 | 3
  readonly inputMethod?: string
}
export type IosAppearance = 'light' | 'dark' | 'unsupported' | 'unknown'
export interface IosSetup {
  readonly available: boolean
  readonly code: 'ready' | 'xcodeMissing' | 'developerDirectory' | 'license' | 'firstLaunch' | 'platformMissing' | 'runtimeMissing' | 'serviceUnavailable' | 'unsupportedHost'
  readonly message: string
  readonly developerDirectory?: string
  readonly xcodeVersion?: string
}
export interface SimDevice { readonly udid: string; readonly name: string; readonly state: string; readonly runtime: string }
export interface IosCapability {
  devices(): Promise<readonly SimDevice[]>
  diagnose(): Promise<IosSetup>
  frame(udid?: string): Promise<IosFrame>
  getAppearance(udid?: string): Promise<IosAppearance>
  setAppearance(value: 'light' | 'dark', udid?: string): Promise<IosAppearance>
  booted(udid?: string): Promise<SimDevice>
  boot(udid: string, options?: { openWindow?: boolean }): Promise<void>
  install(path: string, udid?: string): Promise<void>
  launch(bundleId: string, udid?: string): Promise<void>
  terminate(bundleId: string, udid?: string): Promise<void>
  openUrl(url: string, udid?: string): Promise<void>
  screenshot(udid?: string): Promise<string>
  tap(x: number, y: number, udid?: string): Promise<void>
  interact(action: IosAction, udid?: string): Promise<IosFrame>
}
