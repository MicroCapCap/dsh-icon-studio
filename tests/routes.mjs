/**
 * Route test for the settings-page API of @local/dsh-icon-studio.
 *
 * Loads the Host module, captures the routes it registers on a fake
 * webServer, and drives them with fake request/response objects. Covers the
 * read-only half (status, build from an uploaded PNG, preview bytes) and the
 * loopback fence. Nothing here touches the real installation.
 *
 *   node tests/routes.mjs
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

import { apply, inject, name } from '../index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'icon-studio-routes-'))
process.env.DSH_ICON_STUDIO_HOME = home

const checks = []
function check(label, condition, detail) {
  checks.push({ label, ok: Boolean(condition), detail })
  if (!condition) {
    console.error(`not ok: ${label}${detail === undefined ? '' : ` (${detail})`}`)
  }
}

/** A tiny valid PNG: a 64x64 opaque red square. */
function tinyPng() {
  const size = 64
  const rows = []
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4)
    row[0] = 0
    for (let x = 0; x < size; x += 1) {
      row[1 + x * 4] = 220
      row[2 + x * 4] = 60
      row[3 + x * 4] = 40
      row[4 + x * 4] = 255
    }
    rows.push(row)
  }
  const raw = Buffer.concat(rows)
  const idat = zlib.deflateSync(raw)
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

