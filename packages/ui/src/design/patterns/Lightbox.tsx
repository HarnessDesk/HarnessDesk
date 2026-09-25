import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import { ArrowLeftIcon, ArrowRightIcon } from '../../components/Icons'
import { dataUrlBytes, formatBytes } from '../../lib/images'
import { Button } from '../ui/button'
import {
  Dialog as DialogRoot,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'

export interface LightboxImage {
  readonly url: string
  readonly name: string
}

/**
 * The canonical image viewer: a picture opened to the size of the window.
 *
 * It is a dialog showing an image, and it is drawn as one — the dialog's own
 * surface, scrim and close, the picture's name as the dialog's title and its
 * size as the dialog's description, and the gallery's steps as the floating
 * buttons every control over content wears. Nothing here draws a look of its
 * own. The version this replaces set a black scrim, white words and
 * translucent white buttons in a stylesheet of its own, and the dialog's
 * utilities outranked every one of them: in the light theme the name, the
 * size and both arrows were white on a white sheet.
 *
 * Base UI owns the modal lifecycle, focus containment and return, outside
 * press, portal and topmost Escape policy; this owns the gallery's position
 * and the picture's facts.
 */
export const Lightbox = ({
  images,
  index,
  onClose,
}: {
  readonly images: readonly LightboxImage[]
  readonly index: number
  readonly onClose: () => void
}) => {
  const [current, setCurrent] = useState(index)
  const [dimensions, setDimensions] = useState<string | null>(null)
  const image = images[current]
  const several = images.length > 1
  const sheet = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setCurrent(index)
  }, [index])

  /* The steps answer the arrows from inside the sheet, where the focus is
     held. A listener on the window never heard them: something between the
     sheet and the window stops the key on its way up, so ← and → did nothing
     in the app while the same test, dispatched straight at the window, passed. */
  const step = (event: ReactKeyboardEvent): void => {
    if (!several || (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft')) return
    event.preventDefault()
    const by = event.key === 'ArrowRight' ? 1 : -1
    setCurrent((value) => (value + by + images.length) % images.length)
  }

  if (!image) return null
  const bytes = dataUrlBytes(image.url)
  const facts = [
    dimensions,
    bytes != null ? formatBytes(bytes) : null,
    several ? `${current + 1} of ${images.length}` : null,
  ].filter(Boolean).join(' · ')

  return (
    <DialogRoot open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        ref={sheet}
        data-lightbox=""
        /* The sheet takes the focus, as every sheet here does (SkillSheet,
           ModalDialog with no field): it wears no ring, Escape and the arrows
           reach it, and Tab goes on to its controls. Base UI's own default
           would put a ring on the first of them, the Previous step. */
        initialFocus={() => sheet.current}
        onKeyDown={step}
        className="h-[min(88vh,900px)] w-[min(88vw,1200px)] grid-rows-[auto_minmax(0,1fr)] sm:max-w-none"
      >
        {/* The end margin keeps a long name clear of the close in the corner. */}
        <DialogHeader className="mr-8 min-w-0">
          <DialogTitle className="truncate">{image.name}</DialogTitle>
          {facts && <DialogDescription>{facts}</DialogDescription>}
        </DialogHeader>
        <figure className="m-0 grid min-h-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3">
          {several && (
            <Button
              variant="floating"
              size="icon"
              className="col-start-1"
              aria-label="Previous image"
              onClick={() => setCurrent((value) => (value - 1 + images.length) % images.length)}
            >
              <ArrowLeftIcon size={16} />
            </Button>
          )}
          <img
            className="col-start-2 max-h-full max-w-full min-h-0 justify-self-center object-contain"
            src={image.url}
            alt={image.name}
            onLoad={(event) => {
              const target = event.currentTarget
              setDimensions(`${target.naturalWidth} × ${target.naturalHeight}`)
            }}
          />
          {several && (
            <Button
              variant="floating"
              size="icon"
              className="col-start-3"
              aria-label="Next image"
              onClick={() => setCurrent((value) => (value + 1) % images.length)}
            >
              <ArrowRightIcon size={16} />
            </Button>
          )}
        </figure>
      </DialogContent>
    </DialogRoot>
  )
}
