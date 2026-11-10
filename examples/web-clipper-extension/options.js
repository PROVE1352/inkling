const input = document.getElementById('server')
const status = document.getElementById('status')

chrome.storage.sync.get('server').then(({ server }) => {
  if (typeof server === 'string') input.value = server
})

document.getElementById('save').addEventListener('click', async () => {
  let value = input.value.trim()
  try {
    const u = new URL(value)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error()
    value = u.origin
  } catch {
    status.textContent = 'Enter an address starting with https://'
    return
  }
  await chrome.storage.sync.set({ server: value })
  status.textContent = 'Saved'
})
