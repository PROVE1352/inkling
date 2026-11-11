// The instance fuse counts disk blocks, not apparent sizes (0.22.1, contract §15, review N2,
// docs/adr/2545-*). The review's case: 2,000 one-byte uploads were 2,000 bytes to the fuse and 8 MB
// on disk. No database: the walk of a folder only.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { diskBytes, folderDiskBytes } from './instance'

describe('instance fuse: bytes on disk', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'inkling-diskbytes-'))
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('a one-byte file counts the blocks it holds; never less than its size', () => {
    assert.equal(diskBytes({ size: 1, blocks: 8 }), 4096)
    assert.equal(diskBytes({ size: 10_000, blocks: 0 }), 10_000, 'no blocks reported: the apparent size, as 0.22.0')
    assert.equal(diskBytes({ size: 10_000 }), 10_000)
    assert.equal(diskBytes({ size: 1 << 20, blocks: 8 }), 1 << 20, 'a sparse file: its size')
  })

  it('a folder of 300 one-byte uploads: the walk sees what the blocks take, not 300 bytes', async () => {
    const up = path.join(dir, 'uploads')
    mkdirSync(up)
    for (let i = 0; i < 300; i++) writeFileSync(path.join(up, `f${i}`), 'x')
    mkdirSync(path.join(dir, 'tmp', 'deep'), { recursive: true })
    writeFileSync(path.join(dir, 'tmp', 'deep', 'g'), 'y')
    let expected = diskBytes(statSync(dir)) + diskBytes(statSync(up)) + diskBytes(statSync(path.join(dir, 'tmp'))) + diskBytes(statSync(path.join(dir, 'tmp', 'deep')))
    for (let i = 0; i < 300; i++) expected += diskBytes(statSync(path.join(up, `f${i}`)))
    expected += diskBytes(statSync(path.join(dir, 'tmp', 'deep', 'g')))
    const seen = await folderDiskBytes(dir)
    assert.equal(seen, expected)
    assert.ok(seen >= 301, `at least the apparent sizes: ${seen}`)
    if ((statSync(path.join(up, 'f0')).blocks ?? 0) > 0) assert.ok(seen >= 301 * 512, `blocks counted: ${seen}`)
  })

  it('a missing folder is 0 (a fresh install, a test without DATA_DIR)', async () => {
    assert.equal(await folderDiskBytes(path.join(dir, 'nope')), 0)
  })
})
