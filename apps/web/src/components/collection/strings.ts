// UI strings for the collection extensions (gallery, timeline, relations/rollups, spreadsheet
// import/export, sheets sync). A thin facade over the i18n dictionary (i18n/<locale>/collection.ts):
// every member is a getter or function so the text is looked up in the current locale at render
// time — never at import time.
import type { FieldType, RollupFn, ViewType } from '@inkling/shared'
import { t } from '../../i18n'

export const S = {
  // board: incremental column rendering (docs/adr/0709-board-incremental-columns.md)
  boardShowMore: (n: number) => t('board.showMore', { count: n }),
  get viewGallery() { return t('view.typeGallery') },
  get viewTimeline() { return t('view.typeTimeline') },
  // relation / rollup
  get relation() { return t('field.typeRelation') },
  get rollup() { return t('field.typeRollup') },
  get relationTarget() { return t('relation.target') },
  get relationTwoWay() { return t('relation.twoWay') },
  get relationPaired() { return t('relation.paired') },
  get relationPickTarget() { return t('relation.pickTarget') },
  get relationSearch() { return t('relation.search') },
  get relationEmpty() { return t('relation.empty') },
  get relationMore() { return t('relation.more') },
  relationHiddenCount: (n: number) => t('relation.hiddenCount', { count: n }),
  get relationThis() { return t('relation.thisCollection') },
  get rollupRelation() { return t('relation.rollupRelation') },
  get rollupProperty() { return t('relation.rollupProperty') },
  get rollupFunction() { return t('relation.rollupFunction') },
  get rollupNeedsRelation() { return t('relation.rollupNeedsRelation') },
  get rollupTitle() { return t('table.title') },
  get computed() { return t('relation.computed') },
  // gallery
  get cardCover() { return t('gallery.cardCover') },
  get coverNone() { return t('common.none') },
  get coverPage() { return t('gallery.coverPage') },
  get coverFirstImage() { return t('gallery.coverFirstImage') },
  get cardSize() { return t('gallery.cardSize') },
  get sizeSm() { return t('gallery.sizeSm') },
  get sizeMd() { return t('gallery.sizeMd') },
  get sizeLg() { return t('gallery.sizeLg') },
  get cardProps() { return t('gallery.cardProps') },
  get untitled() { return t('common.untitled') },
  get newCard() { return t('gallery.newCard') },
  // timeline
  get timelineStart() { return t('timeline.start') },
  get timelineEnd() { return t('timeline.end') },
  get timelineSameAsStart() { return t('timeline.sameAsStart') },
  get timelineNoDateField() { return t('timeline.noDateField') },
  get timelineZoom() { return t('timeline.zoom') },
  get zoomDay() { return t('timeline.zoomDay') },
  get zoomWeek() { return t('timeline.zoomWeek') },
  get zoomMonth() { return t('timeline.zoomMonth') },
  get today() { return t('common.today') },
  get noDates() { return t('timeline.noDates') },
  // toolbar menu
  get more() { return t('common.more') },
  get importFile() { return t('collection.importFile') },
  get exportCsv() { return t('collection.exportCsv') },
  get exportXlsx() { return t('collection.exportXlsx') },
  get copyTsv() { return t('collection.copyTsv') },
  get copied() { return t('common.copied') },
  get sheetSync() { return t('collection.sheetSync') },
  // import modal
  get importTitle() { return t('import.title') },
  get importDrop() { return t('import.drop') },
  get importParsing() { return t('import.parsing') },
  get importTarget() { return t('import.target') },
  get importNew() { return t('import.targetNew') },
  get importAppend() { return t('import.targetAppend') },
  get importName() { return t('import.name') },
  get importTitleCol() { return t('import.titleColumn') },
  get importColumn() { return t('import.column') },
  /** default name for a header-less column (1-based) */
  importColumnN: (n: number) => t('import.columnN', { n }),
  get importType() { return t('import.type') },
  get importSkip() { return t('import.skip') },
  importRows: (n: number) => t('import.rows', { count: n }),
  get importPreview() { return t('import.preview') },
  get importStart() { return t('import.start') },
  importProgress: (d: number, total: number) => t('import.progress', { done: d, total }),
  importDone: (n: number) => t('import.done', { count: n }),
  get importSheet() { return t('import.sheet') },
  errTooBig: (mb: number) => t('import.errTooBig', { mb }),
  errTooManyRows: (n: number) => t('import.errTooManyRows', { n }),
  errTooManyCols: (n: number) => t('import.errTooManyCols', { n }),
  get errUnsupported() { return t('import.errUnsupported') },
  get errEmpty() { return t('import.errEmpty') },
  get errRead() { return t('import.errRead') },
  get cancel() { return t('common.cancel') },
  get close() { return t('common.close') },
  get save() { return t('common.save') },
  // paste
  pasteRows: (n: number) => t('table.pasteRows', { count: n }),
  get pasteFailed() { return t('table.pasteFailed') },
  // sheets sync
  get syncTitle() { return t('sheetSync.title') },
  get syncHelp() { return t('sheetSync.help') },
  get syncUrl() { return t('sheetSync.url') },
  get syncKey() { return t('sheetSync.key') },
  get syncTitleCol() { return t('sheetSync.titleColumn') },
  get syncInterval() { return t('sheetSync.interval') },
  get syncEnabled() { return t('sheetSync.enabled') },
  get syncNow() { return t('sheetSync.now') },
  get syncRemove() { return t('sheetSync.remove') },
  get syncLast() { return t('sheetSync.last') },
  get syncNever() { return t('sheetSync.never') },
  syncStats: (i: number, u: number, n: number) =>
    t('sheetSync.stats', { inserted: i, updated: u, unchanged: n }),
}

export const ROLLUP_LABEL = {
  get count() { return t('relation.fnCount') },
  get sum() { return t('relation.fnSum') },
  get avg() { return t('relation.fnAvg') },
  get min() { return t('relation.fnMin') },
  get max() { return t('relation.fnMax') },
  get earliest() { return t('relation.fnEarliest') },
  get latest() { return t('relation.fnLatest') },
  get percentChecked() { return t('relation.fnPercentChecked') },
  get showUnique() { return t('relation.fnShowUnique') },
} satisfies Record<RollupFn, string>

/** Field (property) type names, translated on access. */
export const FIELD_TYPE_LABEL = {
  get text() { return t('field.typeText') },
  get number() { return t('field.typeNumber') },
  get select() { return t('field.typeSelect') },
  get multiSelect() { return t('field.typeMultiSelect') },
  get date() { return t('field.typeDate') },
  get checkbox() { return t('field.typeCheckbox') },
  get person() { return t('field.typePerson') },
  get url() { return t('field.typeUrl') },
  get relation() { return t('field.typeRelation') },
  get rollup() { return t('field.typeRollup') },
} satisfies Record<FieldType, string>

/** View type names, translated on access. Also the default name of a new view. */
export const VIEW_TYPE_LABEL = {
  get table() { return t('view.typeTable') },
  get board() { return t('view.typeBoard') },
  get calendar() { return t('view.typeCalendar') },
  get gallery() { return t('view.typeGallery') },
  get timeline() { return t('view.typeTimeline') },
} satisfies Record<ViewType, string>
