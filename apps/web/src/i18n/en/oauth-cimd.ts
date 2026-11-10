// English source strings for apps identified by a Client ID Metadata Document (docs/adr/2282-*).
export default {
  'oauthCimd.identity': 'Identified by {host}',
  'oauthCimd.identityHint':
    'The app name above comes from a document the app publishes at {host}; Inkling does not check it. Allow only if you expected an app from {host}.',
  'oauthCimd.loopbackWarn':
    'This sign-in goes back to a program on this computer (localhost). Any program running here can claim to be {host}. Allow only if you just started the connection yourself.',
  'oauthCimd.connectionHost': 'from {host}',
}
