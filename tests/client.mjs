/**
 * Client-module test for @local/dsh-icon-studio.
 *
 * The client half only exists inside the browser module table, so this test
 * recreates just enough of it: a `window.__ModuleLoader__` capture, a minimal
 * React (createElement + hooks), and a fake `fetch`. It proves the wrapper
 * registers the settings section it claims to, and that rendering the panel
 * never throws and never emits `undefined` children.
 *
 *   node tests/client.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInThisContext } from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, '..', 'client.js'), 'utf8')

const checks = []
function check(label, condition, detail) {
  checks.push({ label, ok: Boolean(condition) })
  if (!condition) console.error(`not ok: ${label}${detail === undefined ? '' : ` (${detail})`}`)
}

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity) }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useCallback(fn) {
    return fn
  },
  useRef(value) {
    return { current: value }
  },
  Fragment: 'Fragment',
}

const requireStub = specifier => {
  if (specifier === 'react' || specifier === 'react/jsx-runtime') return React
  throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
}

let loaded = null
const sandboxWindow = {
  __ModuleLoader__: {
    load(entry) {
      loaded = entry
    },
  },
}

const fetchCalls = []
const fakeFetch = async url => {
  fetchCalls.push(url)
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    async text() {
      return JSON.stringify({
        ok: true,
        summary: 'stub',
        data: {
          installDir: 'D:\\Program Files\\Deepseek Harness',
          exe: { sha256: 'A'.repeat(64), customIcon: true, signature: { status: 'NotSigned', signer: '' } },
          tray: { matchesAppliedIcon: true },
          applied: { slug: 'icon-12345678', appliedAt: '2026-11-23T08:00:00' },
          shortcuts: [],
          leftovers: [],
        },
      })
    },
  }
}

const source = SOURCE.replace(/^/, '')
const run = new Function(
  'window',
  'require',
  'fetch',
  'console',
  `${source}\n//# sourceURL=client.js`,
)
run(sandboxWindow, requireStub, fakeFetch, console)

check('loader received one entry', loaded !== null)
check('entry id is the package name', loaded && loaded.id === '@local/dsh-icon-studio', loaded && loaded.id)
check('factory is a function', loaded && typeof loaded.factory === 'function')

const moduleExports = loaded.factory(requireStub)
check('exports inject slots', Array.isArray(moduleExports.inject) && moduleExports.inject.includes('slots'))
check('exports apply', typeof moduleExports.apply === 'function')

const registrations = []
const ctx = {
  slots: {
    inject(name, factory) {
      check('injects into settings.section', name === 'settings.section', name)
      factory()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}
moduleExports.apply(ctx)

check('registers one settings section', registrations.length === 1, String(registrations.length))
const section = registrations[0]
check('section name', section && section.options.name === 'settings.section')
check('section id', section && section.options.id === 'dsh-icon-studio', section && section.options.id)
check('section label is a function', section && typeof section.options.label === 'function')
check('section label is text', section && typeof section.options.label() === 'string' && section.options.label().length > 0, section && section.options.label())
check('section order is a number', section && typeof section.options.order === 'number', section && section.options.order)
check('component is a function', section && typeof section.component === 'function')

let tree = null
let renderError = null
try {
  tree = section.component({})
} catch (error) {
  renderError = error
}
check('panel renders without throwing', renderError === null, renderError && renderError.message)
check('panel tree is an element', tree !== null && typeof tree === 'object')

function walk(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node === 'object' && node.type !== undefined) {
    visit(node)
    for (const child of node.children) walk(child, visit)
    return
  }
  visit(node)
}

const texts = []
let undefinedChildren = 0
let nullChildren = 0
walk(tree, node => {
  if (node === undefined) undefinedChildren += 1
  if (node === null) nullChildren += 1
  if (typeof node === 'string') texts.push(node)
})
check('no undefined children', undefinedChildren === 0, String(undefinedChildren))
check('no stray null children', nullChildren === 0, String(nullChildren))
check('renders the upload heading', texts.some(text => text.includes('App icon')), texts.slice(0, 6).join(' | '))
check('renders the status heading', texts.some(text => text.includes('Current status')), texts.slice(0, 12).join(' | '))
check('mentions PNG input', texts.some(text => text.includes('PNG')), texts.slice(0, 8).join(' | '))
check('offers an Apply button', texts.some(text => text === 'Apply'), texts.join(' | '))

if (fetchCalls.length !== 0) check('no fetch during render', false, fetchCalls.join(','))

const failures = checks.filter(entry => !entry.ok)
if (failures.length > 0) {
  console.error(`${failures.length}/${checks.length} checks failed`)
  process.exitCode = 1
} else {
  for (const entry of checks) console.log(`ok: ${entry.label}`)
}
