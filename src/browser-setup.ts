import { chmod, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Install the native host and a stable unpacked extension path; never launch Chrome. */
export async function installBrowser(home: string, bundle: string, userHome = homedir(), platform = process.platform): Promise<string> {
  if (platform !== 'darwin' && platform !== 'linux') throw new Error('dscode Browser native host setup currently supports macOS and Linux.')
  const directory = join(home, 'browser')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const extension = join(directory, 'extension')
  await cp(join(bundle, 'browser-extension'), extension, { recursive: true })
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'))
  const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)]
    .map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('')
  const host = join(directory, 'native-host')
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  await writeFile(host, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(bundle, 'browser-native-host.js'))} ${quote(home)} "$@"\n`, { mode: 0o700 })
  await chmod(host, 0o700)
  const manifests = join(userHome, platform === 'darwin' ? 'Library/Application Support/Google/Chrome/NativeMessagingHosts' : '.config/google-chrome/NativeMessagingHosts')
  await mkdir(manifests, { recursive: true })
  await writeFile(join(manifests, 'com.dscode.browser.json'), JSON.stringify({
    name: 'com.dscode.browser', description: 'dscode background browser connection', path: host,
    type: 'stdio', allowed_origins: [`chrome-extension://${id}/`],
  }, null, 2) + '\n', { mode: 0o600 })
  return `Browser host installed. In chrome://extensions, enable Developer mode and Load unpacked:\n${extension}\nAfter an update, reload dscode Browser. No remote debugging or token is required.\n`
}
