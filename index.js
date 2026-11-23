/**
 * Host half of DSH Icon Studio.
 *
 * Exposes three agent tools that turn one image into every icon DeepSeek
 * Harness renders (tray, About panel, shortcuts, and the window/taskbar icon
 * inside the executable) and can put the originals back. All file and Win32
 * work happens in `scripts/iconstudio.py`, which uses only the Python standard
 * library; this module discovers the installation, discovers an interpreter,
 * and relays JSON both ways.
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-icon-studio'
export const inject = ['tools', 'systemPrompt', 'webServer']

const HERE = dirname(fileURLToPath(import.meta.url))
const ENGINE = join(HERE, 'scripts', 'iconstudio.py')
const EXE_NAME = 'DeepSeek Harness.exe'
const ENGINE_TIMEOUT_MS = 15 * 60 * 1000
const API = '/api/dsh-icon-studio'
/** Local settings page only, but uploads are images: allow a generous body. */
const MAX_JSON_BODY_BYTES = 32 * 1024 * 1024

const GUIDANCE = [
  '# DSH Icon Studio',
  '',
  'This profile can restyle its own DeepSeek Harness icons. When the user wants',
  'a different app icon, taskbar icon, desktop/Start-Menu shortcut icon, or the',
  'tray ("hidden bar") icon, use the `dsh_icon_apply` tool with the image path',
  'instead of writing scripts: it converts any PNG into every Windows icon size',
  'and applies it to the tray, the shortcuts, and the executable. Use',
  '`dsh_icon_status` to report what is currently applied, and',
  '`dsh_icon_restore` to go back to the previous icons.',
  '',
  'Notes: the engine accepts PNG input; for another format, convert it first.',
  'A tray icon and the window/taskbar icon are separate sources, so changing one',
  'never changes the other. Applying an executable icon replaces the vendor',
  'signature of that binary and a DSH update restores the vendor icon, so',
  're-applying after an update is expected.',
].join('\n')

/** Absolute candidate installation directories, most likely first. */
function installCandidates() {
  const out = []
  const resources = process.resourcesPath
  if (typeof resources === 'string' && resources.toLowerCase().endsWith('resources')) {
    out.push(dirname(resources))
  }
  if (typeof process.execPath === 'string' && process.execPath.toLowerCase().endsWith('.exe')) {
    out.push(dirname(process.execPath))
  }
  for (const key of ['DSH_ICON_STUDIO_INSTALL', 'DSH_DESKTOP_DIR']) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim() !== '') out.push(value.trim())
  }
  const local = process.env.LOCALAPPDATA
  if (typeof local === 'string') {
    out.push(join(local, 'Programs', 'DeepSeek Harness'))
  }
  out.push('C:\\Program Files\\DeepSeek Harness', 'D:\\Program Files\\Deepseek Harness')
  return [...new Set(out)]
}

function isInstall(dir) {
  try {
    return statSync(join(dir, EXE_NAME)).isFile()
  } catch {
    return false
  }
}

function resolveInstallDir(explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    const dir = explicit.trim()
    if (!isInstall(dir)) throw new Error(`no ${EXE_NAME} in ${dir}`)
    return dir
  }
  const found = installCandidates().find(isInstall)
  if (found === undefined) {
    throw new Error(`cannot locate ${EXE_NAME}; pass installDir explicitly`)
  }
  return found
}

/** Absolute interpreter candidates, then bare commands resolved through PATH. */
function pythonCandidates() {
  const list = []
  const override = process.env.DSH_ICON_STUDIO_PYTHON
  if (typeof override === 'string' && override.trim() !== '') list.push(override.trim())
  const runtimeRoot = join(homedir(), '.dsh', 'dsh-runtimes')
  if (existsSync(runtimeRoot)) {
    let names = []
    try {
      names = readdirSync(runtimeRoot)
    } catch {
      names = []
    }
    for (const entry of names) {
      list.push(join(runtimeRoot, entry, 'dependencies', 'python', 'python.exe'))
    }
  }
  list.push('py', 'python', 'python3')
  return list
}

