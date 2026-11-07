// Run: cd apps/server && npx tsx --test src/embeds.test.ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { toEmbed } from '@inkling/shared'

const table: [string, string | null][] = [
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
  ['https://youtu.be/dQw4w9WgXcQ?t=90', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90'],
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90'],
  ['https://m.youtube.com/shorts/dQw4w9WgXcQ', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
  ['https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG', 'https://www.youtube-nocookie.com/embed/videoseries?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG'],
  ['https://vimeo.com/76979871', 'https://player.vimeo.com/video/76979871'],
  ['https://vimeo.com/76979871/a1b2c3d4e5', 'https://player.vimeo.com/video/76979871?h=a1b2c3d4e5'],
  ['https://player.vimeo.com/video/76979871', 'https://player.vimeo.com/video/76979871'],
  ['https://www.loom.com/share/0281766fa2d04bb788eaf19e65135184', 'https://www.loom.com/embed/0281766fa2d04bb788eaf19e65135184'],
  ['https://www.figma.com/design/AbCdEfGhIjKlMn0123/My-File?node-id=12-34&t=x', 'https://www.figma.com/embed?embed_host=inkling&url=https%3A%2F%2Fwww.figma.com%2Fdesign%2FAbCdEfGhIjKlMn0123%3Fnode-id%3D12-34'],
  ['https://miro.com/app/board/uXjVOabc123=/', 'https://miro.com/app/live-embed/uXjVOabc123=/'],
  ['https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit', 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/preview'],
  ['https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0', 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/preview'],
  ['https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit', 'https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/embed'],
  ['https://docs.google.com/document/d/e/2PACX-1vAbCdEfGhIjKlMnOpQrStUv/pub', 'https://docs.google.com/document/d/e/2PACX-1vAbCdEfGhIjKlMnOpQrStUv/pub?embedded=true'],
  ['https://gist.github.com/octocat/6cad326836d38bd3a7ae', 'https://gist.github.com/octocat/6cad326836d38bd3a7ae.pibb'],
  ['https://codepen.io/team/pen/abcDEF1', 'https://codepen.io/team/embed/abcDEF1?default-tab=result'],
  ['https://excalidraw.com/#json=AbCdEfGh1234,XyZ_-9876abcd', 'https://excalidraw.com/#json=AbCdEfGh1234,XyZ_-9876abcd'],
  ['https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc', 'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC'],
  ['https://open.spotify.com/intl-ko/album/1DFixLWuPkv3KT3TnV35m3', 'https://open.spotify.com/embed/album/1DFixLWuPkv3KT3TnV35m3'],
  // ---- must NOT embed ----
  ['https://evil.com/youtube.com/watch?v=dQw4w9WgXcQ', null],
  ['https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ', null],
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ"><script>', null],
  ['https://www.youtube.com/watch?v=short', null],
  ['javascript:alert(1)//youtube.com/watch?v=dQw4w9WgXcQ', null],
  ['https://user:pw@www.youtube.com/watch?v=dQw4w9WgXcQ', null],
  ['https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ', null],
  ['https://excalidraw.com/#room=abc12345,def67890', null],
  ['https://gist.github.com/octocat/../../evil', null],
  ['https://docs.google.com/forms/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/viewform', null],
  ['https://example.com/', null],
  ['not a url', null],
]

describe('toEmbed', () => {
  for (const [input, want] of table) {
    it(`${input} -> ${want ?? 'null'}`, () => assert.equal(toEmbed(input)?.src ?? null, want))
  }
})
