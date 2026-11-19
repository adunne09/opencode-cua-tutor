/**
 * Screenshot processing for visual targeting:
 * - Bilinear crop/resize obeying TypeSafe's 280..1568 px bounds on both axes.
 * - Overlapping tile grids for coarse-to-fine Box search (TypeSafe Box docs: small targets in
 *   large windows need region selection before tight localization).
 * - Zoomed context crops + red-box overlays for fine Box refinement, self-verification, and
 *   legacy crop-choice fallback.
 * - Patch pixel comparison for freshness validation on non-AX (canvas/pixel) Box targets.
 */
import { PNG } from 'pngjs';

import type { Rect } from './candidates.js';

export type Screenshot = { png: PNG; width: number; height: number };

export function decodeScreenshot(base64: string): Screenshot | undefined {
  try {
    const png = PNG.sync.read(Buffer.from(base64, 'base64'));
    return { png, width: png.width, height: png.height };
  } catch {
    return undefined;
  }
}

/** TypeSafe's current minimum and maximum width/height per image. */
export const CROP_SIDE = 280;
export const MAX_IMAGE_SIDE = 1568;

/** Clamp an output dimension pair into TypeSafe's [280, 1568] bounds while keeping aspect ratio reasonable. */
export function fitImageSize(srcW: number, srcH: number, targetLongEdge: number): { width: number; height: number } {
  const safeW = Math.max(1, srcW);
  const safeH = Math.max(1, srcH);
  const longEdge = Math.min(MAX_IMAGE_SIDE, Math.max(CROP_SIDE, targetLongEdge));
  const scale = longEdge / Math.max(safeW, safeH);
  let width = Math.round(safeW * scale);
  let height = Math.round(safeH * scale);
  if (width < CROP_SIDE) width = CROP_SIDE;
  if (height < CROP_SIDE) height = CROP_SIDE;
  if (width > MAX_IMAGE_SIDE) width = MAX_IMAGE_SIDE;
  if (height > MAX_IMAGE_SIDE) height = MAX_IMAGE_SIDE;
  return { width, height };
}

/**
 * Bilinear crop and resize of `region` (in screenshot pixels) to `outW x outH`, optionally
 * drawing a crisp 3px red outline around `redBox` (also in screenshot pixels).
 */
export function cropResize(
  shot: Screenshot,
  region: Rect,
  outW: number,
  outH: number,
  redBox?: Rect
): Uint8Array {
  const width = Math.max(CROP_SIDE, Math.min(MAX_IMAGE_SIDE, Math.round(outW)));
  const height = Math.max(CROP_SIDE, Math.min(MAX_IMAGE_SIDE, Math.round(outH)));
  const out = new PNG({ width, height });
  const src = shot.png.data;
  const sw = shot.width;
  const sh = shot.height;
  const rw = Math.max(1, region.w);
  const rh = Math.max(1, region.h);

  for (let y = 0; y < height; y++) {
    const sy = region.y + ((y + 0.5) * rh) / height - 0.5;
    const y0 = Math.floor(sy);
    const y1 = y0 + 1;
    const fy = sy - y0;
    const cy0 = Math.max(0, Math.min(sh - 1, y0));
    const cy1 = Math.max(0, Math.min(sh - 1, y1));
    const outOfY = sy < -0.5 || sy > sh - 0.5;

    for (let x = 0; x < width; x++) {
      const sx = region.x + ((x + 0.5) * rw) / width - 0.5;
      const di = (y * width + x) * 4;
      out.data[di + 3] = 255;
      if (outOfY || sx < -0.5 || sx > sw - 0.5) {
        out.data[di] = out.data[di + 1] = out.data[di + 2] = 40;
        continue;
      }
      const x0 = Math.floor(sx);
      const x1 = x0 + 1;
      const fx = sx - x0;
      const cx0 = Math.max(0, Math.min(sw - 1, x0));
      const cx1 = Math.max(0, Math.min(sw - 1, x1));
      const i00 = (cy0 * sw + cx0) * 4;
      const i10 = (cy0 * sw + cx1) * 4;
      const i01 = (cy1 * sw + cx0) * 4;
      const i11 = (cy1 * sw + cx1) * 4;
      for (let c = 0; c < 3; c++) {
        const top = src[i00 + c] * (1 - fx) + src[i10 + c] * fx;
        const bot = src[i01 + c] * (1 - fx) + src[i11 + c] * fx;
        out.data[di + c] = Math.round(top * (1 - fy) + bot * fy);
      }
    }
  }

  if (redBox) {
    const ex0 = Math.round(((redBox.x - region.x) / rw) * width) - 1;
    const ey0 = Math.round(((redBox.y - region.y) / rh) * height) - 1;
    const ex1 = Math.round(((redBox.x + redBox.w - region.x) / rw) * width) + 1;
    const ey1 = Math.round(((redBox.y + redBox.h - region.y) / rh) * height) + 1;
    const paint = (px: number, py: number) => {
      if (px < 0 || py < 0 || px >= width || py >= height) return;
      const i = (py * width + px) * 4;
      out.data[i] = 255;
      out.data[i + 1] = 32;
      out.data[i + 2] = 32;
    };
    for (let t = 0; t < 3; t++) {
      for (let x = ex0 - t; x <= ex1 + t; x++) {
        paint(x, ey0 - t);
        paint(x, ey1 + t);
      }
      for (let y = ey0 - t; y <= ey1 + t; y++) {
        paint(ex0 - t, y);
        paint(ex1 + t, y);
      }
    }
  }

  return new Uint8Array(PNG.sync.write(out, { deflateLevel: 6, filterType: 1 }));
}

