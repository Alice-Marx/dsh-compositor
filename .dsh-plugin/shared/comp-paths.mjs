/**
 * Path helpers for .comp packages and best-effort git state for the
 * Compositor checkout. Git state is read straight from the .git directory
 * (HEAD, refs, packed-refs, loose commit objects) so it works without git
 * on PATH and without spawning processes.
 */
import { readFile, stat } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'
import { basename, isAbsolute, join, resolve } from 'node:path'

const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value)
}

export function looksLikeManifestPath(path) {
  return basename(path).toLowerCase() === 'manifest.json'
}

/**
 * Accept a .comp folder, its manifest.json path, or a folder that contains
 * manifest.json; return { compDir, manifestPath, imagesDir }.
 */
export async function resolveCompPath(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('path is required')
  const path = resolve(input.trim().replace(/[\\/]+$/, ''))
  if (!isAbsolute(path)) throw new Error(`expected an absolute path, got ${input}`)
  const compDir = looksLikeManifestPath(path) ? resolve(path, '..') : path
  const manifestPath = join(compDir, 'manifest.json')
  const imagesDir = join(compDir, 'images')
  const manifestStat = await stat(manifestPath).catch(() => null)
  if (!manifestStat || !manifestStat.isFile()) {
    throw new Error(`no manifest.json found at ${manifestPath} — a .comp project is a folder containing manifest.json and images/`)
  }
  return { compDir, manifestPath, imagesDir }
}

async function readGitDir(repoDir) {
  const dotGitPath = join(repoDir, '.git')
  const gitStat = await stat(dotGitPath).catch(() => null)
  if (!gitStat) return null
  if (gitStat.isDirectory()) return dotGitPath
  // worktree/submodule: .git is a file "gitdir: <path>"
  try {
    const text = (await readFile(dotGitPath, 'utf8')).trim()
    const match = /^gitdir:\s*(.+)$/.exec(text)
    if (match) return resolve(match[1])
  } catch { /* unreadable */ }
  return null
}

async function resolveRef(gitDir, ref) {
  const direct = await readFile(join(gitDir, ref), 'utf8').catch(() => null)
  if (direct && /^[0-9a-f]{40}$/i.test(direct.trim())) return direct.trim()
  try {
    const packed = await readFile(join(gitDir, 'packed-refs'), 'utf8')
    for (const line of packed.split('\n')) {
      const match = /^([0-9a-f]{40})\s+(\S+)$/.exec(line.trim())
      if (match && match[2] === ref) return match[1]
    }
  } catch { /* no packed-refs */ }
  return null
}

async function commitSubject(gitDir, commit) {
  const loose = join(gitDir, 'objects', commit.slice(0, 2), commit.slice(2))
  try {
    const raw = inflateSync(await readFile(loose))
    const text = raw.toString('utf8')
    if (!text.startsWith('commit ')) return null
    const body = text.slice(text.indexOf('\n\n') + 2)
    return (body.split('\n')[0] || '').slice(0, 160) || null
  } catch { /* packed object or missing: subject unavailable */ }
  return null
}

/**
 * Read { branch, commit, subject } from a git checkout without running git.
 * Returns null when repoDir is not a git checkout.
 */
export async function readGitState(repoDir) {
  const gitDir = await readGitDir(repoDir)
  if (!gitDir) return null
  let branch = null
  let commit = null
  try {
    const head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim()
    const refMatch = /^ref:\s*(?:refs\/heads\/)?(\S+)$/.exec(head)
    if (refMatch) {
      branch = refMatch[1]
      commit = await resolveRef(gitDir, `refs/heads/${branch}`)
    } else if (/^[0-9a-f]{40}$/i.test(head)) commit = head
  } catch { /* HEAD unreadable */ }
  const subject = commit ? await commitSubject(gitDir, commit) : null
  return {
    branch,
    commit: commit ? commit.slice(0, 12) : null,
    subject,
    note: 'read from the .git directory without running git; run `git -C <repo> pull` yourself when the user wants the checkout updated',
  }
}
