// Write latest.json, the file installed copies of Gavia read to find updates.
//
//   node scripts/updater-manifest.mjs <tag> <folder of .sig files> > latest.json
//
// CI runs this once every installer job has attached its update archive and
// signature to the release. The app asks for
// releases/latest/download/latest.json, which GitHub resolves to the release
// marked Latest, so an update reaches people only once a stable release is
// promoted; pre-releases carry a latest.json that nothing reads.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'nikhil-kunapareddy/gavia'

// Update archive, by the updater's own name for each platform. macOS ships
// for Apple Silicon only (no ONNX Runtime for Intel), and on Linux only the
// AppImage can replace itself.
const PLATFORMS = {
  'darwin-aarch64': (name) => name.endsWith('.app.tar.gz'),
  'windows-x86_64': (name) => name.endsWith('-setup.exe'),
  'linux-x86_64': (name) => name.endsWith('.AppImage'),
}

const [tag, folder] = process.argv.slice(2)
if (!tag || !folder) {
  console.error('usage: updater-manifest.mjs <tag> <folder of .sig files>')
  process.exit(1)
}

const here = dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(readFileSync(join(here, '../src-tauri/tauri.conf.json'), 'utf8'))
const signatures = readdirSync(folder).filter((name) => name.endsWith('.sig'))

const platforms = {}
for (const [platform, matches] of Object.entries(PLATFORMS)) {
  const sig = signatures.find((name) => matches(name.slice(0, -'.sig'.length)))
  if (!sig) {
    console.error(`updater-manifest: no signed update for ${platform} in ${folder}`)
    process.exit(1)
  }
  const asset = sig.slice(0, -'.sig'.length)
  platforms[platform] = {
    signature: readFileSync(join(folder, sig), 'utf8').trim(),
    url: `https://github.com/${REPO}/releases/download/${tag}/${encodeURIComponent(asset)}`,
  }
}

const manifest = { version, notes: `Gavia ${tag}`, pub_date: new Date().toISOString(), platforms }
console.log(JSON.stringify(manifest, null, 2))
