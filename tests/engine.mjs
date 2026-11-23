// Smoke test for DSH Icon Studio: the Host module shape and the Python engine.
//   node tests/engine.mjs
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const ENGINE = join(ROOT, 'scripts', 'iconstudio.py')

const mod = await import('../index.js')
assert.equal(mod.name, 'dsh-icon-studio')
assert.ok(Array.isArray(mod.inject) && mod.inject.includes('tools'), 'inject must request tools')
assert.equal(typeof mod.apply, 'function', 'apply must be exported')

function candidates() {
  const list = []
  if (process.env.DSH_ICON_STUDIO_PYTHON) list.push(process.env.DSH_ICON_STUDIO_PYTHON)
  const runtimeRoot = join(homedir(), '.dsh', 'dsh-runtimes')
  if (existsSync(runtimeRoot)) {
    for (const entry of readdirSync(runtimeRoot)) list.push(join(runtimeRoot, entry, 'dependencies', 'python', 'python.exe'))
  }
  list.push('py', 'python', 'python3')
  return list
}

function run(command, args, input, env) {
  return new Promise(resolve => {
    const child = spawn(command, args, { env, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', error => resolve({ ok: false, stdout, stderr: String(error?.message ?? error) }))
    child.on('close', code => resolve({ ok: code === 0, stdout, stderr }))
    child.stdin.end(input ?? '')
  })
}

let python = null
for (const candidate of candidates()) {
  if (candidate.includes('\\') && !existsSync(candidate)) continue
  const probe = await run(candidate, ['-c', 'import sys;print(sys.version.split()[0])'], '')
  if (probe.ok && /^3\./.test(probe.stdout.trim())) {
    python = candidate
    break
  }
}
assert.ok(python !== null, 'no Python 3 interpreter found')

const home = mkdtempSync(join(tmpdir(), 'icon-studio-'))
try {
  const env = { ...process.env, DSH_ICON_STUDIO_HOME: home }
  const payload = JSON.stringify({ command: 'selftest', outDir: join(home, 'selftest') })
  const result = await run(python, [ENGINE, '--json-in'], payload, env)
  const text = result.stdout.trim()
  assert.ok(text !== '', `engine produced no output (stderr: ${result.stderr.trim()})`)
  const parsed = JSON.parse(text)
  assert.equal(parsed.ok, true, `selftest failed: ${JSON.stringify(parsed)}`)
  assert.deepEqual(parsed.data.problems, [], 'selftest reported problems')
  assert.equal(parsed.data.frames, 7, 'expected seven icon frames')
  assert.deepEqual(parsed.data.assets.sizes, [16, 24, 32, 48, 64, 128, 256])
  console.log(`ok: engine built ${parsed.data.frames} frames from a synthetic image`)
  console.log(`ok: host module ${mod.name} exports apply() with inject=${mod.inject.join(',')}`)
} finally {
  rmSync(home, { recursive: true, force: true })
}
