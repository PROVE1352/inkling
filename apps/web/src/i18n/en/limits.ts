// English source strings for limits and features turned off (restricted mode, docs/adr/2505-* .. 2511-*):
// the usage card in workspace settings and the notice of a full workspace.
export default {
  'limits.usageTitle': 'Usage',
  'limits.members': 'Members',
  'limits.pages': 'Pages (trash included)',
  'limits.storage': 'Storage',
  'limits.storageFiles': 'Files: {size}',
  'limits.ofLimit': '{used} of {limit}',
  'limits.loading': 'Counting…',
  'limits.loadFailed': 'Could not load the usage.',
  'limits.storageHint': 'Storage counts files, page bodies, version history, handwriting, comments and the trash.',
  'limits.fullTitle': 'Storage is full',
  'limits.fullBody': 'This workspace has used up its storage, so it is read-only. Delete files or pages (and empty the trash) to edit again.',
  'limits.fullSettings': 'See usage',
  'limits.trashCapped': 'Pages in the trash are deleted for good after this many days. This server keeps them at most {cap} days ({min}–{cap}).',
  'limits.featureOff': 'This server has turned this feature off.',
  'limits.instanceFull': "This server's storage is full. For now you can only read and delete.",
} as const