function execFile(command, args, input) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(error?.message ?? error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      finish({ ok: false, code: -1, stdout, stderr: `timed out after ${ENGINE_TIMEOUT_MS / 1000}s` })
    }, ENGINE_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', error => finish({ ok: false, code: -1, stdout, stderr: String(error?.message ?? error) }))
    child.on('close', code => finish({ ok: code === 0, code, stdout, stderr }))
    if (typeof input === 'string') {
      child.stdin.end(input, 'utf8')
    } else {
      child.stdin.end()
    }
  })
}

let cachedPython = null
let cachedVersion = ''

async function pickPython() {
  if (cachedPython !== null) return cachedPython
  const tried = []
  for (const candidate of pythonCandidates()) {
    if (candidate.includes('\\') || candidate.includes('/')) {
      if (!existsSync(candidate)) continue
    }
    const probe = await execFile(candidate, ['-c', 'import sys; sys.stdout.write(sys.version.split()[0])'])
    if (probe.ok && /^3\.\d+/.test(probe.stdout.trim())) {
      cachedPython = candidate
      cachedVersion = probe.stdout.trim()
      return cachedPython
    }
    tried.push(candidate)
  }
  throw new Error(`no usable Python 3 interpreter found (tried ${tried.join(', ') || 'nothing'})`)
}

async function runEngine(payload) {
  const python = await pickPython()
  const result = await execFile(python, [ENGINE, '--json-in'], JSON.stringify(payload))
  const text = result.stdout.trim()
  let parsed = null
  if (text !== '') {
    try {
      parsed = JSON.parse(text.slice(text.indexOf('{')))
    } catch {
      parsed = null
    }
  }
  if (parsed === null) {
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 600)
    throw new Error(`icon engine failed (python ${cachedVersion}, exit ${result.code}): ${detail || 'no output'}`)
  }
  if (parsed.ok !== true) {
    throw new Error(String(parsed.error ?? 'icon engine reported a failure'))
  }
  return parsed
}

function line(label, value) {
  return `- ${label}: ${value}`
}

function statusSummary(data) {
  const exe = data.exe ?? {}
  const applied = data.applied
  const signatureStatus = String(exe.signature?.status ?? 'Unknown')
  let exeIcon
  if (exe.customIcon === true) {
    exeIcon = 'custom, applied by this plugin'
  } else if (signatureStatus === 'Valid') {
    exeIcon = 'vendor icon (the binary is still vendor-signed)'
  } else {
    exeIcon = `not recorded by this plugin, but the binary is ${signatureStatus} — its icon was changed outside this plugin`
  }
  const lines = [
    `Installation: ${data.installDir}`,
    `Executable icon: ${exeIcon}`,
    `Executable SHA-256: ${exe.sha256 ?? 'missing'}`,
    `Tray icon: ${data.tray?.matchesAppliedIcon === true ? 'matches the applied icon' : 'does not match the applied icon'}`,
  ]
  if (applied !== null && applied !== undefined) {
    lines.push(`Applied icon: ${applied.slug} (${applied.appliedAt ?? 'unknown time'})`)
    lines.push(`Icon file: ${applied.ico}`)
  } else {
    lines.push('Applied icon: none recorded by this plugin')
  }
  const shortcuts = data.shortcuts ?? []
  if (shortcuts.length === 0) {
    lines.push('Shortcuts: none launch this executable')
  } else {
    for (const entry of shortcuts) {
      lines.push(`Shortcut ${entry.path}: ${entry.error ?? entry.iconLocation}`)
    }
  }
  if (Array.isArray(data.leftovers) && data.leftovers.length > 0) {
    lines.push(`Pending cleanup: ${data.leftovers.join(', ')} (deleted on the next apply or restore)`)
  }
  return lines.join('\n')
}

function applySummary(data) {
  const lines = [`Applied icon "${data.slug}" from ${data.assets.sourceImage} (${data.assets.sourceWidth}x${data.assets.sourceHeight}).`]
  for (const item of data.applied) lines.push(`- ${item}`)
  lines.push(line('Icon sizes', data.assets.sizes.join(', ')))
  lines.push(line('Icon file', data.assets.ico))
  lines.push(line('Preview', data.assets.preview))
  for (const warning of data.warnings) lines.push(`Warning: ${warning}`)
  if (data.needsRestart === true) {
    lines.push('Restart DeepSeek Harness to load the tray and window icons.')
  }
  return lines.join('\n')
}

