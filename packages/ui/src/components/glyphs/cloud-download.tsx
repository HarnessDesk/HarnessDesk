// Vendored from lucide-animated (`cloud-download`); ./index.ts says what changed.

import { motion, type Variants } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const CLOUD_VARIANTS: Variants = {
  initial: { y: 2 },
  active: { y: 0 },
}

export const CloudDownloadGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="cloud-download" {...props}>
    <path d="M4.2 15.1A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.2" />
    <motion.g
      animate={controls}
      transition={{
        duration: 0.3,
        ease: [0.68, -0.6, 0.32, 1.6],
      }}
      variants={CLOUD_VARIANTS}
    >
      <path d="M12 13v8l-4-4" />
      <path d="m12 21 4-4" />
    </motion.g>
  </Glyph>
)
