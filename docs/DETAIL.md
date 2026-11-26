# DSH Icon Studio — detail

## Why four surfaces are needed

DeepSeek Harness draws its icon from four unrelated places, and each one has to
be changed separately:

1. **`resources/tray.ico`** — the tray icon. `lib/main.js` builds it with
   `nativeImage.createFromPath(join(process.resourcesPath, 'tray.ico'))` and
   hands that image to a `Tray` instance. It is read once at startup.
2. **`resources/icon.png`** — the About panel icon passed to
   `app.setAboutPanelOptions({ iconPath })`.
3. **Shortcut `IconLocation`** — what Explorer shows on the Desktop and in the
   Start Menu. The application sets no explicit AppUserModelID, so the button of
   a launched window is commonly derived from the shortcut that launched it.
4. **Icon resources inside `DeepSeek Harness.exe`** — the window icon, the
   taskbar button, alt-tab, and the file icon in Explorer. The app passes no
   `icon` option to `BrowserWindow`, so Electron falls back to the executable's
   own `RT_GROUP_ICON`.

Because 1 and 4 have independent sources, changing the tray icon never changes
the taskbar icon. That is why the plugin patches all of them.

## How the executable is patched

`scripts/iconstudio.py` calls `BeginUpdateResourceW` / `UpdateResourceW` /
`EndUpdateResourceW` from `kernel32`: the new frames are stored as fresh
`RT_ICON` resources, the existing `RT_GROUP_ICON` is rewritten to point at them,
and Windows rewrites the `.rsrc` section. Nothing is edited by hand, so the PE
layout stays consistent — only the resource section, the relocation directory
pointer and the optional checksum change.

The swap itself is a rename: Windows lets a process's image be renamed but not
overwritten, so the live `DeepSeek Harness.exe` becomes
`DeepSeek Harness.exe.previous`, the patched build is copied in, and the hash is
compared. If the copy fails the rename is undone. The leftover stays locked until
the process that runs it exits, so the plugin retries the delete every time it
starts (`cmd_cleanup`), matching `.previous` and `.pre-` names so leftovers from
older ad-hoc scripts are cleared too.

Applying an icon twice does not grow the binary. The state records the hash of the
patch this plugin installed; when the live executable still matches it, the next
patch is built from `originals\DeepSeek Harness.exe` instead of the patched file,
so the result is byte-identical rather than carrying two icon groups.

## Image pipeline

1. Decode PNG (colour types 0, 2, 3, 4, 6; bit depth 8, plus sub-byte palette).
2. Alpha: keep existing transparency, or remove a white background with
   `alpha = clip((245 - min(r, g, b)) / 12, 0, 1)` — the darkest channel drives
   the ramp, which keeps anti-aliased edges soft and knocks out interior white.
3. Crop to the alpha bounding box, centre on a square canvas with a 4 % margin.
4. Premultiply alpha, box-downsample to 16/24/32/48/64/128/256/512, then
   un-premultiply. Premultiplication avoids dark fringes at the edges.
5. Emit 32-bit DIB frames for 16–128 px and a PNG frame for 256 px, which is what
   Explorer expects for large icons.

## State

`%LOCALAPPDATA%\DSH-IconStudio\state.json` records the applied icon, the
executable hash and the original values. `originals\` holds the backups,
`icons\<slug>\` holds each generated icon set (`icon.ico`, `icon.png`,
`source.png`, `preview.png` contact sheet), and `staging\` is the scratch area for
the patched executable. The slug is the sanitized file stem plus the first eight
hex digits of the image hash; names that carry no information (attachment stores
name files after their hash) fall back to `icon-<hash>`, which keeps the same
image at the same slug across runs.

`originals\` can be seeded from an older backup: dropping the shipped
`tray.ico`, `icon.png` and executable in there before the first apply makes
**还原默认** (Restore) return the vendor icons rather than whatever was live at
the first run. The plugin itself only records what it finds, so seeding is the
way to guarantee a clean rollback.

Engine commands (JSON on stdin, `--json-in`): `status`, `build` (assets only, no
system change), `ingest` (store an uploaded PNG under `uploads\`), `preview`
(resolve a built set's contact sheet), `apply`, `restore`, `cleanup`, `selftest`.

`build` and `apply` accept either `image` (a PNG path) or `slug` (an icon set
built earlier, resolved through `icons\<slug>\source.png`), which is how the
settings page applies what it previewed without uploading the file twice.

## Settings page

`client.js` registers one `settings.section` contribution (`id:
dsh-icon-studio`, label `DSH icons`, order 331) and renders the panel. It never
touches files: it reads the PNG locally with `FileReader`, posts base64 to
`/api/dsh-icon-studio/build`, shows the returned contact sheet, and only calls
`/api/dsh-icon-studio/apply` when the Apply button is pressed. `routes.mjs` and
`client.mjs` in `tests\` cover both halves without a browser: the first drives
the routes with fake request/response objects, the second runs the client
factory against a stub React and asserts the section registration and a clean
render pass.

The routes are registered on `ctx.webServer` and fenced three ways: the socket
must be loopback, `sec-fetch-site` must not be `cross-site`, and an `Origin`
header must match the `Host` header. Uploads are capped at 32 MiB and only the
PNG signature is accepted; the ten newest uploads are kept in `uploads\`.

Set `DSH_ICON_STUDIO_HOME` to relocate all of it, `DSH_ICON_STUDIO_PYTHON` to
force an interpreter, and `DSH_ICON_STUDIO_INSTALL` to force the installation
directory (without it, the directory next to the running executable is used first,
then the well-known install locations).