let crcTable = null
function crc32(buffer) {
  if (crcTable === null) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let crc = -1
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function fakeRes() {
  const res = {
    status: 0,
    headers: {},
    body: Buffer.alloc(0),
    writeHead(status, headers) {
      res.status = status
      res.headers = headers ?? {}
      return res
    },
    end(payload) {
      if (payload === undefined) res.body = Buffer.alloc(0)
      else if (Buffer.isBuffer(payload)) res.body = payload
      else res.body = Buffer.from(String(payload), 'utf8')
    },
  }
  return res
}

function fakeReq({ method = 'GET', url = '/', headers = {}, body = '', address = '127.0.0.1' }) {
  const payload = Buffer.from(body, 'utf8')
  const req = {
    method,
    url,
    headers: Object.assign({ host: '127.0.0.1:10240' }, headers),
    socket: { remoteAddress: address },
    async *[Symbol.asyncIterator]() {
      if (payload.length > 0) yield payload
    },
  }
  return req
}

function json(res) {
  return JSON.parse(res.body.toString('utf8'))
}

async function main() {
  check('module name', name === 'dsh-icon-studio', name)
  check('injects webServer', inject.includes('webServer'), inject.join(','))

  const routes = []
  let rejection
  const connection = { requestRejection: () => rejection }
  const ctx = {
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    webServer: { register: route => (routes.push(route), () => {}) },
    effect: () => {},
    connection,
    get(name) {
      return name === 'connection' ? this.connection : undefined
    },
  }
  apply(ctx)
  check('five routes registered', routes.length === 5, routes.map(route => route.path).join(', '))
  check('routes are exact', routes.every(route => route.kind === 'exact'))

  const route = path => {
    const found = routes.find(entry => entry.path === `/api/dsh-icon-studio${path}`)
    if (found === undefined) throw new Error(`no route ${path}`)
    return found.handler
  }

  // Fence: a non-loopback caller must be refused before any work happens.
  {
    const res = fakeRes()
    await route('/status')(fakeReq({ url: '/api/dsh-icon-studio/status', address: '10.0.0.9' }), res)
    check('non-loopback is forbidden', res.status === 403, res.status)
  }
  {
    const res = fakeRes()
    await route('/status')(fakeReq({ url: '/api/dsh-icon-studio/status', method: 'POST' }), res)
    check('wrong method is refused', res.status === 405, res.status)
  }
  // Fence: the host's connection gate is honoured before anything else runs.
  {
    rejection = 403
    const res = fakeRes()
    await route('/status')(fakeReq({ url: '/api/dsh-icon-studio/status' }), res)
    rejection = undefined
    check('connection rejection is honoured', res.status === 403, res.status)
  }
  // Fence: no connection service means no route, not an open route.
  {
    const saved = ctx.get
    delete ctx.get
    const res = fakeRes()
    await route('/status')(fakeReq({ url: '/api/dsh-icon-studio/status' }), res)
    ctx.get = saved
    check('missing connection service is refused', res.status === 403, res.status)
  }

  // Status: resolves the installation it is installed in.
  {
    const res = fakeRes()
    await route('/status')(fakeReq({ url: '/api/dsh-icon-studio/status' }), res)
    const body = json(res)
    check('status 200', res.status === 200, res.status)
    check('status has data', typeof body.data === 'object' && body.data !== null)
    check('status names the install dir', typeof body.data.installDir === 'string' && body.data.installDir !== '', body.data.installDir)
    check('status reports the exe sha', typeof body.data.exe.sha256 === 'string' && /^[0-9A-F]{64}$/.test(body.data.exe.sha256))
    check('status summary is text', typeof body.summary === 'string' && body.summary.length > 20)
  }

  // Build: upload a PNG as base64, get a slug and a preview URL back.
  const png = tinyPng()
  writeFileSync(join(home, 'sample.png'), png)
  let built = null
  {
    const res = fakeRes()
    const body = JSON.stringify({ name: 'sample.png', data: png.toString('base64') })
    await route('/build')(fakeReq({ url: '/api/dsh-icon-studio/build', method: 'POST', body, headers: { 'content-type': 'application/json' } }), res)
    built = json(res)
    check('build 200', res.status === 200, res.status)
    check('build returns a slug', typeof built.slug === 'string' && built.slug.startsWith('sample-'), built.slug)
    check('build returns every size', Array.isArray(built.sizes) && built.sizes.join(',') === '16,24,32,48,64,128,256', String(built.sizes))
    check('build returns preview url', typeof built.previewUrl === 'string' && built.previewUrl.includes(encodeURIComponent(built.slug)), built.previewUrl)
  }

  // Rejections: not a PNG, and missing data.
  {
    const res = fakeRes()
    const body = JSON.stringify({ name: 'x.png', data: Buffer.from('not a png at all').toString('base64') })
    await route('/build')(fakeReq({ url: '/api/dsh-icon-studio/build', method: 'POST', body, headers: { 'content-type': 'application/json' } }), res)
    check('non-PNG upload is 400', res.status === 400, res.status)
    check('non-PNG upload explains itself', /PNG/.test(json(res).error ?? ''), json(res).error)
  }
  {
    const res = fakeRes()
    await route('/build')(fakeReq({ url: '/api/dsh-icon-studio/build', method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }), res)
    check('empty upload is 400', res.status === 400, res.status)
  }

  // Preview: real PNG bytes for a built slug.
  {
    const res = fakeRes()
    await route('/preview')(fakeReq({ url: `/api/dsh-icon-studio/preview?slug=${encodeURIComponent(built.slug)}` }), res)
    check('preview 200', res.status === 200, res.status)
    check('preview is a PNG', res.body.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    check('preview is not empty', res.body.length > 1000, res.body.length)
    check('preview content type', res.headers['content-type'] === 'image/png', res.headers['content-type'])
  }
  {
    const res = fakeRes()
    await route('/preview')(fakeReq({ url: '/api/dsh-icon-studio/preview?slug=../../etc' }), res)
    check('preview rejects a path traversal slug', res.status === 400, res.status)
  }

  // Apply without a built icon must be a clean 400, not a crash.
  {
    const res = fakeRes()
    await route('/apply')(fakeReq({ url: '/api/dsh-icon-studio/apply', method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }), res)
    check('apply without slug is 400', res.status === 400, res.status)
  }

  const failures = checks.filter(entry => !entry.ok)
  if (failures.length > 0) {
    rmSync(home, { recursive: true, force: true })
    console.error(`${failures.length}/${checks.length} checks failed`)
    process.exitCode = 1
    return
  }
  for (const entry of checks) console.log(`ok: ${entry.label}`)
  rmSync(home, { recursive: true, force: true })
}

await main()
