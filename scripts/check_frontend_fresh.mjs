// CI freshness gate for the committed frontend/ bundle.
//
// Vite 8 (rolldown) bakes machine-dependent values into its file-name hashes:
// two builds of identical source produce identical bytes per chunk but
// different hash strings, and every chunk importing a renamed chunk follows.
// A raw `git diff` therefore false-positives across machines.
//
// This check normalizes every hash token ("-XXXXXXXX.js/css") in both the
// committed tree (git index) and the rebuilt worktree, then compares:
//   1. the set of files by normalized name (a chunk appearing or vanishing fails),
//   2. per-file normalized content (a stale bundle or a hand edit fails),
//   3. binary files byte-for-byte.
// A source change without a rebuild changes normalized content and fails;
// a pure hash cascade passes.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const HASH_TOKEN = /-([A-Za-z0-9_-]{8})\.(js|css)\b/g
// CSS Modules scoped names (_modal_n1rwm_1) are build-internal identifiers:
// lightningcss generates different hashes and enumerations per machine while
// each bundle stays internally consistent (CSS and JS agree). Normalize the
// whole scoped name so the gate compares rule structure, not tool internals.
const MODULE_NAME = /_[A-Za-z0-9]+_[a-z0-9]{4,6}_\d+\b/g
const TEXT_SUFFIX = /\.(js|css|html?|json|webmanifest|svg|txt|md)$/i
const ROOT = 'frontend/'
const key = rel => rel.replace(HASH_TOKEN, '-HASH.$2')

function normalize(rel, bytes) {
  if (!TEXT_SUFFIX.test(rel)) return bytes.toString('latin1')
  // Hash tokens hide rename cascades; EOL normalization hides checkout
  // filters (blobs may predate eol settings, builds always write LF).
  return bytes
    .toString('utf-8')
    .replace(HASH_TOKEN, '-HASH.$2')
    .replace(/\r\n/g, '\n')
    .replace(MODULE_NAME, '_SCOPED_')
}

function read(rel) {
  try {
    return normalize(rel, readFileSync(join(process.cwd(), ...rel.split('/'))))
  } catch {
    return undefined
  }
}

const committed = new Map()
for (const rel of execFileSync('git', ['ls-files', ROOT], { encoding: 'utf-8' }).split('\n').map(s => s.trim()).filter(Boolean)) {
  committed.set(key(rel), normalize(rel, execFileSync('git', ['show', `:${rel}`])))
}

const worktree = new Map()
const workFiles = [
  ...execFileSync('git', ['ls-files', ROOT], { encoding: 'utf-8' }).split('\n').map(s => s.trim()).filter(Boolean),
  ...execFileSync('git', ['ls-files', '--others', '--exclude-standard', ROOT], { encoding: 'utf-8' }).split('\n').map(s => s.trim()).filter(Boolean),
]
for (const rel of workFiles) {
  const content = read(rel)
  if (content !== undefined) worktree.set(key(rel), content)
}

const problems = []
const excerpts = []
for (const name of [...new Set([...committed.keys(), ...worktree.keys()])].sort()) {
  if (!worktree.has(name)) problems.push(`缺失（重建后不再产出）: ${name}`)
  else if (!committed.has(name)) problems.push(`多出（提交树没有对应产物）: ${name}`)
  else if (committed.get(name) !== worktree.get(name)) {
    problems.push(`内容不同（源码改动未重建，或产物被手改）: ${name}`)
    if (excerpts.length < 3) {
      const a = committed.get(name), b = worktree.get(name)
      let i = 0
      while (i < Math.min(a.length, b.length) && a[i] === b[i]) i += 1
      excerpts.push(`@@ ${name} @ 公共前缀 ${i}/${a.length},${b.length}\n  index: ${JSON.stringify(a.slice(Math.max(0, i - 60), i + 120))}\n  work : ${JSON.stringify(b.slice(Math.max(0, i - 60), i + 120))}`)
    }
  }
}

if (problems.length) {
  console.error('frontend/ 与源码不一致：')
  for (const p of problems) console.error('  - ' + p)
  for (const e of excerpts) console.error(e)
  process.exit(1)
}
console.log(`frontend/ fresh: ${committed.size} files compared (hash-token normalized)`)
