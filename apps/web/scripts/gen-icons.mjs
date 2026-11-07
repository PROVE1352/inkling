// Generates PWA icons: public/icon.svg → public/icons/*.png
import sharp from 'sharp'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const src = fileURLToPath(new URL('../public/icon.svg', import.meta.url))
const outDir = fileURLToPath(new URL('../public/icons/', import.meta.url))
await mkdir(outDir, { recursive: true })

const targets = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
]
for (const [name, size] of targets) {
  await sharp(src, { density: 300 }).resize(size, size).png().toFile(outDir + name)
}

// maskable: centred at 80% size to stay inside the safe zone
const inner = await sharp(src, { density: 300 }).resize(410, 410).png().toBuffer()
await sharp({
  create: { width: 512, height: 512, channels: 4, background: '#191919' },
})
  .composite([{ input: inner, gravity: 'centre' }])
  .png()
  .toFile(outDir + 'maskable-512.png')

console.log('icons generated →', outDir)
