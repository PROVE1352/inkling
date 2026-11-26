// A workspace someone else added me to stays out of my agent connections until I include it (docs/adr/2580-*).
export default {
  'agentInclusion.line': "Workspace your agents can't see yet: {workspace} (added by {actor})",
  'agentInclusion.lineNoActor': "Workspace your agents can't see yet: {workspace}",
  'agentInclusion.include': 'Include',
  'agentInclusion.confirm':
    'Let your agents see "{workspace}"? Connections with access to all your notes will read its pages and follow its agent instructions. Include it only if you trust the people who run it.',
  'agentInclusion.failed': 'Could not include it. Try again.',
}
