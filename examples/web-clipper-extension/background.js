// Toolbar button → the server's /clip window with the tab's title, address and selected text
// (docs/adr/2263-*). Same query as the bookmarklet in Settings › Web clipper; the window uses the
// browser's own Inkling sign-in. The extension holds no token: it only knows the server address.
// Unlike a bookmarklet it is not blocked by a site's Content-Security-Policy.

const MAX_TEXT = 4000 // characters of selection sent (the /clip address stays short)

async function serverUrl() {
  const { server } = await chrome.storage.sync.get('server')
  return typeof server === 'string' && /^https?:\/\//.test(server) ? server.replace(/\/+$/, '') : null
}

async function selectionOf(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => String(window.getSelection ? window.getSelection() : '').trim(),
    })
    return typeof res?.result === 'string' ? res.result : ''
  } catch {
    return '' // pages the extension may not script (chrome://, the web store)
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  const server = await serverUrl()
  if (!server) {
    chrome.runtime.openOptionsPage()
    return
  }
  let text = await selectionOf(tab.id)
  if (text.length > MAX_TEXT) text = Array.from(text).slice(0, MAX_TEXT).join('') + '…'
  const q = new URLSearchParams({ title: (tab.title || '').slice(0, 300), url: (tab.url || '').slice(0, 2048) })
  if (text) q.set('text', text)
  await chrome.windows.create({ url: `${server}/clip?${q}`, type: 'popup', width: 520, height: 680 })
})
