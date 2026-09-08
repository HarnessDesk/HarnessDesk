import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { dataUrlBytes, formatBytes } from '../lib/images'
import { ArrowLeftIcon, ArrowRightIcon, CrossIcon } from './Icons'
import styles from './Lightbox.module.css'

/**
 * One image at full size over the whole window — what a thumbnail opens to.
 *
 * It takes the whole set the thumbnail came from so the arrow keys walk the
 * images of one message without closing and reopening. Escape, the backdrop,
 * and the close button all dismiss; the image itself does not, because a
 * click there usually means "I am looking at this".
 */

export interface LightboxImage {
  readonly url: string
  readonly name: string
}

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

  useEffect(() => {
    setCurrent(index)
  }, [index])

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      } else if (several && event.key === 'ArrowRight') {
        event.preventDefault()
        setCurrent((value) => (value + 1) % images.length)
      } else if (several && event.key === 'ArrowLeft') {
        event.preventDefault()
        setCurrent((value) => (value - 1 + images.length) % images.length)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [images.length, onClose, several])

  if (!image) return null
  const bytes = dataUrlBytes(image.url)
  const meta = [dimensions, bytes != null ? formatBytes(bytes) : null].filter(Boolean).join(' · ')

  // Portalled to the body: a pane is its own stacking context, and a viewer
  // that sat inside one would be painted over by banners outside it.
  return createPortal(
    <div className={styles.backdrop} role="dialog" aria-label={image.name} onClick={onClose}>
      <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
        <CrossIcon size={16} />
      </button>
      {several && (
        <button
          type="button"
          className={`${styles.arrow} ${styles.arrowLeft}`}
          aria-label="Previous image"
          onClick={(event) => {
            event.stopPropagation()
            setCurrent((value) => (value - 1 + images.length) % images.length)
          }}
        >
          <ArrowLeftIcon size={20} />
        </button>
      )}
      <figure className={styles.figure} onClick={(event) => event.stopPropagation()}>
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
          {several && (
            <span className={styles.meta}>
              {current + 1} of {images.length}
            </span>
          )}
        </figcaption>
      </figure>
      {several && (
        <button
          type="button"
          className={`${styles.arrow} ${styles.arrowRight}`}
          aria-label="Next image"
          onClick={(event) => {
            event.stopPropagation()
            setCurrent((value) => (value + 1) % images.length)
          }}
        >
          <ArrowRightIcon size={20} />
        </button>
      )}
    </div>,
    document.body,
  )
}
