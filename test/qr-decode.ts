import jsQR from "jsqr";

/** Draws the symbol with a 4-module quiet zone, as a screen would, and reads it back. */
export function decodeQr(modules: boolean[][], scale = 4): string | null {
  const quiet = 4;
  const size = (modules.length + quiet * 2) * scale;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const offset = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4;
          pixels.set([0, 0, 0, 255], offset);
        }
      }
    });
  });
  return jsQR(pixels, size, size)?.data ?? null;
}
