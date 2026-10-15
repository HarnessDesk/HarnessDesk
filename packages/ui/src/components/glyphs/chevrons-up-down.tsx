// Vendored from lucide-animated (`chevrons-up-down`); ./index.ts says what changed.

import { motion, type Transition } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const DEFAULT_TRANSITION: Transition = {
  type: 'spring',
  stiffness: 250,
  damping: 25,
}

export const ChevronsUpDownGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="chevrons-up-down" {...props}>
    <motion.path
      animate={controls}
      d="m7 15 5 5 5-5"
      initial="normal"
      transition={DEFAULT_TRANSITION}
      variants={{
        normal: { translateY: '0%' },
        animate: { translateY: '2px' },
      }}
    />
    <motion.path
      animate={controls}
      d="m7 9 5-5 5 5"
      initial="normal"
      transition={DEFAULT_TRANSITION}
      variants={{
        normal: { translateY: '0%' },
        animate: { translateY: '-2px' },
      }}
    />
  </Glyph>
)
