// Typing of uploads through a connection (docs/adr/2045-*): the name says what it claims, the bytes
// must agree; active and unknown types are refused.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { agentUploadMime, isPlainText, magicMime } from './uploadCheck'
import { OPEN_WHILE_SUGGEST_ONLY } from './agentTaint'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

describe('uploads through a connection', () => {
  it('images and PDF by their magic bytes, text by strict UTF-8', () => {
    assert.equal(magicMime(PNG), 'image/png')
    assert.equal(magicMime(Buffer.from('%PDF-1.7\n')), 'application/pdf')
    assert.equal(magicMime(Buffer.from('<svg/>')), null)
    assert.deepEqual(agentUploadMime('chart.PNG', PNG), { mime: 'image/png' })
    assert.deepEqual(agentUploadMime('data.csv', Buffer.from('a,b\n1,2\n')), { mime: 'text/csv' })
    assert.deepEqual(agentUploadMime('notes.md', Buffer.from('# 제목\n')), { mime: 'text/markdown' })
    assert.deepEqual(agentUploadMime('run.log', Buffer.from('ok')), { mime: 'text/plain' })
    assert.ok(isPlainText(Buffer.from('﻿bom')))
    assert.ok(!isPlainText(Buffer.from([0x61, 0x00])))
    assert.ok(!isPlainText(Buffer.from([0xc3, 0x28])))
  })

  it('name and bytes that disagree, active and unknown types are refused', () => {
    assert.match((agentUploadMime('chart.png', Buffer.from('<svg onload=1>')) as { error: string }).error, /name and bytes disagree/)
    assert.match((agentUploadMime('x.jpg', PNG) as { error: string }).error, /not a JPG/)
    for (const n of ['a.svg', 'a.html', 'a.js', 'a.exe', 'a.zip', 'noext']) {
      assert.match((agentUploadMime(n, Buffer.from('x')) as { error: string }).error, /cannot be uploaded through a connection/, n)
    }
    assert.match((agentUploadMime('bin.txt', Buffer.from([1, 0, 2])) as { error: string }).error, /UTF-8 text without NUL/)
  })

  it('the routes that stay open while a connection is suggest-only (docs/adr/2040-*)', () => {
    const open = (r: string) => OPEN_WHILE_SUGGEST_ONLY.some((re) => re.test(r))
    for (const r of ['/api/pages/:id/section', '/api/pages/:id/sections', '/api/pages/:id/content', '/api/pages/:id/comments', '/api/comments/:id', '/api/pages/:id/claims', '/api/suggestions/:id/withdraw', '/api/inbox/ack', '/api/later', '/api/later/:id']) {
      assert.ok(open(r), r)
    }
    for (const r of ['/api/pages', '/api/pages/:id', '/api/files', '/api/pages/:id/props', '/api/pages/:id/collection/rows', '/api/pages/:id/restore', '/api/workspaces/:id/import', '/api/suggestions/:id/accept', '/api/pages/:id/rotation/target']) {
      assert.ok(!open(r), r)
    }
  })
})