function restoreSummary(data) {
  const lines = ['Restored the icons this plugin replaced.']
  for (const warning of data.warnings ?? []) lines.push(`Warning: ${warning}`)
  lines.push('Restart DeepSeek Harness to load the restored tray and window icons.')
  return lines.join('\n')
}

function outputSchema(keys) {
  const properties = {}
  const required = []
  for (const key of keys) {
    properties[key] = { type: key === 'ok' ? 'boolean' : 'string' }
    required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: true }
}

function textTool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: outputSchema(['ok', 'summary', 'detail']),
      render(_args, value) {
        const body = typeof value === 'object' && value !== null && typeof value.summary === 'string'
          ? value.summary
          : JSON.stringify(value, null, 2)
        return [{ type: 'text', text: body }]
      },
    },
    async execute(args) {
      const data = await spec.execute(args ?? {})
      return { ok: true, summary: data.summary, detail: JSON.stringify(data.detail) }
    },
  }
}

const STATUS_TOOL = textTool({
  name: 'dsh_icon_status',
  description: 'Report which icons DeepSeek Harness currently uses: whether the executable carries a custom icon, whether resources/tray.ico matches the applied icon, the IconLocation of the Desktop and Start Menu shortcuts, and where the icon files live.',
  parameters: {
    type: 'object',
    properties: {
      installDir: { type: 'string', description: 'DeepSeek Harness installation directory; auto-detected when omitted.' },
    },
  },
  async execute(args) {
    const installDir = resolveInstallDir(args.installDir)
    const result = await runEngine({ command: 'status', installDir })
    return { summary: statusSummary(result.data), detail: result.data }
  },
})

const APPLY_TOOL = textTool({
  name: 'dsh_icon_apply',
  description: 'Turn a PNG image into every Windows icon size and apply it to DeepSeek Harness: the tray icon (resources/tray.ico), the About panel icon (resources/icon.png), the Desktop/Start Menu shortcuts, and the window/taskbar/Explorer icon embedded in DeepSeek Harness.exe. Backs up every replaced file first, verifies and smoke-tests the patched executable before swapping it in, and reports what still needs a restart.',
  parameters: {
    type: 'object',
    required: ['image'],
    properties: {
      image: { type: 'string', description: 'Absolute path to the source PNG image.' },
      targets: {
        type: 'array',
        items: { type: 'string', enum: ['tray', 'shortcuts', 'exe'] },
        description: 'Which surfaces to change. Defaults to all three.',
      },
      background: {
        type: 'string',
        enum: ['auto', 'alpha', 'white'],
        description: 'How to treat the background: auto keeps existing transparency and otherwise removes white; alpha requires transparency; white forces white removal.',
      },
      installDir: { type: 'string', description: 'DeepSeek Harness installation directory; auto-detected when omitted.' },
      smoke: { type: 'boolean', description: 'Run the patched binary once in node mode before swapping it in. Defaults to true.' },
    },
  },
  async execute(args) {
    if (typeof args.image !== 'string' || args.image.trim() === '') {
      throw new Error('dsh_icon_apply needs an image path')
    }
    const installDir = resolveInstallDir(args.installDir)
    const result = await runEngine({
      command: 'apply',
      installDir,
      image: args.image.trim(),
      targets: Array.isArray(args.targets) && args.targets.length > 0 ? args.targets : ['tray', 'shortcuts', 'exe'],
      background: typeof args.background === 'string' ? args.background : 'auto',
      smoke: args.smoke !== false,
    })
    return { summary: applySummary(result.data), detail: result.data }
  },
})

const RESTORE_TOOL = textTool({
  name: 'dsh_icon_restore',
  description: 'Undo the icon change made by dsh_icon_apply: restore the original resources/tray.ico and resources/icon.png, the original shortcut IconLocations, and the original DeepSeek Harness.exe.',
  parameters: {
    type: 'object',
    properties: {
      installDir: { type: 'string', description: 'DeepSeek Harness installation directory; auto-detected when omitted.' },
    },
  },
  async execute(args) {
    const installDir = resolveInstallDir(args.installDir)
    const result = await runEngine({ command: 'restore', installDir })
    return { summary: restoreSummary(result.data), detail: result.data }
  },
})

