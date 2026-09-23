// Tag a release and create it on GitHub; CI builds and attaches the installers.
//
//   npm run release              next beta of the current version, e.g. v0.2.0-beta.3
//   npm run release -- rc        next release candidate
//   npm run release -- stable    v0.2.0 itself
//   npm run release -- --dry     print the tag and stop
//
// The version comes from src-tauri/tauri.conf.json; bump it there (and in
// Cargo.toml and package.json) in a PR before releasing a new one.
//
// The release is created here, with your own `gh` login, rather than by CI:
// GitHub will not let a workflow's own token create a release that then
// triggers other workflows, but it can upload to one that already exists.
// Every release starts as a pre-release so "Latest" never points at a release
// whose installers are still building; promote a stable one by hand once CI
// has attached them.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'nikhil-kunapareddy/gavia'
const CHANNELS = ['beta', 'rc', 'stable']

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const channel = args.find((a) => !a.startsWith('--')) ?? 'beta'
if (!CHANNELS.includes(channel)) fail(`unknown channel "${channel}"; use one of ${CHANNELS.join(', ')}`)

const here = dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(readFileSync(join(here, '../src-tauri/tauri.conf.json'), 'utf8'))

function run(command, argv, options = {}) {
  return execFileSync(command, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim()
}

function fail(message) {
  console.error(`release: ${message}`)
  process.exit(1)
}

if (!dry) {
  try {
    run('gh', ['auth', 'status'])
  } catch {
    fail('the GitHub CLI is not signed in; run `gh auth login` first')
  }
  if (run('git', ['status', '--porcelain'])) fail('the working tree has uncommitted changes')
  run('git', ['fetch', '--tags', '--quiet'])
  let unpushed = ''
  try {
    unpushed = run('git', ['log', '@{u}..HEAD', '--oneline'])
  } catch {
    fail('this branch has no upstream; push it first')
  }
  if (unpushed) fail('this branch has commits that are not pushed yet')
}

function nextTag() {
  if (channel === 'stable') return `v${version}`
  const prefix = `v${version}-${channel}.`
  const taken = run('git', ['tag', '--list', `${prefix}*`])
    .split('\n')
    .filter(Boolean)
    .map((t) => Number(t.slice(prefix.length)))
    .filter(Number.isInteger)
  return `${prefix}${taken.length ? Math.max(...taken) + 1 : 1}`
}

const tag = nextTag()
if (run('git', ['tag', '--list', tag])) fail(`${tag} already exists`)
if (dry) {
  console.log(tag)
  process.exit(0)
}

const notes =
  channel === 'stable'
    ? `Gavia ${tag}. Download the file for your computer below; see the README for install steps.`
    : `A ${channel} build of Gavia ${version}, for testing. It may have rough edges — please report anything that goes wrong.`

run('git', ['tag', '-a', tag, '-m', `Gavia ${tag}`], { stdio: 'inherit' })
run('git', ['push', 'origin', tag], { stdio: 'inherit' })
run('gh', ['release', 'create', tag, '--repo', REPO, '--verify-tag', '--prerelease', '--title', `Gavia ${tag}`, '--notes', notes], {
  stdio: 'inherit',
})

console.log(`\nCreated ${tag}. CI is building the installers: https://github.com/${REPO}/actions`)
if (channel === 'stable') {
  console.log(`Once they are attached, promote it:\n  gh release edit ${tag} --repo ${REPO} --prerelease=false --latest`)
}
