import { useEffect, useRef, useState } from 'react'

import { ArrowLeftIcon, ArrowRightIcon, CrossIcon } from '../../components/Icons'
import { dataUrlBytes, formatBytes } from '../../lib/images'
import { Button } from '../ui/button'
import {
  Dialog as DialogRoot,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '../ui/dialog'
import styles from './Lightbox.module.css'

export interface LightboxImage {
  readonly url: string
  readonly name: string
}

/**
 * The canonical full-window image viewer. Base UI owns the modal lifecycle,
 * focus containment/return, outside press, portal and topmost Escape policy;
 * this pattern owns gallery navigation and image metadata.
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
  const close = useRef<HTMLButtonElement>(null)
  const image = images[current]
  const several = images.length > 1

  useEffect(() => {
    setCurrent(index)
  }, [index])

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (several && event.key === 'ArrowRight') {
        event.preventDefault()
        setCurrent((value) => (value + 1) % images.length)
      } else if (several && event.key === 'ArrowLeft') {
        event.preventDefault()
        setCurrent((value) => (value - 1 + images.length) % images.length)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [images.length, several])

  if (!image) return null
  const bytes = dataUrlBytes(image.url)
  const meta = [dimensions, bytes != null ? formatBytes(bytes) : null].filter(Boolean).join(' · ')

  return (
    <DialogRoot open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        bleed
        initialFocus={close}
        showCloseButton={false}
        overlayClassName={styles.overlay}
        aria-describedby={undefined}
        className={styles.content}
      >
        <DialogTitle className="sr-only">{image.name}</DialogTitle>
        <DialogClose
          ref={close}
          render={<Button variant="ghost" size="icon" className={styles.close} aria-label="Close" />}
        >
          <CrossIcon size={16} />
        </DialogClose>
        {several && (
          <Button
            variant="ghost"
            size="icon"
            className={`${styles.arrow} ${styles.arrowLeft}`}
            aria-label="Previous image"
            onClick={() => setCurrent((value) => (value - 1 + images.length) % images.length)}
          >
            <ArrowLeftIcon size={20} />
          </Button>
        )}
        <figure className={styles.figure}>
          <img
            className={styles.image}
            src={image.url}
            alt={image.name}
            onLoad={(event) => {
              const target = event.currentTarget
              setDimensions(`${target.naturalWidth} × ${target.naturalHeight}`)
            }}
          />
          <figcaption className={styles.caption}>
            <span className={styles.name}>{image.name}</span>
            {meta && <span className={styles.meta}>{meta}</span>}
            {several && <span className={styles.meta}>{current + 1} of {images.length}</span>}
          </figcaption>
        </figure>
        {several && (
          <Button
            variant="ghost"
            size="icon"
            className={`${styles.arrow} ${styles.arrowRight}`}
            aria-label="Next image"
            onClick={() => setCurrent((value) => (value + 1) % images.length)}
          >
            <ArrowRightIcon size={20} />
          </Button>
        )}
      </DialogContent>
    </DialogRoot>
  )
}
