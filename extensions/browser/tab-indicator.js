/** Serialized into the page world; keep the favicon controller self-contained. */
function pageIndicator(command) {
  if (window !== window.top || Date.now() > command.expiresAt) return false
  const selector = 'meta[data-dsh-tab-indicator]'
  const previous = document.querySelector(selector)
  if (command.type === 'dispose') {
    if (previous?.indicator?.owner === command.owner) previous.indicator.dispose()
    return true
  }
  if (command.type !== 'sync' || !document.head || location.href !== command.documentUrl) return false
  if (previous?.indicator?.owner === command.owner) return previous.indicator.update(command)
  previous?.indicator?.dispose()

  const host = document.createElement('meta')
  host.setAttribute('data-dsh-tab-indicator', command.owner)
  const records = new Map()
  let disposed = false
  let timer = 0
  let revision = 0
  let cachedIcon
  let decoded

  function restore(link, record) {
    // The site may have replaced its favicon while we owned the tab.
    if (link.getAttribute('href') !== record.badgeHref) return
    if (record.created) link.remove()
    else if (record.href === null) link.removeAttribute('href')
    else link.setAttribute('href', record.href)
    // rel, sizes, parent and order remain entirely under the site's control.
  }

  function clearBadge() {
    for (const [link, record] of records) restore(link, record)
    records.clear()
  }

  function dispose() {
    if (disposed) return
    disposed = true
    revision += 1
    clearTimeout(timer)
    clearBadge()
    host.remove()
  }

  function current(next, version) {
    return !disposed && revision === version && host.isConnected
      && host.indicator.owner === next.owner && document.querySelector(selector) === host
      && location.href === next.documentUrl
  }

  function applyBadge(href) {
    const icons = new Set(document.querySelectorAll('link[rel~="icon"]'))
    for (const [link, record] of records) {
      if (!icons.has(link)) {
        restore(link, record)
        records.delete(link)
      } else if (link.getAttribute('href') !== record.badgeHref) {
        // Treat a site-authored change as the new original, never restore over it.
        records.delete(link)
      }
    }
    if (!icons.size) {
      const link = document.createElement('link')
      link.rel = 'icon'
      document.head.append(link)
      icons.add(link)
      records.set(link, { href: null, created: true, badgeHref: null })
    }
    for (const link of icons) {
      let record = records.get(link)
      const original = link.getAttribute('href')
      // An orphaned badge is not a site's original favicon.
      if (!record && original?.startsWith('data:image/svg+xml,') && original.includes('data-dsh-tab-icon')) continue
      if (!record) {
        record = { href: original, created: false, badgeHref: null }
        records.set(link, record)
      }
      record.badgeHref = href
      if (link.getAttribute('href') !== href) link.setAttribute('href', href)
    }
  }

  async function update(next) {
    if (disposed || next.owner !== command.owner || next.type !== 'sync'
      || Date.now() > next.expiresAt || location.href !== next.documentUrl) return false
    clearTimeout(timer)
    timer = window.setTimeout(dispose, 15000)
    const version = ++revision
    if (next.icon === null) {
      clearBadge()
      return true
    }
    if (typeof next.icon !== 'string' || !/^data:image\/[\w.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/.test(next.icon)) {
      clearBadge()
      return false
    }
    if (cachedIcon !== next.icon) {
      cachedIcon = next.icon
      const path = 'M3.04536 4.45259C2.7582 3.60299 3.60299 2.7582 4.45259 3.04536L14.1828 6.33403C15.1637 6.66558 15.0872 8.08006 14.0715 8.39045L10.2994 9.54319C9.93919 9.65327 9.65327 9.93919 9.54319 10.2994L8.39046 14.0715C8.08007 15.0872 6.66558 15.1637 6.33404 14.1828L3.04536 4.45259Z'
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" data-dsh-tab-icon="true" width="32" height="32" viewBox="0 0 32 32"><image href="${next.icon}" width="32" height="32" opacity="0.3"/><path d="${path}" fill="black" stroke="white" stroke-width="1.5" stroke-linejoin="round" paint-order="stroke fill" transform="translate(-2 -2) scale(2.1)"/></svg>`
      const href = `data:image/svg+xml,${encodeURIComponent(svg)}`
      // This page-context load honors img-src. Cache failure as well as success
      // so a blocked data: image does not produce a warning on every renewal.
      decoded = (async () => {
        try {
          const image = new Image()
          image.src = href
          await image.decode()
          return href
        } catch {
          return null
        }
      })()
    }
    const href = await decoded
    if (!current(next, version)) return false
    if (href === null) {
      clearBadge()
      return false
    }
    applyBadge(href)
    return true
  }

  host.indicator = { owner: command.owner, update, dispose }
  document.head.append(host)
  return update(command)
}

export function indicatorScript(command) {
  return `(${pageIndicator.toString()})(${JSON.stringify(command)})`
}