/* ------------------------------------------------------------------------ *
 * HTTP routes behind the settings page
 * ------------------------------------------------------------------------ */

/** Loopback-only, same-origin fence: this page changes files on the machine. */
function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res)
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

function query(request) {
  try {
    return new URL(request.url ?? '/', 'http://127.0.0.1').searchParams
  } catch {
    return new URLSearchParams()
  }
}

function makeRoutes() {
  const guard = (req, res, method) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    return true
  }
  return [
    {
      kind: 'exact',
      path: `${API}/status`,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const installDir = query(req).get('installDir') || undefined
        const result = await runEngine({ command: 'status', installDir })
        writeJson(res, 200, { ok: true, summary: statusSummary(result.data), data: result.data })
      }),
    },
    {
      kind: 'exact',
      path: `${API}/build`,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : 'upload.png'
        const data = typeof body.data === 'string' ? body.data : ''
        if (data === '') {
          writeJson(res, 400, { error: 'no image data in the request' })
          return
        }
        const ingested = await runEngine({ command: 'ingest', name, data })
        const background = typeof body.background === 'string' ? body.background : 'auto'
        const built = await runEngine({ command: 'build', image: ingested.data.path, background })
        const assets = built.data.assets
        writeJson(res, 200, {
          ok: true,
          slug: assets.slug,
          label: name,
          note: assets.note,
          sizes: assets.sizes,
          icoBytes: assets.icoBytes,
          sourceWidth: assets.sourceWidth,
          sourceHeight: assets.sourceHeight,
          previewUrl: `${API}/preview?slug=${encodeURIComponent(assets.slug)}&v=${Date.now()}`,
          log: built.log ?? [],
        })
      }),
    },
    {
      kind: 'exact',
      path: `${API}/apply`,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const slug = typeof body.slug === 'string' ? body.slug : ''
        if (slug === '') {
          writeJson(res, 400, { error: 'no built icon selected; upload an image first' })
          return
        }
        const installDir = typeof body.installDir === 'string' && body.installDir.trim() !== '' ? body.installDir.trim() : undefined
        const result = await runEngine({
          command: 'apply',
          installDir,
          slug,
          targets: Array.isArray(body.targets) && body.targets.length > 0 ? body.targets : ['tray', 'shortcuts', 'exe'],
          background: typeof body.background === 'string' ? body.background : 'auto',
          smoke: body.smoke !== false,
        })
        writeJson(res, 200, {
          ok: true,
          summary: applySummary(result.data),
          slug: result.data.slug,
          needsRestart: result.data.needsRestart === true,
          warnings: result.data.warnings ?? [],
          applied: result.data.applied ?? [],
          log: result.log ?? [],
        })
      }),
    },
    {
      kind: 'exact',
      path: `${API}/restore`,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const installDir = typeof body.installDir === 'string' && body.installDir.trim() !== '' ? body.installDir.trim() : undefined
        const result = await runEngine({ command: 'restore', installDir })
        writeJson(res, 200, {
          ok: true,
          summary: restoreSummary(result.data),
          warnings: result.data.warnings ?? [],
          log: result.log ?? [],
        })
      }),
    },
    {
      kind: 'exact',
      path: `${API}/preview`,
      handler: handle(async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const slug = query(req).get('slug') ?? ''
        const result = await runEngine({ command: 'preview', slug })
        const bytes = readFileSync(result.data.path)
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': String(bytes.length),
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        })
        res.end(bytes)
      }),
    },
  ]
}

export function apply(ctx) {
  const disposers = [STATUS_TOOL, APPLY_TOOL, RESTORE_TOOL].map(tool => ctx.tools.register(tool))
  disposers.push(ctx.systemPrompt.section({
    name: 'dsh-icon-studio:guidance',
    order: 3400,
    text: GUIDANCE,
  }))
  if (ctx.webServer !== undefined && typeof ctx.webServer.register === 'function') {
    for (const route of makeRoutes()) disposers.push(ctx.webServer.register(route))
  }
  // A swap renames the running executable aside; it stays locked until this
  // process exits, so every startup is the first moment it can be deleted.
  runEngine({ command: 'cleanup' }).catch(() => {})
  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* already released */
      }
    }
  }, 'dsh-icon-studio: tools and guidance')
}
