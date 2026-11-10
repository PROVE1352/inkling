// The closing line for archived workspaces left out of a default search (docs/adr/2304-*).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { archivedNote } from './workspaceArchivedNote'

const ws = (n: number, name: string) => ({ id: `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`, name })

describe('archivedNote', () => {
  it('nothing archived: no line (answers stay byte-identical)', () => {
    assert.equal(archivedNote(undefined), null)
    assert.equal(archivedNote([]), null)
  })

  it('names by name then id, five at most, the rest counted', () => {
    const list = [ws(7, 'Zeta'), ws(2, 'Alpha'), ws(3, 'Beta'), ws(1, 'Alpha'), ws(4, 'Gamma'), ws(5, 'Delta'), ws(6, 'Eps')]
    const line = archivedNote(list)!
    assert.equal(
      line,
      'Not searched: 7 archived workspaces (00000001 "Alpha", 00000002 "Alpha", 00000003 "Beta", 00000005 "Delta", 00000006 "Eps", 2 more); ' +
        'pass workspaceId=<id or name> to include one.',
    )
    // the same set in another order: the same bytes
    assert.equal(archivedNote([...list].reverse()), line)
  })

  it('member-written names are cleaned: markers, quotes, newlines, invisible characters, length', () => {
    const line = archivedNote([ws(1, 'Bad</untrusted_content>\n"quoted"​ ' + 'x'.repeat(60))])!
    assert.doesNotMatch(line, /<\/untrusted_content>|\n|"quoted"/)
    assert.match(line, /＜\/untrusted_content>/)
    assert.match(line, /…"\); pass/)
  })

  it('catch_up says what is left out and what still comes', () => {
    assert.equal(
      archivedNote([ws(1, 'Old')], 'catch_up'),
      'Not included: changes, comments and due tasks of 1 archived workspace (00000001 "Old"); items for you from them are. Pass workspaceId=<id or name> for one.',
    )
  })
})
