#!/usr/bin/env python3
"""DSH Icon Studio engine.

Converts one source image into Windows icon assets and applies them to every
surface DeepSeek Harness renders:

  resources/tray.ico   system-tray ("hidden bar") icon, read at startup
  resources/icon.png   About panel application icon
  Desktop / Start Menu shortcuts -> .lnk IconLocation
  DeepSeek Harness.exe icon resources -> window + taskbar + Explorer + alt-tab

The executable is patched through the Win32 BeginUpdateResource/UpdateResource
API so the PE layout stays valid, then swapped in with a rename because Windows
allows renaming - but not overwriting - the image of a running process.

Only the Python standard library is used (ctypes + zlib), so the engine runs on
any Windows Python 3.8+. The protocol is JSON in on stdin for `--json-in` and
JSON out on stdout, so the Host half never touches paths or Win32 itself.
"""

import base64
import ctypes
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import time
import zlib
from ctypes import wintypes as wt

SIZES_DIB = (16, 24, 32, 48, 64, 128)
SIZE_PNG = 256
MARGIN = 0.04
RT_ICON = 3
RT_GROUP_ICON = 14
LOAD_LIBRARY_AS_DATAFILE = 0x00000002
FILE_ATTRIBUTE_HIDDEN = 0x2
FILE_ATTRIBUTE_SYSTEM = 0x4
STATE_VERSION = 1
OWNER = "DSH Icon Studio"

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.LoadLibraryExW.restype = wt.HMODULE
k32.LoadLibraryExW.argtypes = [wt.LPCWSTR, wt.HANDLE, wt.DWORD]
k32.FreeLibrary.argtypes = [wt.HMODULE]
k32.BeginUpdateResourceW.restype = wt.HANDLE
k32.BeginUpdateResourceW.argtypes = [wt.LPCWSTR, wt.BOOL]
k32.UpdateResourceW.restype = wt.BOOL
k32.UpdateResourceW.argtypes = [wt.HANDLE, wt.LPVOID, wt.LPVOID, wt.WORD, wt.LPVOID, wt.DWORD]
k32.EndUpdateResourceW.restype = wt.BOOL
k32.EndUpdateResourceW.argtypes = [wt.HANDLE, wt.BOOL]
k32.SetFileAttributesW.argtypes = [wt.LPCWSTR, wt.DWORD]
k32.GetFileAttributesW.restype = wt.DWORD
k32.GetFileAttributesW.argtypes = [wt.LPCWSTR]

ENUMRESNAMEPROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HMODULE, wt.LPVOID, wt.LPVOID, wt.LPARAM)
k32.EnumResourceNamesW.argtypes = [wt.HMODULE, wt.LPVOID, ENUMRESNAMEPROC, wt.LPARAM]


class StudioError(Exception):
    """A failure the caller reports verbatim to the user."""


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest().upper()


def sha256_bytes(raw):
    return hashlib.sha256(raw).hexdigest().upper()


def ensure_dir(path):
    os.makedirs(path, exist_ok=True)
    return path


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024.0


def clamp_byte(value):
    return 0 if value < 0 else (255 if value > 255 else int(value + 0.5))


# --------------------------------------------------------------------------
# PNG decoding (8-bit, non-interlaced, all colour types)
# --------------------------------------------------------------------------

def _png_chunks(data):
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise StudioError("not a PNG file (only PNG input is supported)")
    pos = 8
    ihdr = None
    palette = None
    trns = None
    idat = []
    while pos + 8 <= len(data):
        length, kind = struct.unpack_from(">I4s", data, pos)
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if kind == b"IHDR":
            ihdr = struct.unpack(">IIBBBBB", body)
        elif kind == b"PLTE":
            palette = body
        elif kind == b"tRNS":
            trns = body
        elif kind == b"IDAT":
            idat.append(body)
        elif kind == b"IEND":
            break
    if ihdr is None or not idat:
        raise StudioError("PNG is missing IHDR/IDAT data")
    return ihdr, palette, trns, b"".join(idat)


def _unfilter(raw, width, height, channels):
    stride = width * channels
    out = bytearray(stride * height)
    pos = 0
    prev = bytes(stride)
    for y in range(height):
        if pos >= len(raw):
            raise StudioError("PNG image data is truncated")
        kind = raw[pos]
        pos += 1
        line = bytearray(raw[pos:pos + stride])
        pos += stride
        if len(line) != stride:
            raise StudioError("PNG image data is truncated")
        if kind == 0:
            pass
        elif kind == 1:
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 255
        elif kind == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif kind == 3:
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 255
        elif kind == 4:
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                up = prev[i]
                upleft = prev[i - channels] if i >= channels else 0
                p = left + up - upleft
                pa = abs(p - left)
                pb = abs(p - up)
                pc = abs(p - upleft)
                if pa <= pb and pa <= pc:
                    pred = left
                elif pb <= pc:
                    pred = up
                else:
                    pred = upleft
                line[i] = (line[i] + pred) & 255
        else:
            raise StudioError(f"unsupported PNG filter type {kind}")
        out[y * stride:(y + 1) * stride] = line
        prev = bytes(line)
    return out


