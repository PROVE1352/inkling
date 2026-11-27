// English strings for the sidebar order (docs/adr/2590-*, 2591-*, 2592-*), the collapsible account
// block and the notification for a workspace an agent created (docs/adr/2596-*).
export default {
  'rowMenu.pin': 'Pin to top',
  'rowMenu.unpin': 'Unpin',
  'rowMenu.sortByTitle': 'Sort subpages by title',
  'rowMenu.agentDefault': 'New agent pages go here',
  'tree.pinned': 'Pinned',
  'tree.orderFailed': "Couldn't change the order",

  'sidebarOrder.group': 'Sidebar order',
  'sidebarOrder.sharedTitle': 'Sort the shared section by title',
  'sidebarOrder.sharedDesc': 'Top-level shared pages in title order for everyone, numbers counted as numbers ("2" before "10"). Pinned pages stay on top.',
  'sidebarOrder.privateTitle': 'Sort my private section by title',
  'sidebarOrder.privateDesc': 'Only for you. Pinned pages stay on top.',

  'agentDefault.group': 'New pages from agents',
  'agentDefault.title': 'Where agents put new pages',
  'agentDefault.desc':
    'When an agent or API token creates a shared page without naming a parent, it goes under this page. An agent that names a parent, or may not write here, works as before. Pick the page with "New agent pages go here" in its sidebar menu.',
  'agentDefault.none': 'Top level (not set)',
  'agentDefault.clear': 'Clear',

  'sidebar.accountCollapse': 'Hide account details',
  'sidebar.accountExpand': 'Show account details',

  'notifications.agentWorkspace': 'An agent created the workspace "{workspace}" for you',
}
