// Zip import safety (docs/adr/2163-*): entry names (NFC, separators, drive letters, `..`), file
// names without the UTF-8 flag (CP949), symbolic links, the inflate-ratio cap, and which MCP calls
// may carry a large body (import_zip joins upload_file, docs/adr/2162-*).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import JSZip from 'jszip'
import {
  decodeZipFileName,
  isZipSymlink,
  loadZip,
  MAX_ZIP_RATIO,
  normalizeEntryName,
  readZipEntryCapped,
} from './importer'
import { isUploadCall } from '../mcpBody'

/** Replace `from` with `to` (same byte length) everywhere in a zip: local headers and central directory. */
export function patchZipName(zip: Buffer, from: string | Buffer, to: Buffer): Buffer {
  const a = Buffer.isBuffer(from) ? from : Buffer.from(from, 'utf8')
  assert.equal(a.length, to.length)
  const out = Buffer.from(zip)
  let i = out.indexOf(a)
  let n = 0
  while (i >= 0) {
    to.copy(out, i)
    n++
    i = out.indexOf(a, i + a.length)
  }
  assert.ok(n >= 2, 'name found in the local header and the central directory')
  return out
}

describe('zip entry names', () => {
  it('normalizes separators, leading slashes, drive letters, dot segments and NFD Hangul', () => {
    assert.equal(normalizeEntryName('notes\\day1.md'), 'notes/day1.md')
    assert.equal(normalizeEntryName('/etc/passwd.md'), 'etc/passwd.md')
    assert.equal(normalizeEntryName('C:/Users/x/a.md'), 'Users/x/a.md')
    assert.equal(normalizeEntryName('./a//b/./c.md'), 'a/b/c.md')
    assert.equal(normalizeEntryName('folder/'), 'folder/')
    const nfd = '한글'.normalize('NFD')
    assert.notEqual(nfd, '한글')
    assert.equal(normalizeEntryName(`${nfd}/메모.md`.normalize('NFD')), '한글/메모.md')
    assert.equal(normalizeEntryName('a\u0000b\u001f.md'), 'ab.md')
  })

  it('refuses any `..` segment', () => {
    assert.throws(() => normalizeEntryName('../evil.md'), /Unsafe path/)
    assert.throws(() => normalizeEntryName('a/../../evil.md'), /Unsafe path/)
    assert.throws(() => normalizeEntryName('a\\..\\evil.md'), /Unsafe path/)
    assert.equal(normalizeEntryName('a/..b/c.md'), 'a/..b/c.md') // a name that starts with two dots is a name
  })

  it('decodes names without the UTF-8 flag: UTF-8 first, then CP949, then Latin-1', () => {
    assert.equal(decodeZipFileName(Uint8Array.from(Buffer.from('메모.md', 'utf8'))), '메모.md')
    // 한글.md in code page 949 (what Windows Explorer writes on a Korean system)
    assert.equal(decodeZipFileName(Uint8Array.from([0xc7, 0xd1, 0xb1, 0xdb, 0x2e, 0x6d, 0x64])), '한글.md')
    assert.equal(decodeZipFileName([0x61, 0x2e, 0x6d, 0x64]), 'a.md')
  })

  it('a zip whose names are CP949 without the flag loads with readable names', async () => {
    const z = new JSZip()
    z.file('XXXX.md', '# hi')
    const raw = await z.generateAsync({ type: 'nodebuffer' })
    const patched = patchZipName(raw, 'XXXX.md', Buffer.from([0xc7, 0xd1, 0xb1, 0xdb, 0x2e, 0x6d, 0x64]))
    const loaded = await loadZip(patched)
    assert.deepEqual(Object.keys(loaded.files), ['한글.md'])
    // JSZip's own default turns the same bytes into replacement characters
    const plain = await JSZip.loadAsync(patched)
    assert.match(Object.keys(plain.files)[0], /\uFFFD/)
  })
})

describe('zip entries', () => {
  it('spots symbolic links by their Unix mode', async () => {
    const z = new JSZip()
    z.file('link.md', '/etc/passwd', { unixPermissions: 0o120777 })
    z.file('plain.md', 'x', { unixPermissions: 0o100644 })
    const loaded = await loadZip(await z.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }))
    assert.equal(isZipSymlink(loaded.files['link.md']), true)
    assert.equal(isZipSymlink(loaded.files['plain.md']), false)
  })

  it(`stops an entry that inflates more than ${MAX_ZIP_RATIO}x past 1 MB, keeps ordinary ones`, async () => {
    const z = new JSZip()
    z.file('bomb.md', Buffer.alloc(8 * 1024 * 1024, 0x61))
    z.file('small.md', Buffer.alloc(512 * 1024, 0x61)) // highly repetitive but under the 1 MB floor
    z.file('text.md', Array.from({ length: 20000 }, (_, i) => `line ${i} of an ordinary note`).join('\n'))
    const loaded = await loadZip(await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
    await assert.rejects(readZipEntryCapped(loaded.files['bomb.md'], { total: 0 }), /inflates more than/)
    assert.equal((await readZipEntryCapped(loaded.files['small.md'], { total: 0 })).length, 512 * 1024)
    assert.ok((await readZipEntryCapped(loaded.files['text.md'], { total: 0 })).length > 100_000)
  })
})

describe('MCP body limit', () => {
  it('lets upload_file and import_zip (directly or through more_tools) carry a large body, nothing else', () => {
    const call = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    assert.equal(isUploadCall(call('upload_file')), true)
    assert.equal(isUploadCall(call('import_zip')), true)
    assert.equal(isUploadCall(call('more_tools', { tool: 'import_zip' })), true)
    assert.equal(isUploadCall(call('import_folder')), false)
    assert.equal(isUploadCall(call('more_tools', { tool: 'update_page' })), false)
    assert.equal(isUploadCall({ method: 'tools/list' }), false)
  })
})
