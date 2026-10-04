import { Button, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogRoot, DialogTitle } from '../design'
import { useTheme } from '../state/theme'

/** The shot runner records the installer's actual requests on throwaway homes.
 * This previews their content; macOS still owns the native box's appearance. */
export const CliInstallFrame = () => {
  useTheme()
  const fixture = (window as unknown as { __hdCliInstallDialog?: {
    menuLabel: string
    request: { message: string; detail: string; buttons: string[] }
  } }).__hdCliInstallDialog
  if (!fixture) return <p>Run script/shots/cli-install.mjs to supply a recorded dialog.</p>
  const { menuLabel, request } = fixture
  return (
    <div className="p-6 text-sm text-muted-foreground">
      <p>{menuLabel} · Native dialog content preview</p>
      <DialogRoot open>
        <DialogContent showCloseButton={false} aria-describedby="cli-install-detail">
          <DialogHeader>
            <DialogTitle className="leading-normal">{request.message}</DialogTitle>
          </DialogHeader>
          <DialogDescription id="cli-install-detail" className="whitespace-pre-wrap break-words">
            {request.detail}
          </DialogDescription>
          <DialogFooter>
            {request.buttons.map((label, index) => (
              <Button key={label} variant={index === 0 ? 'default' : 'outline'}>{label}</Button>
            ))}
          </DialogFooter>
        </DialogContent>
      </DialogRoot>
    </div>
  )
}
