# DSH Icon Studio

Give DeepSeek Harness your own icon. One PNG in, every surface out:

| Surface | Source it comes from | What the plugin does |
| --- | --- | --- |
| Tray icon ("hidden bar") | `resources/tray.ico` | writes a fresh multi-size ICO |
| About panel icon | `resources/icon.png` | writes a 512 px PNG |
| Desktop / Start Menu shortcuts | `.lnk` `IconLocation` | retargets every shortcut that launches the exe |
| Window, taskbar, alt-tab, Explorer file icon | icon resources inside `DeepSeek Harness.exe` | patches `RT_GROUP_ICON` + `RT_ICON` with the Win32 resource API |

## Use it

Two ways in, one operation behind both.

**Settings page.** Open Settings → **DSH 图标** (the section appears under the
regular settings navigation). Drop or pick a PNG, the panel builds all sizes and
shows the preview strip, then **应用** writes them. **还原默认** puts the originals
back. Nothing is written until you press 应用.

**Agent tools.** Ask the agent, e.g. "use `D:\art\my-logo.png` as the DSH icon". It calls:

- `dsh_icon_apply` — build + apply (`image`, optional `targets`, `background`)
- `dsh_icon_status` — what is applied right now
- `dsh_icon_restore` — put the originals back

The settings page talks to the Host half over loopback-only routes:

| Route | Purpose |
| --- | --- |
| `GET /api/dsh-icon-studio/status` | installation, executable hash, signature, applied icon |
| `POST /api/dsh-icon-studio/build` | store an uploaded PNG (`{name, data}` base64) and render the icon set |
| `POST /api/dsh-icon-studio/apply` | apply a built icon (`{slug}`) to tray, shortcuts and executable |
| `POST /api/dsh-icon-studio/restore` | restore the recorded originals |
| `GET /api/dsh-icon-studio/preview?slug=` | the preview contact sheet as PNG bytes |

Every route first passes the host's own trust fence
(`connection.requestRejection`, the same Host/Origin + login-token gate the
shipped routes use); a composition without that service refuses every route.
It then rejects non-loopback callers, cross-site `sec-fetch-site`, and a
mismatched `Origin`, so a web page cannot drive it.

The tray icon and the window/taskbar icon are independent: changing one never
changes the other.

## What it guarantees

- **Backup first.** The original `tray.ico`, `icon.png`, executable and shortcut
  `IconLocation` values are copied under `%LOCALAPPDATA%\DSH-IconStudio\originals\`
  before anything is replaced.
- **Verify before swap.** The patched executable is checked (icon group size and
  frame count) and started once in Electron's node mode; on failure the binary is
  left untouched.
- **Rename, never overwrite.** Windows allows renaming but not overwriting the
  image of a running process, so the live executable is renamed aside and the
  patched one is copied in. A leftover that is still mapped is hidden, and the
  plugin deletes it the next time it starts.
- **Idempotent.** When the live executable is already this plugin's build, the
  next patch is built from the recorded vendor binary instead of stacking a
  second icon group on top, so repeated applies produce the same bytes.
- **Transparent background.** Existing transparency is kept; otherwise a
  white background is removed with a soft alpha ramp so anti-aliased edges and
  interior cut-outs stay clean.
- **Every size.** 16, 24, 32, 48, 64, 128 px as 32-bit DIB and 256 px as PNG.

## Requirements

- Windows. The engine is `scripts/iconstudio.py` and uses only the Python
  standard library (`ctypes`, `zlib`), so any Python 3.8+ works — the DSH runtime
  Python is discovered automatically.
- PNG input, 8-bit, non-interlaced.

## Notes

- Patching the executable changes its bytes; the Authenticode signature no longer
  matches afterwards. That is expected for a self-restyled binary, and
  `dsh_icon_restore` (or a DSH update) brings the signed original back.
- A DSH update replaces the executable, so re-run `dsh_icon_apply` after one.
  The tray icon and shortcuts survive an update only if the updater leaves
  `resources\` and the `.lnk` files alone; `dsh_icon_status` shows what is live.
- Each apply keeps its source image as `source.png` next to the generated set, so
  an icon can be rebuilt or re-applied from the plugin's own folder.
- Everything the plugin writes lives in `%LOCALAPPDATA%\DSH-IconStudio\`; delete
  that folder after `dsh_icon_restore` to reclaim the backup space.

## Tests

Run with the bundled Node runtime (`electron --expose-internals --check` works
for syntax checks):

| Test | Covers |
| --- | --- |
| `node tests/engine.mjs` | Host module shape + engine `selftest` (7 frames, all sizes) |
| `node tests/routes.mjs` | The five settings-page routes: fence, validation, status, build from an uploaded PNG, preview bytes |
| `node tests/client.mjs` | The client module wrapper: settings-section registration and a render pass with a stub React |

## License

MIT. See [LICENSE](LICENSE).
