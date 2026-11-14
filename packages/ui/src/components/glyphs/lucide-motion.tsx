import { Database, Folder, Globe, Monitor, Smartphone, Sparkle, type LucideIcon } from 'lucide-react'
import { motion } from 'motion/react'
import type { ComponentProps } from 'react'
import type { GlyphProps } from './glyph'

/** Keep the original Lucide drawing when upstream has no matching motion.
 * Only its SVG root moves; Animated still owns activation and accessibility.
 */
const lucideMotion = (Icon: LucideIcon) => {
  const Drawing = motion.create(Icon)
  return ({ controls, name: _name, ...props }: GlyphProps) => (
    <Drawing
      {...(props as ComponentProps<typeof Drawing>)}
      animate={controls}
      initial="normal"
      variants={{ normal: { scale: 1 }, animate: { scale: 1.12 } }}
      transition={{ type: 'spring', stiffness: 200, damping: 15 }}
    />
  )
}

export const DatabaseGlyph = lucideMotion(Database)
export const FolderGlyph = lucideMotion(Folder)
export const GlobeGlyph = lucideMotion(Globe)
export const MonitorGlyph = lucideMotion(Monitor)
export const SmartphoneGlyph = lucideMotion(Smartphone)
export const SparkleGlyph = lucideMotion(Sparkle)
