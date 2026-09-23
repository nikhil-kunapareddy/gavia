// Runs after `tauri build`. On macOS it packages the .app into a .dmg with
// make-dmg.sh (see that script for why Tauri's own dmg target is not used);
// on Windows and Linux Tauri's installers are already the final artifacts.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform === 'darwin') {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'make-dmg.sh')
  const result = spawnSync('bash', [script, ...process.argv.slice(2)], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}
