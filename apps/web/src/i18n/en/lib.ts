// English source strings for this area. Keys are 'screen.key' (see i18n/index.ts).
// Area: shared helpers under src/lib + api.ts (dates, daily notes, file drops, colours, PWA, …).
export default {
  'lib.titleColumn': 'Title',

  'api.batchFailed': '{failed} of {total} failed',

  'confirm.moveToTrash': 'Move to trash',

  'pwa.updateReady': 'A new version is available.',
  'pwa.reload': 'Reload',
  'pwa.later': 'Later',

  'colors.gray': 'Gray',
  'colors.red': 'Red',
  'colors.orange': 'Orange',
  'colors.yellow': 'Yellow',
  'colors.green': 'Green',
  'colors.blue': 'Blue',
  'colors.purple': 'Purple',
  'colors.pink': 'Pink',

  'fileDrop.imagesOnly': 'Only image files (png, jpg, gif, webp, avif) can be added.',
  'fileDrop.unsupportedType': 'This file type is not supported.',
  'fileDrop.tooLarge': 'File is too large (max {max}).',
  'fileDrop.uploadFailed': "Couldn't upload '{name}'.",

  'daily.folderName': 'Daily',

  'dates.kindRow': 'DB row',
  'dates.kindPage': 'Page',
  'dates.kindDaily': 'Daily',
  'dates.kindTask': 'Task',
  'dates.dailyNote': 'Daily note',
  'dates.topLevel': 'Top level',
  'dates.overdueDays_one': '{count} day overdue',
  'dates.overdueDays_other': '{count} days overdue',
  'dates.rescheduleFailed': "Couldn't reschedule",
  'dates.completed': 'Done: {title}',
  'dates.uncompleted': 'Marked not done: {title}',
  'dates.completeFailed': "Couldn't update completion",
  'dates.undo': 'Undo',
} satisfies Record<string, string>
