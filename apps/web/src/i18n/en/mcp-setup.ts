// Connection settings generator (docs/adr/2020-*) and the instruction page length warning (docs/adr/2021-*).
export default {
  'mcpSetup.title': 'Connect an AI app',
  'mcpSetup.client': 'App',
  'mcpSetup.clientGeneric': 'Other app (mcpServers JSON)',
  'mcpSetup.profile': 'Tools',
  'mcpSetup.profileFull': 'All tools',
  'mcpSetup.profileFullHint': 'Every Inkling tool. The default.',
  'mcpSetup.profileCore': 'Core tools',
  'mcpSetup.profileCoreHint': 'Only the tools agents use most. A shorter tool list costs fewer tokens at the start of every session; switch to all tools when one is missing.',
  'mcpSetup.auth': 'Sign-in',
  'mcpSetup.authOauth': 'Sign in on this site',
  'mcpSetup.authOauthHint': 'The app opens a consent screen here. Only the URL is needed.',
  'mcpSetup.authToken': 'Agent connection token',
  'mcpSetup.authTokenHint': 'For apps that cannot register themselves for sign-in, local http and self-signed setups. Make one below: it is an agent connection like a signed-in app, under the name you give it. Anyone with the token acts as that agent for you.',
  'mcpSetup.steps.claudeCode':
    'Run this in a terminal, then open /mcp in Claude Code → inkling → Authenticate.',
  'mcpSetup.steps.claudeCodeToken': 'Run this in a terminal. Claude Code sends the header with every request and does not ask you to sign in.',
  'mcpSetup.steps.cursor':
    'Put this in .cursor/mcp.json in a project, or in ~/.cursor/mcp.json for every project. If the file already lists servers, add the "inkling" entry inside its mcpServers.',
  'mcpSetup.steps.vscode':
    'Put this in .vscode/mcp.json in a workspace, or run "MCP: Open User Configuration" for every workspace. If the file already lists servers, add the "inkling" entry inside its servers. VS Code also reads the portable format (.mcp.json at the workspace root or ~/.copilot/mcp-config.json); for that, use the "Other app" JSON.',
  'mcpSetup.steps.generic':
    'The mcpServers shape of Claude Code’s .mcp.json and VS Code’s portable format. Other apps name the keys differently (Cursor, for one, takes url without type), so check the app’s documentation.',
  'mcpSetup.claudeAiHeader':
    'With a token: choose No sign-in, then add a request header named authorization with this value. Request headers are in beta for some organizations only; without that section, use sign-in.',
  'mcpSetup.tokenPlaceholder': 'The token above is a placeholder. A new agent connection token is shown once and fills in here while it is shown (personal API tokens do not work at /mcp).',
  'mcpSetup.tokenCreate': 'Make an agent connection token',
  'mcpSetup.tokenFilled': 'Filled in with the token you just created. It is not shown again after Done, so copy the settings now.',
  'mcpSetup.vscodeInput':
    'VS Code asks for the token the first time it starts the server and keeps it in its secret storage, so the file holds no token.',
  'mcpSetup.helpTitle': 'Local servers and certificates',
  'mcpSetup.helpPublicUrl':
    'Use the address the server is configured with (PUBLIC_URL). Sign-in is issued for that address only, so another address for the same server (a LAN IP, another port) fails.',
  'mcpSetup.helpClaudeAi':
    'claude.ai and Claude Desktop connectors connect from Anthropic’s servers, not from your computer. The server must be reachable from the internet: localhost, a LAN address or a VPN-only server does not work there.',
  'mcpSetup.helpClaudeCodeHttp':
    'Claude Code signs in only over HTTPS or at localhost, 127.0.0.1 and ::1. On plain http:// at any other address (a server elsewhere on your network) sign-in fails.',
  'mcpSetup.helpSelfSigned':
    'Self-signed or private CA certificate: Claude Code trusts the system certificate store and its own bundled list, and its network settings page documents NODE_EXTRA_CA_CERTS=/path/to/ca.pem for a private CA. Other apps have their own settings.',
  'mcpSetup.helpProfileChange':
    'Changing the tools changes the URL: remove the server from the app and add it again (Claude Code: claude mcp remove inkling).',

  // Agent connection tokens (docs/adr/2060-*) and suggest-only connections in the lists (docs/adr/2042-*)
  'agentTokens.title': 'Agent connection tokens',
  'agentTokens.intro':
    'For AI apps that cannot sign in here: no automatic registration, local http, self-signed certificates. A token is an agent connection like a signed-in app: its edits read "you (via the name)", the workspace\u2019s agent rules apply, and admins can block it. It works only at /mcp; for scripts and inklingctl use a personal API token.',
  'agentTokens.new': 'New token',
  'agentTokens.name': 'Name, shown as "via …" next to its edits',
  'agentTokens.namePlaceholder': 'e.g. Claude Code on my laptop',
  'agentTokens.expiry': 'Expires after',
  'agentTokens.expiryDays': '{days} days',
  'agentTokens.expiryHint': 'There is no "never": make a new token when it runs out.',
  'agentTokens.create': 'Make token',
  'agentTokens.creating': 'Making…',
  'agentTokens.cancel': 'Cancel',
  'agentTokens.createdTitle': 'Copy this token now. It is not shown again.',
  'agentTokens.createdHint': 'While it is shown, the connection settings above use it. Inkling keeps only a hash of it.',
  'agentTokens.done': 'Done',
  'agentTokens.empty': 'No agent connection tokens.',
  'agentTokens.loadFailed': 'Could not load agent connection tokens.',
  'agentTokens.meta': 'Made {created} · expires {expires} · last used {lastUsed}',
  'agentTokens.never': 'never',
  'agentTokens.expired': 'Expired',
  'agentTokens.revoke': 'Revoke',
  'agentTokens.revokeConfirm': 'Revoke "{name}"? Apps using it are cut off at once.',
  'suggestOnly.badge': 'Suggestions only until {time}',
  'suggestOnly.tooltip': 'This connection read text that looks like a prompt injection. Its edits wait for review.',
  'suggestOnly.release': 'Allow edits again',
  'suggestOnly.releaseFailed': 'Could not lift it. Try again.',

  'instructionLength.badge': 'long · ~{tokens} tok',
  'instructionLength.title': 'This instruction page is long (~{tokens} tokens).',
  'instructionLength.body':
    'Agents read it in full at the start of their work in this workspace, every session. Keep the rules and a short index of where things are, with links; move the details into normal pages, which agents find with find_context when they need them.',
}
