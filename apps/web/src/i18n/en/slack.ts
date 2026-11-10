// Slack app per workspace: settings tab (components/SlackPanel.tsx) and the one-time account link
// page /slack/link (pages/SlackLink.tsx). docs/adr/1800-* .. 1806-*.
export default {
  'slack.tab': 'Slack',
  'slack.intro':
    'Connect a Slack app to this workspace: notifications in a channel, /inkling search, and previews when someone pastes an Inkling link. Only pages shared with the whole workspace are ever named in Slack.',

  // Setup help
  'slack.setupTitle': 'Create the Slack app',
  'slack.step1': 'Open api.slack.com/apps, choose Create New App → From an app manifest, pick your Slack workspace and paste the manifest below.',
  'slack.step2': 'Install the app to your Slack workspace (Install App).',
  'slack.step3': 'Copy the Bot User OAuth Token (OAuth & Permissions) and the Signing Secret (Basic Information) into the form below.',
  'slack.step4': 'Add the ID of the channel to post to (C…). It is at the bottom of the channel details.',
  'slack.step5': 'For a private channel, invite the bot first: type /invite @<app name> in that channel.',
  'slack.commandUrl': 'Slash command URL',
  'slack.eventsUrl': 'Event subscriptions URL',
  'slack.unfurlDomain': 'Link unfurl domain',
  'slack.noPublicUrl':
    'PUBLIC_URL is not set on the server, so these URLs follow the address this page was opened on and link previews have no domain. Set PUBLIC_URL (or APP_URL) and restart the server.',
  'slack.scopes': 'Bot scopes',
  'slack.manifest': 'App manifest (JSON)',
  'slack.manifestHint': 'The URLs above are already filled in.',

  // Form
  'slack.connectionTitle': 'Connection',
  'slack.botToken': 'Bot token',
  'slack.botTokenDesc': 'Bot User OAuth Token, starts with xoxb-.',
  'slack.signingSecret': 'Signing secret',
  'slack.signingSecretDesc': 'Basic Information → App Credentials. Slack signs every request with it.',
  'slack.keepSaved': 'Leave empty to keep the saved value.',
  'slack.savedPlaceholder': 'saved',
  'slack.channelId': 'Channel ID',
  'slack.channelIdDesc': 'The ID (C… or G…), not the #name: names change, IDs do not.',
  'slack.eventsTitle': 'Channel notifications',
  'slack.eventsDesc': 'What gets posted to the channel.',
  'slack.eventMention': 'Mentions',
  'slack.eventMentionDesc': 'Someone is @mentioned in a page or a comment.',
  'slack.eventAssigned': 'Assignments',
  'slack.eventAssignedDesc': 'Someone is made a page owner or put in a person field.',
  'slack.eventSuggestion': 'Edit suggestions',
  'slack.eventSuggestionDesc': 'An agent left an edit suggestion waiting for a person.',
  'slack.eventReply': 'Replies',
  'slack.eventReplyDesc': 'Someone replies in a comment thread.',
  'slack.eventDigest': 'Daily digest',
  'slack.eventDigestDesc': 'Once a day, the shared pages that changed in the last day.',
  'slack.enabled': 'Enabled',
  'slack.enabledDesc': 'Turn off to pause the integration without removing its settings.',
  'slack.connect': 'Connect',
  'slack.saved': 'Saved.',
  'slack.secretsRequired': 'Enter the bot token and the signing secret.',
  'slack.invalidToken': 'A bot token starts with xoxb-.',
  'slack.invalidSecret': 'The signing secret is a hexadecimal string.',
  'slack.invalidChannel': 'Use the channel ID (C…), not its name.',
  'slack.authFailed': 'Slack rejected the token ({code}). Copy the Bot User OAuth Token of the installed app again.',
  'slack.noKeyWarning':
    'APP_SECRET_KEY is not set on the server, so the bot token and signing secret are stored unencrypted. Set APP_SECRET_KEY and save them again to encrypt them.',

  // Status
  'slack.statusTitle': 'Status',
  'slack.team': 'Slack workspace',
  'slack.channel': 'Channel',
  'slack.storage': 'Stored secrets',
  'slack.sealed': 'Encrypted with APP_SECRET_KEY',
  'slack.unsealed': 'Stored unencrypted because APP_SECRET_KEY is not set',
  'slack.unreadable':
    'The saved token and signing secret cannot be read (APP_SECRET_KEY is missing or changed). Enter both again and save.',
  'slack.blocked': 'Channel posts are paused: {reason}',
  'slack.blockedHint': 'Fix it in Slack, then save or send a test message to resume.',
  'slack.lastSuccess': 'Last post',
  'slack.lastError': 'Last error',
  'slack.never': 'Never',
  'slack.test': 'Send test message',
  'slack.testOk': 'Test message posted to the channel.',
  'slack.testFail': 'Slack answered {error}.',
  'slack.disconnect': 'Disconnect',
  'slack.disconnectConfirm':
    'Disconnect Slack from this workspace? The stored token and secret are deleted and linked accounts are removed. The app stays installed in Slack until you remove it there.',

  // Linked accounts
  'slack.linksTitle': 'Linked Slack accounts',
  'slack.linksDesc':
    'Members link themselves by typing /inkling link in Slack, or automatically when their Slack email is the same as their Inkling email.',
  'slack.linksEmpty': 'No linked accounts yet.',
  'slack.methodEmail': 'by email',
  'slack.methodLink': 'by link',

  // /slack/link
  'slack.linkTitle': 'Link your Slack account',
  'slack.linkBody': 'Link Slack user {slackUser} ({team}) to your Inkling account in {workspace}?',
  'slack.linkSignedInAs': 'Signed in as {email}',
  'slack.linkOtherAccount': 'Use another account',
  'slack.linkConfirm': 'Link',
  'slack.linkDone': 'Your Slack account is linked.',
  'slack.linkOpenWorkspace': 'Open the workspace',
  'slack.linkExpired': 'This link has expired or was already used.',
  'slack.linkNewHint': 'Type /inkling link in Slack to get a new link.',
  'slack.linkNoCode': 'This link has no code.',
  'slack.linkNotMember': 'You are not a member of {workspace}.',
  'slack.linkNotMemberGeneric': 'You are not a member of that workspace.',
  'slack.linkNotMemberHint': 'Ask a workspace owner to invite you, or sign in with the account that is a member.',
  'slack.linkSignInFirst': 'Sign in to Inkling, then open the link from Slack again.',
  'slack.linkFailed': 'Could not link the account.',
}