def _unpack_bits(row, width, depth):
    """Expand a sub-byte grayscale/palette row to one index per pixel."""
    values = []
    per_byte = 8 // depth
    mask = (1 << depth) - 1
    for x in range(width):
        byte = row[x // per_byte]
        shift = 8 - depth * (x % per_byte + 1)
        values.append((byte >> shift) & mask)
    return values


def decode_png(path):
    """Return (width, height, bytearray RGBA)."""
    with open(path, "rb") as fh:
        data = fh.read()
    (width, height, depth, colour, compression, filtering, interlace), palette, trns, idat = _png_chunks(data)
    if compression != 0 or filtering != 0:
        raise StudioError("unsupported PNG compression/filter method")
    if interlace != 0:
        raise StudioError("interlaced PNG is not supported; re-save it as a plain PNG")
    if colour == 3:
        if palette is None:
            raise StudioError("palette PNG without PLTE chunk")
        channels = 1
    elif colour in (0, 4):
        channels = 1 if colour == 0 else 2
    elif colour in (2, 6):
        channels = 3 if colour == 2 else 4
    else:
        raise StudioError(f"unsupported PNG colour type {colour}")
    if depth not in (8,) and not (colour == 3 and depth in (1, 2, 4, 8)) and not (colour == 0 and depth in (1, 2, 4)):
        raise StudioError(f"unsupported PNG bit depth {depth}")

    row_bytes = (width * channels * depth + 7) // 8
    raw = zlib.decompress(idat)
    if len(raw) < (row_bytes + 1) * height:
        raise StudioError("PNG pixel data is shorter than the header claims")
    # _unfilter assumes one byte per sample, so sub-byte images are expanded per row.
    if depth == 8:
        pixels = _unfilter(raw, width, height, channels)
        stride = width * channels
    else:
        pixels = bytearray()
        pos = 0
        stride = width * channels
        prev = bytes(width * channels)
        for _y in range(height):
            kind = raw[pos]
            pos += 1
            packed = bytearray(raw[pos:pos + row_bytes])
            pos += row_bytes
            line = bytearray(stride)
            if kind == 0:
                pass
            elif kind == 1:
                for i in range(channels, stride):
                    line[i] = (line[i] + line[i - channels]) & 255
            elif kind == 2:
                for i in range(stride):
                    line[i] = (line[i] + prev[i]) & 255
            elif kind == 3:
                for i in range(stride):
                    left = line[i - channels] if i >= channels else 0
                    line[i] = (line[i] + ((left + prev[i]) >> 1)) & 255
            elif kind == 4:
                for i in range(stride):
                    left = line[i - channels] if i >= channels else 0
                    up = prev[i]
                    upleft = prev[i - channels] if i >= channels else 0
                    p = left + up - upleft
                    pa, pb, pc = abs(p - left), abs(p - up), abs(p - upleft)
                    pred = left if (pa <= pb and pa <= pc) else (up if pb <= pc else upleft)
                    line[i] = (line[i] + pred) & 255
            else:
                raise StudioError(f"unsupported PNG filter type {kind}")
            prev = bytes(line)
            scale = 255 // ((1 << depth) - 1)
            for x in range(width):
                byte = packed[x // (8 // depth)]
                shift = 8 - depth * (x % (8 // depth) + 1)
                line[x] = ((byte >> shift) & ((1 << depth) - 1)) * scale
            pixels += line

    rgba = bytearray(width * height * 4)
    if colour == 6:
        rgba[:] = pixels
    elif colour == 2:
        for i in range(width * height):
            rgba[i * 4:i * 4 + 3] = pixels[i * 3:i * 3 + 3]
            rgba[i * 4 + 3] = 255
    elif colour == 0 or colour == 4:
        for i in range(width * height):
            if colour == 0:
                grey = pixels[i]
                a = 255
            else:
                grey = pixels[i * 2]
                a = pixels[i * 2 + 1]
            rgba[i * 4] = grey
            rgba[i * 4 + 1] = grey
            rgba[i * 4 + 2] = grey
            rgba[i * 4 + 3] = a
    elif colour == 3:
        count = len(palette) // 3
        alphas = bytearray(trns or b"")
        for i in range(width * height):
            index = pixels[i]
            r, g, b = palette[index * 3:index * 3 + 3]
            rgba[i * 4] = r
            rgba[i * 4 + 1] = g
            rgba[i * 4 + 2] = b
            rgba[i * 4 + 3] = alphas[index] if index < len(alphas) else 255
    return width, height, rgba


# --------------------------------------------------------------------------
# PNG encoding
# --------------------------------------------------------------------------

def encode_png(rgba, width, height):
    stride = width * 4
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]

    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


# --------------------------------------------------------------------------
# image preparation
# --------------------------------------------------------------------------

def alpha_extent(rgba, width, height):
    """Bounding box of every pixel with alpha above 8, as (x0, y0, x1, y1)."""
    x0, y0, x1, y1 = width, height, -1, -1
    alpha = rgba[3::4]
    for y in range(height):
        row = alpha[y * width:(y + 1) * width]
        if max(row, default=0) <= 8:
            continue
        first = next(i for i, a in enumerate(row) if a > 8)
        last = len(row) - next(i for i, a in enumerate(reversed(row)) if a > 8)
        x0 = min(x0, first)
        x1 = max(x1, last)
        y0 = min(y0, y)
        y1 = y + 1
    if x1 <= x0 or y1 <= y0:
        raise StudioError("the image is fully transparent - nothing to draw")
    return x0, y0, x1, y1


def apply_background(rgba, width, height, mode):
    """Return (rgba, note). mode: auto | alpha | white."""
    if mode not in ("auto", "alpha", "white"):
        raise StudioError(f"unknown background mode {mode!r} (use auto, alpha or white)")
    alpha = rgba[3::4]
    transparent = min(alpha) < 250
    if mode == "alpha" or (mode == "auto" and transparent):
        if not transparent:
            raise StudioError("background=alpha was requested but the image has no transparency")
        return rgba, "kept the image's own transparency"
    # Chroma key: every opaque pixel far enough from white becomes opaque, and
    # the distance of the darkest channel drives the alpha ramp so anti-aliased
    # edges stay soft. Interior white areas disappear, which is what an icon
    # with knocked-out counters needs.
    for i in range(0, len(rgba), 4):
        r, g, b = rgba[i], rgba[i + 1], rgba[i + 2]
        darkest = r if r < g else g
        if b < darkest:
            darkest = b
        ramp = (245 - darkest) / 12.0
        a = 0 if ramp <= 0 else (255 if ramp >= 1 else int(ramp * 255 + 0.5))
        rgba[i + 3] = a
    return rgba, "removed the white background (transparent counters kept)"


def crop(rgba, width, x0, y0, x1, y1):
    cw = x1 - x0
    stride = width * 4
    out = bytearray()
    for y in range(y0, y1):
        start = y * stride + x0 * 4
        out += rgba[start:start + cw * 4]
    return out, cw, y1 - y0


def square_canvas(rgba, width, height, margin=MARGIN):
    """Center the artwork on a transparent square canvas with a margin."""
    side = int(round(max(width, height) * (1 + 2 * margin)))
    if side < 8:
        raise StudioError("the artwork is too small to build an icon from")
    out = bytearray(side * side * 4)
    ox = (side - width) // 2
    oy = (side - height) // 2
    for y in range(height):
        src = y * width * 4
        dst = ((y + oy) * side + ox) * 4
        out[dst:dst + width * 4] = rgba[src:src + width * 4]
    return out, side


def channel_planes(rgba):
    """Split premultiplied RGBA into four byte planes for fast averaging."""
    count = len(rgba) // 4
    a = bytearray(rgba[3::4])
    r = bytearray(count)
    g = bytearray(count)
    b = bytearray(count)
    for i in range(count):
        alpha = a[i]
        if alpha == 255:
            r[i] = rgba[i * 4]
            g[i] = rgba[i * 4 + 1]
            b[i] = rgba[i * 4 + 2]
        elif alpha == 0:
            continue
        else:
            scale = alpha / 255.0
            r[i] = int(rgba[i * 4] * scale + 0.5)
            g[i] = int(rgba[i * 4 + 1] * scale + 0.5)
            b[i] = int(rgba[i * 4 + 2] * scale + 0.5)
    return a, r, g, b


def average_planes(planes, side, out):
    """Box-downsample four premultiplied planes to out x out."""
    a, r, g, b = planes
    rows = []
    acc_a = bytearray(out * out)
    acc_r = bytearray(out * out)
    acc_g = bytearray(out * out)
    acc_b = bytearray(out * out)
    for oy in range(out):
        y0 = oy * side // out
        y1 = max(y0 + 1, (oy + 1) * side // out)
        rows.append((y0, y1))
    borders = []
    for ox in range(out):
        borders.append((ox * side // out, max(ox * side // out + 1, (ox + 1) * side // out)))
    for oy in range(out):
        y0, y1 = rows[oy]
        area = (y1 - y0)
        base = oy * out
        for ox in range(out):
            x0, x1 = borders[ox]
            cnt = area * (x1 - x0)
            sa = sr = sg = sb = 0
            for y in range(y0, y1):
                off = y * side
                sa += sum(a[off + x0:off + x1])
                sr += sum(r[off + x0:off + x1])
                sg += sum(g[off + x0:off + x1])
                sb += sum(b[off + x0:off + x1])
            acc_a[base + ox] = sa // cnt
            acc_r[base + ox] = sr // cnt
            acc_g[base + ox] = sg // cnt
            acc_b[base + ox] = sb // cnt
    rgba = bytearray(out * out * 4)
    for i in range(out * out):
        alpha = acc_a[i]
        if alpha == 0:
            continue
        rgba[i * 4] = min(255, acc_r[i] * 255 // alpha)
        rgba[i * 4 + 1] = min(255, acc_g[i] * 255 // alpha)
        rgba[i * 4 + 2] = min(255, acc_b[i] * 255 // alpha)
        rgba[i * 4 + 3] = alpha
    return rgba


# --------------------------------------------------------------------------
# ICO writing / reading
# --------------------------------------------------------------------------

def dib_frame(rgba, size):
    header = struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0, size * size * 4, 0, 0, 0, 0)
    rows = []
    stride = size * 4
    for y in range(size - 1, -1, -1):
        line = bytearray(rgba[y * stride:(y + 1) * stride])
        for i in range(0, stride, 4):
            line[i], line[i + 2] = line[i + 2], line[i]
        rows.append(bytes(line))
    mask_stride = ((size + 31) // 32) * 4
    return header + b"".join(rows) + b"\x00" * (mask_stride * size)


def build_ico(rgba, size, png):
    return encode_png(rgba, size, size) if png else dib_frame(rgba, size)


def write_ico(path, frames):
    """frames: list of (size, bytes, is_png)."""
    header = struct.pack("<HHH", 0, 1, len(frames))
    offset = 6 + 16 * len(frames)
    entries = []
    blobs = []
    for size, data, is_png in frames:
        side = 0 if size >= 256 else size
        entries.append(struct.pack("<BBBBHHII", side, side, 0, 0, 1, 32, len(data), offset))
        offset += len(data)
        blobs.append(data)
        del is_png
    with open(path, "wb") as fh:
        fh.write(header + b"".join(entries) + b"".join(blobs))
    return path


def read_ico(path):
    with open(path, "rb") as fh:
        data = fh.read()
    reserved, kind, count = struct.unpack_from("<HHH", data, 0)
    if reserved != 0 or kind != 1:
        raise StudioError("generated file is not an ICO")
    frames = []
    for i in range(count):
        w, h, _colours, _res, _planes, bpp, size, img_off = struct.unpack_from("<BBBBHHII", data, 6 + i * 16)
        w = w or 256
        h = h or 256
        frames.append((w, h, bpp, data[img_off:img_off + size]))
    return frames


# --------------------------------------------------------------------------
# PE icon resources
# --------------------------------------------------------------------------

def _res_name(pointer):
    value = ctypes.cast(pointer, ctypes.c_void_p).value or 0
    if value >> 16 == 0:
        return int(value & 0xFFFF)
    return ctypes.cast(pointer, wt.LPCWSTR).value


def list_icon_resources(path):
    handle = k32.LoadLibraryExW(path, None, LOAD_LIBRARY_AS_DATAFILE)
    if not handle:
        raise StudioError(f"cannot open {path} as a resource image: WinError {ctypes.get_last_error()}")
    groups, icons = [], []
    try:
        group_cb = ENUMRESNAMEPROC(lambda hm, t, n, lp: groups.append(_res_name(n)) or True)
        icon_cb = ENUMRESNAMEPROC(lambda hm, t, n, lp: icons.append(_res_name(n)) or True)
        k32.EnumResourceNamesW(handle, ctypes.c_void_p(RT_GROUP_ICON), group_cb, 0)
        k32.EnumResourceNamesW(handle, ctypes.c_void_p(RT_ICON), icon_cb, 0)
    finally:
        k32.FreeLibrary(handle)
    return groups, icons


def build_group(frames, icon_ids):
    buf = bytearray(struct.pack("<HHH", 0, 1, len(frames)))
    for (w, h, bpp, img), icon_id in zip(frames, icon_ids):
        buf += struct.pack("<BBBBHHIH", 0 if w >= 256 else w, 0 if h >= 256 else h, 0, 0, 1, bpp, len(img), icon_id)
    return bytes(buf)


def patch_exe(source, target, ico_path):
    frames = read_ico(ico_path)
    groups, existing = list_icon_resources(source)
    if not groups:
        raise StudioError("the executable has no icon group to replace")
    base = max([i for i in existing if isinstance(i, int)] + [1]) + 1
    icon_ids = [base + n for n in range(len(frames))]
    shutil.copy2(source, target)
    handle = k32.BeginUpdateResourceW(target, False)
    if not handle:
        raise StudioError(f"BeginUpdateResource failed: WinError {ctypes.get_last_error()}")
    try:
        for (_w, _h, _bpp, img), icon_id in zip(frames, icon_ids):
            if not k32.UpdateResourceW(handle, ctypes.c_void_p(RT_ICON), ctypes.c_void_p(icon_id), 0, img, len(img)):
                raise StudioError(f"UpdateResource(RT_ICON {icon_id}) failed: WinError {ctypes.get_last_error()}")
        group = build_group(frames, icon_ids)
        for group_id in groups:
            if not k32.UpdateResourceW(handle, ctypes.c_void_p(RT_GROUP_ICON), ctypes.c_void_p(group_id), 0, group, len(group)):
                raise StudioError(f"UpdateResource(RT_GROUP_ICON {group_id}) failed: WinError {ctypes.get_last_error()}")
    except Exception:
        k32.EndUpdateResourceW(handle, True)
        raise
    if not k32.EndUpdateResourceW(handle, False):
        raise StudioError(f"EndUpdateResource failed: WinError {ctypes.get_last_error()}")
    return groups, icon_ids


def verify_exe(path, ico_path):
    """The patched executable must carry one icon group of exactly our frames."""
    frames = read_ico(ico_path)
    groups, _icons = list_icon_resources(path)
    if not groups:
        return False, "no icon group in the patched executable"
    k32.FindResourceW.restype = wt.HRSRC
    k32.FindResourceW.argtypes = [wt.HMODULE, wt.LPVOID, wt.LPVOID]
    k32.SizeofResource.restype = wt.DWORD
    k32.SizeofResource.argtypes = [wt.HMODULE, wt.HRSRC]
    module = k32.LoadLibraryExW(path, None, LOAD_LIBRARY_AS_DATAFILE)
    if not module:
        return False, "patched executable cannot be loaded as a resource image"
    sizes = []
    try:
        for group_id in groups:
            resource = k32.FindResourceW(module, ctypes.c_void_p(group_id), ctypes.c_void_p(RT_GROUP_ICON))
            if resource:
                sizes.append(int(k32.SizeofResource(module, resource)))
    finally:
        k32.FreeLibrary(module)
    expected = 6 + 14 * len(frames)
    if expected not in sizes:
        return False, f"icon group size {sizes} does not match {expected}"
    return True, f"{len(frames)} frames installed in group {groups}"


# --------------------------------------------------------------------------
# executable swap
# --------------------------------------------------------------------------

def hide_file(path):
    attributes = k32.GetFileAttributesW(path)
    if attributes == 0xFFFFFFFF:
        return False
    k32.SetFileAttributesW(path, attributes | FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM)
    return True


def drop_stale(exe_path):
    """Delete leftovers from earlier swaps; hide them when still mapped."""
    removed = []
    folder = os.path.dirname(exe_path)
    prefix = os.path.basename(exe_path)
    stale = [
        f for f in os.listdir(folder)
        if f.startswith(prefix + ".previous") or f.startswith(prefix + ".pre-")
    ]
    for name in stale:
        path = os.path.join(folder, name)
        try:
            os.remove(path)
            removed.append(path)
        except OSError:
            hide_file(path)
    return removed


def cmd_cleanup(cfg):
    """Drop executables left over from earlier swaps (run once on startup)."""
    install = resolve_install(cfg)
    removed = drop_stale(os.path.join(install, "DeepSeek Harness.exe"))
    return {
        "ok": True,
        "command": "cleanup",
        "data": {"removed": [os.path.basename(path) for path in removed]},
        "log": [f"removed {len(removed)} leftover executable(s)"],
    }


def swap_exe(exe_path, staged):
    """Rename the live image aside, copy the staged one in, verify the hash."""
    folder = os.path.dirname(exe_path)
    previous = os.path.join(folder, os.path.basename(exe_path) + ".previous")
    if os.path.exists(previous):
        try:
            os.remove(previous)
        except OSError:
            previous = os.path.join(folder, f"{os.path.basename(exe_path)}.previous-{int(time.time())}")
    os.replace(exe_path, previous)
    try:
        shutil.copy2(staged, exe_path)
        if sha256_file(exe_path) != sha256_file(staged):
            raise StudioError("post-copy hash mismatch")
    except Exception as error:
        try:
            os.remove(exe_path)
        except OSError:
            pass
        os.replace(previous, exe_path)
        raise StudioError(f"executable swap failed, original restored: {error}")
    try:
        os.remove(previous)
        leftover = None
    except OSError:
        hide_file(previous)
        leftover = previous
    return exe_path, leftover


def smoke_test(exe_path, install_dir):
    """Run the patched binary in Electron's node mode from the install dir."""
    probe = os.path.join(install_dir, os.path.basename(exe_path) + ".smoke.exe")
    shutil.copy2(exe_path, probe)
    env = dict(os.environ, ELECTRON_RUN_AS_NODE="1")
    try:
        result = subprocess.run([probe, "-e", "console.log('icon-studio-smoke-ok')"],
                                capture_output=True, text=True, env=env, timeout=120)
        return "icon-studio-smoke-ok" in (result.stdout or "")
    except Exception:
        return False
    finally:
        try:
            os.remove(probe)
        except OSError:
            hide_file(probe)


# --------------------------------------------------------------------------
# shortcuts
# --------------------------------------------------------------------------

def powershell_exe():
    candidate = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    return candidate if os.path.exists(candidate) else "powershell.exe"


def ps_quote(text):
    return "'" + str(text).replace("'", "''") + "'"


def ps_run(script):
    result = subprocess.run([powershell_exe(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
                            capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise StudioError(f"PowerShell failed: {(result.stderr or result.stdout or '').strip()[:300]}")
    return result.stdout


def lnk_icon(path):
    out = ps_run("$s=(New-Object -ComObject WScript.Shell).CreateShortcut(%s); [Console]::Out.Write($s.IconLocation)" % ps_quote(path))
    return out.strip()


def lnk_set_icon(path, icon_location):
    ps_run("$s=(New-Object -ComObject WScript.Shell).CreateShortcut(%s); $s.IconLocation=%s; $s.Save()"
           % (ps_quote(path), ps_quote(icon_location)))


def lnk_target(path):
    out = ps_run("$s=(New-Object -ComObject WScript.Shell).CreateShortcut(%s); [Console]::Out.Write($s.TargetPath)" % ps_quote(path))
    return out.strip()


def exe_signature(path):
    """Authenticode status of a binary: {'status': ..., 'signer': ...}."""
    out = ps_run(
        "$s = Get-AuthenticodeSignature -LiteralPath %s; "
        "$signer = ''; if ($s.SignerCertificate) { $signer = $s.SignerCertificate.Subject }; "
        "[Console]::Out.Write($s.Status.ToString() + \"`n\" + $signer)" % ps_quote(path)
    )
    lines = out.splitlines()
    return {"status": lines[0].strip() if lines else "Unknown", "signer": lines[1].strip() if len(lines) > 1 else ""}


def find_shortcuts(exe_path):
    """Desktop + Start Menu shortcuts that launch this executable."""
    home = os.path.expanduser("~")
    appdata = os.environ.get("APPDATA", os.path.join(home, "AppData", "Roaming"))
    folders = [os.path.join(home, "Desktop"),
               os.path.join(appdata, "Microsoft", "Windows", "Start Menu", "Programs")]
    found = []
    for folder in folders:
        if not os.path.isdir(folder):
            continue
        for name in sorted(os.listdir(folder)):
            if not name.lower().endswith(".lnk"):
                continue
            path = os.path.join(folder, name)
            try:
                target = lnk_target(path)
            except StudioError:
                continue
            if target and os.path.normcase(target) == os.path.normcase(exe_path):
                found.append(path)
    return found


def refresh_shell():
    try:
        subprocess.run(["ie4uinit.exe", "-show"], capture_output=True, timeout=60)
    except Exception:
        pass


# --------------------------------------------------------------------------
# state
# --------------------------------------------------------------------------

def state_root():
    override = os.environ.get("DSH_ICON_STUDIO_HOME")
    if override:
        return override
    local = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local")
    return os.path.join(local, "DSH-IconStudio")


def state_path():
    return os.path.join(state_root(), "state.json")


def load_state():
    path = state_path()
    if not os.path.exists(path):
        return {"version": STATE_VERSION, "applied": None, "originals": {}}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            state = json.load(fh)
    except (OSError, ValueError):
        return {"version": STATE_VERSION, "applied": None, "originals": {}}
    state.setdefault("version", STATE_VERSION)
    state.setdefault("applied", None)
    state.setdefault("originals", {})
    return state


def save_state(state):
    ensure_dir(state_root())
    with open(state_path(), "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2, ensure_ascii=False)


# --------------------------------------------------------------------------
# operations
# --------------------------------------------------------------------------

def install_candidates():
    seen = []
    for raw in (
        os.environ.get("DSH_ICON_STUDIO_INSTALL"),
        os.environ.get("DSH_DESKTOP_DIR"),
    ):
        if raw:
            seen.append(raw)
    local = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local")
    seen.append(os.path.join(local, "Programs", "DeepSeek Harness"))
    for raw in ("C:\\Program Files\\DeepSeek Harness", "D:\\Program Files\\Deepseek Harness"):
        seen.append(raw)
    return seen


def resolve_install(cfg):
    """Accept an explicit installDir, otherwise look where DSH is installed."""
    given = cfg.get("installDir")
    if given:
        if not os.path.isdir(given):
            raise StudioError(f"not a directory: {given}")
        return given
    for candidate in install_candidates():
        if os.path.isfile(os.path.join(candidate, "DeepSeek Harness.exe")):
            return candidate
    raise StudioError(
        "could not find the DeepSeek Harness installation; pass installDir "
        "(looked in: " + ", ".join(install_candidates()) + ")"
    )


def paths(install_dir):
    resources = os.path.join(install_dir, "resources")
    return {
        "install": install_dir,
        "resources": resources,
        "tray": os.path.join(resources, "tray.ico"),
        "about": os.path.join(resources, "icon.png"),
        "exe": os.path.join(install_dir, "DeepSeek Harness.exe"),
    }


def icon_assets(slug):
    return ensure_dir(os.path.join(state_root(), "icons", slug))


def slug_for(image):
    base = os.path.splitext(os.path.basename(image))[0]
    digest = sha256_file(image)[:8].lower()
    # attachment stores and cache files are named after their own hash: such a
    # name says nothing, so fall back to a readable stem
    if not base or re.fullmatch(r"[0-9a-fA-F\-_]{20,}", base) or base.lower() in ("image", "png", "icon", "source"):
        base = "icon"
    cleaned = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in base).strip("-")[:40] or "icon"
    return f"{cleaned}-{digest}"


def render_master(image, background):
    width, height, rgba = decode_png(image)
    rgba, note = apply_background(rgba, width, height, background)
    x0, y0, x1, y1 = alpha_extent(rgba, width, height)
    rgba, cw, ch = crop(rgba, width, x0, y0, x1, y1)
    rgba, side = square_canvas(rgba, cw, ch)
    return rgba, side, note, (width, height)


def build_assets(image, background, slug):
    rgba, side, note, source = render_master(image, background)
    planes = channel_planes(rgba)
    folder = icon_assets(slug)
    frames = []
    rendered = {}
    for size in SIZES_DIB + (SIZE_PNG,):
        pixels = average_planes(planes, side, size)
        rendered[size] = pixels
        frames.append((size, build_ico(pixels, size, size == SIZE_PNG), size == SIZE_PNG))
    ico_path = write_ico(os.path.join(folder, "icon.ico"), frames)
    png_path = os.path.join(folder, "icon.png")
    with open(png_path, "wb") as fh:
        fh.write(encode_png(average_planes(planes, side, 512), 512, 512))
    preview_path = os.path.join(folder, "preview.png")
    write_contact_sheet(preview_path, rendered)
    source_copy = os.path.join(folder, "source.png")
    if os.path.abspath(image) != os.path.abspath(source_copy):
        try:
            shutil.copy2(image, source_copy)
        except OSError:
            source_copy = None
    return {
        "ico": ico_path,
        "png": png_path,
        "preview": preview_path,
        "slug": slug,
        "sizes": sorted(rendered),
        "note": note,
        "sourceImage": os.path.abspath(image),
        "sourceCopy": source_copy,
        "sourceWidth": source[0],
        "sourceHeight": source[1],
        "icoBytes": os.path.getsize(ico_path),
    }


def write_contact_sheet(path, rendered, background=(28, 28, 32)):
    """One PNG that shows every generated size on a dark strip."""
    sizes = [16, 24, 32, 48, 64, 128, 256]
    gap = 16
    width = sum(sizes) + gap * (len(sizes) + 1)
    height = 256 + gap * 2
    row = (bytes(background) + b"\xff") * width
    canvas = bytearray(row * height)
    x = gap
    baseline = gap + 256
    for size in sizes:
        pixels = rendered[size]
        top = baseline - size
        for y in range(size):
            for px in range(size):
                src = (y * size + px) * 4
                alpha = pixels[src + 3]
                if alpha == 0:
                    continue
                dst = ((top + y) * width + x + px) * 4
                if alpha == 255:
                    canvas[dst:dst + 3] = pixels[src:src + 3]
                else:
                    weight = alpha / 255.0
                    for c in range(3):
                        base = canvas[dst + c]
                        canvas[dst + c] = clamp_byte(pixels[src + c] * weight + base * (1 - weight))
        x += size + gap
    with open(path, "wb") as fh:
        fh.write(encode_png(canvas, width, height))
    return path


def cmd_status(cfg):
    install = resolve_install(cfg)
    p = paths(install)
    state = load_state()
    applied = state.get("applied") or {}
    ico = applied.get("ico")
    result = {
        "installDir": install,
        "exe": {"path": p["exe"], "exists": os.path.exists(p["exe"])},
        "tray": {"path": p["tray"], "exists": os.path.exists(p["tray"])},
        "about": {"path": p["about"], "exists": os.path.exists(p["about"])},
        "applied": applied or None,
        "stateFile": state_path(),
        "originals": state.get("originals") or {},
    }
    if os.path.exists(p["exe"]):
        current = sha256_file(p["exe"])
        result["exe"]["sha256"] = current
        marker = applied.get("exeSha256")
        result["exe"]["customIcon"] = bool(marker) and current.upper() == str(marker).upper()
        groups, _icons = list_icon_resources(p["exe"])
        result["exe"]["iconGroups"] = groups
        try:
            result["exe"]["signature"] = exe_signature(p["exe"])
        except StudioError as error:
            result["exe"]["signature"] = {"status": "Unknown", "signer": "", "error": str(error)}
    if ico and os.path.exists(ico) and os.path.exists(p["tray"]):
        result["tray"]["matchesAppliedIcon"] = sha256_file(p["tray"]) == sha256_file(ico)
    shortcuts = []
    for path in find_shortcuts(p["exe"]):
        try:
            shortcuts.append({"path": path, "iconLocation": lnk_icon(path)})
        except StudioError as error:
            shortcuts.append({"path": path, "error": str(error)})
    result["shortcuts"] = shortcuts
    leftovers = [f for f in os.listdir(install) if f.startswith("DeepSeek Harness.exe.previous")]
    result["leftovers"] = leftovers
    return {"ok": True, "command": "status", "data": result, "log": []}


def safe_slug(slug):
    """A slug names a folder under the state root, so keep it boring."""
    text = str(slug or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,80}", text) or ".." in text:
        raise StudioError(f"not a valid icon name: {slug!r}")
    return text


def source_image(cfg):
    """The image to work from: a path, or a slug built earlier."""
    image = cfg.get("image")
    if image:
        return image
    slug = cfg.get("slug")
    if slug:
        folder = os.path.join(state_root(), "icons", safe_slug(slug))
        for name in ("source.png", "icon.png"):
            candidate = os.path.join(folder, name)
            if os.path.exists(candidate):
                return candidate
        raise StudioError(f"no image stored for {slug!r}; upload or build it first")
    raise StudioError("pass image (a PNG path) or slug (a previously built icon)")


def cmd_apply(cfg):
    install = resolve_install(cfg)
    image = source_image(cfg)
    background = cfg.get("background") or "auto"
    targets = cfg.get("targets") or ["tray", "shortcuts", "exe"]
    smoke = cfg.get("smoke", True)
    log = []
    p = paths(install)
    if not os.path.exists(image):
        raise StudioError(f"image not found: {image}")
    if not os.path.exists(p["exe"]):
        raise StudioError(f"DeepSeek Harness.exe not found in {install}")
    for target in targets:
        if target not in ("tray", "shortcuts", "exe"):
            raise StudioError(f"unknown target {target!r} (use tray, shortcuts, exe)")

    state = load_state()
    originals = state.setdefault("originals", {})
    backups = ensure_dir(os.path.join(state_root(), "originals"))
    if not originals.get("trayIco") and os.path.exists(p["tray"]):
        shutil.copy2(p["tray"], os.path.join(backups, "tray.ico"))
        originals["trayIco"] = os.path.join(backups, "tray.ico")
        log.append("backed up the original resources/tray.ico")
    if not originals.get("aboutPng") and os.path.exists(p["about"]):
        shutil.copy2(p["about"], os.path.join(backups, "icon.png"))
        originals["aboutPng"] = os.path.join(backups, "icon.png")
        log.append("backed up the original resources/icon.png")

    slug = cfg.get("slug") or slug_for(image)
    assets = build_assets(image, background, slug)
    log.append(f"built {len(assets['sizes'])} icon sizes ({human(assets['icoBytes'])}) from {os.path.basename(image)}")
    log.append(assets["note"])

    result = {"slug": slug, "assets": assets, "applied": [], "warnings": [], "needsRestart": False}

    if "tray" in targets:
        shutil.copy2(assets["ico"], p["tray"])
        shutil.copy2(assets["png"], p["about"])
        result["applied"].append("tray icon (resources/tray.ico)")
        result["applied"].append("about panel icon (resources/icon.png)")
        result["needsRestart"] = True
        log.append("wrote resources/tray.ico and resources/icon.png")

    if "shortcuts" in targets:
        shortcut_state = originals.setdefault("shortcuts", {})
        touched = []
        for path in find_shortcuts(p["exe"]):
            if path not in shortcut_state:
                try:
                    shortcut_state[path] = lnk_icon(path)
                except StudioError:
                    shortcut_state[path] = ""
            lnk_set_icon(path, assets["ico"] + ",0")
            touched.append(path)
            result["applied"].append(f"shortcut icon ({os.path.basename(path)})")
        if not touched:
            result["warnings"].append("no Desktop or Start Menu shortcut launches this executable")
        log.append(f"retargeted {len(touched)} shortcut(s)")

    if "exe" in targets:
        if not originals.get("exe"):
            backup_exe = os.path.join(backups, "DeepSeek Harness.exe")
            if not os.path.exists(backup_exe):
                shutil.copy2(p["exe"], backup_exe)
                log.append(f"backed up the original executable ({human(os.path.getsize(backup_exe))})")
            originals["exe"] = backup_exe
        staged = os.path.join(state_root(), "staging", "DeepSeek Harness.exe")
        ensure_dir(os.path.dirname(staged))
        # Patching an already patched binary would stack a second copy of the
        # frames and grow the file every time. When the live binary is our own
        # build, patch the recorded vendor original instead.
        base = p["exe"]
        previous = (state.get("applied") or {}).get("exeSha256")
        if originals.get("exe") and os.path.exists(originals["exe"]) and previous:
            if sha256_file(p["exe"]).upper() == str(previous).upper():
                base = originals["exe"]
                log.append("re-patching the original executable instead of stacking another patch")
        patch_exe(base, staged, assets["ico"])
        ok, detail = verify_exe(staged, assets["ico"])
        if not ok:
            raise StudioError(f"patched executable failed verification: {detail}")
        log.append(f"patched icon resources: {detail}")
        if smoke and not smoke_test(staged, install):
            result["warnings"].append("the patched binary did not pass the node-mode smoke test inside the install dir; the icon was NOT applied")
            log.append("smoke test failed - executable left untouched")
        else:
            if smoke:
                log.append("smoke test passed")
            exe_path, leftover = swap_exe(p["exe"], staged)
            if leftover:
                result["warnings"].append("the previous executable is still mapped by the running app; it is hidden and deleted on the next run")
            result["applied"].append("window/taskbar/Explorer icon (resource patch of DeepSeek Harness.exe)")
            result["needsRestart"] = True
            state["appliedExeSha256"] = sha256_file(exe_path)
            log.append("executable swapped in")
        try:
            os.remove(staged)
        except OSError:
            pass

    refresh_shell()
    state["applied"] = {
        "slug": slug,
        "image": os.path.abspath(image),
        "ico": assets["ico"],
        "png": assets["png"],
        "preview": assets["preview"],
        "targets": list(targets),
        "appliedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "exeSha256": state.get("appliedExeSha256"),
    }
    state["version"] = STATE_VERSION
    save_state(state)
    drop_stale(p["exe"])
    result["assets"] = assets
    return {"ok": True, "command": "apply", "data": result, "log": log}


def cmd_restore(cfg):
    install = resolve_install(cfg)
    log = []
    p = paths(install)
    state = load_state()
    originals = state.get("originals") or {}
    if not state.get("applied") and not originals:
        raise StudioError("nothing to restore: this plugin has never applied an icon here")
    warnings = []

    if originals.get("trayIco") and os.path.exists(originals["trayIco"]):
        shutil.copy2(originals["trayIco"], p["tray"])
        log.append("restored resources/tray.ico")
    if originals.get("aboutPng") and os.path.exists(originals["aboutPng"]):
        shutil.copy2(originals["aboutPng"], p["about"])
        log.append("restored resources/icon.png")

    for path, icon_location in (originals.get("shortcuts") or {}).items():
        if not os.path.exists(path):
            continue
        try:
            lnk_set_icon(path, icon_location)
            log.append(f"restored shortcut icon: {os.path.basename(path)}")
        except StudioError as error:
            warnings.append(f"{os.path.basename(path)}: {error}")

    exe_backup = originals.get("exe")
    if exe_backup and os.path.exists(exe_backup):
        staged = os.path.join(state_root(), "staging", "DeepSeek Harness.exe")
        ensure_dir(os.path.dirname(staged))
        shutil.copy2(exe_backup, staged)
        swapped, leftover = swap_exe(p["exe"], staged)
        del swapped
        log.append("restored the original executable")
        if leftover:
            warnings.append("the replaced executable is still mapped by the running app and will be deleted on the next run")
    elif state.get("applied"):
        warnings.append("no executable backup was recorded, so the window/taskbar icon is unchanged")

    refresh_shell()
    state["applied"] = None
    state.pop("appliedExeSha256", None)
    save_state(state)
    drop_stale(p["exe"])
    return {"ok": True, "command": "restore", "data": {"warnings": warnings, "needsRestart": True}, "log": log}


def cmd_build(cfg):
    """Build the icon assets without touching the installation."""
    image = source_image(cfg)
    if not os.path.exists(image):
        raise StudioError(f"image not found: {image}")
    background = cfg.get("background") or "auto"
    slug = cfg.get("slug") or slug_for(image)
    assets = build_assets(image, background, slug)
    return {"ok": True, "command": "build", "data": {"assets": assets}, "log": [assets["note"]]}


def cmd_ingest(cfg):
    """Store an uploaded PNG under the state root and hand back its path."""
    name = os.path.basename(str(cfg.get("name") or "upload.png"))
    cleaned = "".join(ch if ch.isalnum() or ch in "-_." else "-" for ch in name).strip("-.") or "upload.png"
    if not cleaned.lower().endswith(".png"):
        cleaned += ".png"
    data = cfg.get("data")
    if not isinstance(data, str) or data.strip() == "":
        raise StudioError("no image data in the request")
    try:
        raw = base64.b64decode(data, validate=True)
    except Exception as error:
        raise StudioError(f"image data is not valid base64: {error}")
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise StudioError("the uploaded file is not a PNG")
    folder = ensure_dir(os.path.join(state_root(), "uploads"))
    target = os.path.join(folder, cleaned)
    if os.path.exists(target):
        stem, ext = os.path.splitext(cleaned)
        target = os.path.join(folder, f"{stem}-{sha256_bytes(raw)[:8]}{ext}")
    with open(target, "wb") as fh:
        fh.write(raw)
    uploads = sorted(
        (os.path.join(folder, item) for item in os.listdir(folder)),
        key=lambda path: os.path.getmtime(path),
        reverse=True,
    )
    for stale in uploads[10:]:
        try:
            os.remove(stale)
        except OSError:
            pass
    return {"ok": True, "command": "ingest", "data": {"path": target, "bytes": len(raw)}, "log": []}


def cmd_preview(cfg):
    """Resolve the contact sheet of a built icon so the settings page can show it."""
    folder = os.path.join(state_root(), "icons", safe_slug(cfg.get("slug")))
    path = os.path.join(folder, "preview.png")
    if not os.path.exists(path):
        raise StudioError(f"no preview for {cfg.get('slug')!r}; build it first")
    return {
        "ok": True,
        "command": "preview",
        "data": {"path": path, "bytes": os.path.getsize(path)},
        "log": [],
    }


def cmd_selftest(cfg):
    """Build an icon from a synthetic image and check the frames it emits."""
    folder = ensure_dir(cfg.get("outDir") or os.path.join(state_root(), "selftest"))
    size = 96
    rgba = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            dx, dy = x - size / 2 + 0.5, y - size / 2 + 0.5
            radius = (dx * dx + dy * dy) ** 0.5
            i = (y * size + x) * 4
            if 24 <= radius <= 44:
                rgba[i] = 240
                rgba[i + 1] = 90
                rgba[i + 2] = 40
                rgba[i + 3] = 255
            elif radius < 16:
                rgba[i + 3] = 60
    source = os.path.join(folder, "selftest-source.png")
    with open(source, "wb") as fh:
        fh.write(encode_png(rgba, size, size))
    assets = build_assets(source, "alpha", "selftest")
    frames = read_ico(assets["ico"])
    sizes = sorted({frame[0] for frame in frames})
    problems = []
    if sizes != sorted(SIZES_DIB + (SIZE_PNG,)):
        problems.append(f"unexpected sizes {sizes}")
    for w, h, bpp, img in frames:
        if w != h:
            problems.append(f"frame {w}x{h} is not square")
        if bpp != 32:
            problems.append(f"frame {w} bit depth {bpp}")
        if w == 256 and img[:8] != b"\x89PNG\r\n\x1a\n":
            problems.append("256 px frame is not PNG compressed")
        if w != 256:
            declared_w, declared_h, plane_count, bit_depth = struct.unpack_from("<iiHH", img, 4)
            if declared_w != w or declared_h != w * 2 or plane_count != 1 or bit_depth != 32:
                problems.append(f"DIB header mismatch for {w} px")
    if os.path.getsize(assets["ico"]) < 1000:
        problems.append("icon file is suspiciously small")
    return {"ok": not problems, "command": "selftest", "data": {"assets": assets, "frames": len(frames), "problems": problems}, "log": []}


COMMANDS = {
    "status": cmd_status,
    "build": cmd_build,
    "ingest": cmd_ingest,
    "preview": cmd_preview,
    "apply": cmd_apply,
    "restore": cmd_restore,
    "cleanup": cmd_cleanup,
    "selftest": cmd_selftest,
}


def main(argv):
    if "--json-in" in argv:
        payload = json.loads(sys.stdin.read() or "{}")
        command = payload.get("command")
        cfg = payload
    else:
        raise SystemExit("usage: iconstudio.py --json-in < payload.json")
    handler = COMMANDS.get(command)
    if handler is None:
        raise SystemExit(f"unknown command {command!r}: {sorted(COMMANDS)}")
    try:
        result = handler(cfg)
    except StudioError as error:
        print(json.dumps({"ok": False, "command": command, "error": str(error)}))
        return 1
    except Exception as error:  # unexpected: still answer in JSON
        print(json.dumps({"ok": False, "command": command, "error": f"{type(error).__name__}: {error}"}))
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