export type Tile = {
  id: string;
  region: Rect;
  bytes: Uint8Array;
};

/**
 * Divide a screenshot into overlapping tiles so small icons (14-28px) stay recognizable and
 * never sit on a cut seam. Small windows stay a single tile.
 */
export function tileGrid(shot: Screenshot): Tile[] {
  const { width: w, height: h } = shot;
  if (Math.max(w, h) <= 680) {
    const region: Rect = { x: 0, y: 0, w, h };
    const size = fitImageSize(w, h, Math.max(w, h));
    return [{ id: 'full_window', region, bytes: cropResize(shot, region, size.width, size.height) }];
  }
  const aspect = w / Math.max(1, h);
  const cols = aspect >= 1.35 ? 3 : 2;
  const rows = aspect <= 0.75 ? 3 : 2;
  const overlapX = Math.round(w * 0.12);
  const overlapY = Math.round(h * 0.16);
  const tileW = Math.min(w, Math.ceil((w + overlapX * (cols - 1)) / cols));
  const tileH = Math.min(h, Math.ceil((h + overlapY * (rows - 1)) / rows));
  const rowNames = rows === 2 ? ['top', 'bottom'] : ['top', 'middle', 'bottom'];
  const colNames = cols === 2 ? ['left', 'right'] : ['left', 'center', 'right'];
  const tiles: Tile[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const rx = Math.max(0, Math.min(w - tileW, Math.round((c * (w - tileW)) / (cols - 1))));
      const ry = Math.max(0, Math.min(h - tileH, Math.round((r * (h - tileH)) / (rows - 1))));
      const region: Rect = { x: rx, y: ry, w: tileW, h: tileH };
      const size = fitImageSize(tileW, tileH, 640);
      tiles.push({
        id: `${rowNames[r]}_${colNames[c]}`,
        region,
        bytes: cropResize(shot, region, size.width, size.height),
      });
    }
  }
  return tiles;
}

/** High-resolution crop of a winning tile for Pass-2 Box localization. */
export function tileHiRes(shot: Screenshot, region: Rect): Uint8Array {
  const size = fitImageSize(region.w, region.h, 1200);
  return cropResize(shot, region, size.width, size.height);
}

/**
 * Tight context crop centered on `target` (typically a small coarse box < 60px), upscaled ~3x
 * so tiny 14-28px controls and adjacent row labels are crisp for Pass-3 fine Box & verification.
 */
export function zoomRegionAround(shot: Screenshot, target: Rect): { region: Rect; width: number; height: number } {
  const cw = Math.min(shot.width, Math.max(340, Math.round(target.w * 4)));
  const ch = Math.min(shot.height, Math.max(220, Math.round(target.h * 4)));
  const cx = target.x + target.w / 2;
  const cy = target.y + target.h / 2;
  const rx = Math.max(0, Math.min(shot.width - cw, Math.round(cx - cw / 2)));
  const ry = Math.max(0, Math.min(shot.height - ch, Math.round(cy - ch / 2)));
  const size = fitImageSize(cw, ch, Math.min(1080, Math.round(Math.max(cw, ch) * 3)));
  return { region: { x: rx, y: ry, w: cw, h: ch }, ...size };
}

/**
 * Pixel-level freshness check for non-AX (canvas/box) targets: confirm the window dimensions
 * and a padded local patch around the target rect did not change between observation and verify.
 */
export function patchUnchanged(before: Screenshot, after: Screenshot, target: Rect, pad = 24): boolean {
  if (before.width !== after.width || before.height !== after.height) return false;
  const x0 = Math.max(0, Math.floor(target.x - pad));
  const y0 = Math.max(0, Math.floor(target.y - pad));
  const x1 = Math.min(before.width, Math.ceil(target.x + target.w + pad));
  const y1 = Math.min(before.height, Math.ceil(target.y + target.h + pad));
  if (x1 <= x0 || y1 <= y0) return false;
  let diff = 0;
  let total = 0;
  const a = before.png.data;
  const b = after.png.data;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * before.width + x) * 4;
      const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (d > 18) diff++;
      total++;
    }
  }
  // Allow tiny cursor/hover/caret flicker (< 2% of patch pixels), reject real UI/scroll changes.
  return total > 0 && diff / total < 0.02;
}

/** Whole-window image for optional single-shot normalization. Pad short sides; preserve the inverse transform. */
export function normalizeScreenshot(shot: Screenshot) {
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(shot.width, shot.height));
  const contentWidth = Math.max(1, Math.round(shot.width * scale));
  const contentHeight = Math.max(1, Math.round(shot.height * scale));
  const width = Math.max(CROP_SIDE, contentWidth);
  const height = Math.max(CROP_SIDE, contentHeight);
  const out = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const di = (y * width + x) * 4;
      out.data[di + 3] = 255;
      if (x >= contentWidth || y >= contentHeight) {
        out.data[di] = out.data[di + 1] = out.data[di + 2] = 40;
      } else {
        const sx = Math.min(shot.width - 1, Math.floor((x * shot.width) / contentWidth));
        const sy = Math.min(shot.height - 1, Math.floor((y * shot.height) / contentHeight));
        const si = (sy * shot.width + sx) * 4;
        shot.png.data.copy(out.data, di, si, si + 4);
      }
    }
  }
  return {
    bytes: new Uint8Array(PNG.sync.write(out)),
    width,
    height,
    toOriginal: (rect: Rect): Rect | undefined => {
      if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > contentWidth || rect.y + rect.h > contentHeight) return undefined;
      return {
        x: (rect.x * shot.width) / contentWidth,
        y: (rect.y * shot.height) / contentHeight,
        w: (rect.w * shot.width) / contentWidth,
        h: (rect.h * shot.height) / contentHeight,
      };
    },
  };
}

/**
 * PNG bytes (CROP_SIDE x CROP_SIDE) of a square region centred on `rect` (screenshot pixels), with
 * context around it (row labels, neighbours) and the element outlined in red.
 */
export function cropCandidate(shot: Screenshot, rect: Rect): Uint8Array {
  const side = Math.round(Math.max(rect.w, rect.h) + 2 * Math.max(24, 1.5 * Math.min(Math.max(rect.w, rect.h), 120)));
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const x0 = Math.round(cx - side / 2);
  const y0 = Math.round(cy - side / 2);
  return cropResize(shot, { x: x0, y: y0, w: side, h: side }, CROP_SIDE, CROP_SIDE, rect);
}
