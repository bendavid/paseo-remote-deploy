/**
 * A QR code encoder for one byte-mode segment at error correction level M, the case a pairing link
 * needs. Plugins cannot ship the daemon's QR library without a runtime dependency, so this follows
 * ISO/IEC 18004 directly; the structure mirrors Project Nayuki's QR Code generator (MIT).
 *
 * Returns the modules as rows, `true` for dark, without the quiet zone around the symbol.
 */
export function encodeQr(text: string): boolean[][] {
  const data = new TextEncoder().encode(text);
  const version = chooseVersion(data.length);
  return new QrSymbol(version, addEccAndInterleave(dataCodewords(data, version), version)).modules;
}

// Level M. Index 0 is unused so that the arrays index by version.
const ECC_CODEWORDS_PER_BLOCK = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];
const ERROR_CORRECTION_BLOCKS = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25,
  26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];
/** The two format bits for level M. */
const FORMAT_BITS_M = 0;

function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignments = Math.floor(version / 7) + 2;
    result -= (25 * alignments - 10) * alignments - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewordCount(version: number): number {
  return (
    Math.floor(rawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[version]! * ERROR_CORRECTION_BLOCKS[version]!
  );
}

function countBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

function chooseVersion(byteCount: number): number {
  for (let version = 1; version <= 40; version++) {
    if (4 + countBits(version) + 8 * byteCount <= dataCodewordCount(version) * 8) return version;
  }
  throw new RangeError("The text is too long for a QR code.");
}

function dataCodewords(data: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const append = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  append(0b0100, 4);
  append(data.length, countBits(version));
  for (const byte of data) append(byte, 8);
  const capacity = dataCodewordCount(version) * 8;
  append(0, Math.min(4, capacity - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) append(pad, 8);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  }
  return codewords;
}

function addEccAndInterleave(data: number[], version: number): number[] {
  const blockCount = ERROR_CORRECTION_BLOCKS[version]!;
  const eccLength = ECC_CODEWORDS_PER_BLOCK[version]!;
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blockCount - (rawCodewords % blockCount);
  const shortBlockLength = Math.floor(rawCodewords / blockCount);
  const divisor = reedSolomonDivisor(eccLength);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < blockCount; i++) {
    const block = data.slice(k, k + shortBlockLength - eccLength + (i < shortBlocks ? 0 : 1));
    k += block.length;
    const ecc = reedSolomonRemainder(block, divisor);
    // Short blocks get a placeholder so every block has the same length while interleaving.
    if (i < shortBlocks) block.push(0);
    blocks.push(block.concat(ecc));
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLength - eccLength || j >= shortBlocks) result.push(block[i]!);
    });
  }
  return result;
}

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function reedSolomonDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    divisor.forEach((coefficient, i) => {
      result[i]! ^= gfMultiply(coefficient, factor);
    });
  }
  return result;
}

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

class QrSymbol {
  readonly size: number;
  readonly modules: boolean[][];
  private readonly version: number;
  private readonly isFunction: boolean[][];

  constructor(version: number, codewords: number[]) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
    this.isFunction = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
    this.drawFunctionPatterns();
    this.drawCodewords(codewords);
    // The mask with the lowest penalty is easiest for cameras to read.
    let best = 0;
    let bestPenalty = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      this.applyMask(mask);
      this.drawFormatBits(mask);
      const penalty = this.penalty();
      if (penalty < bestPenalty) {
        best = mask;
        bestPenalty = penalty;
      }
      this.applyMask(mask);
    }
    this.applyMask(best);
    this.drawFormatBits(best);
  }

  private set(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.isFunction[y]![x] = true;
  }

  private drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);
    const positions = this.alignmentPositions();
    const last = positions.length - 1;
    positions.forEach((x, i) => {
      positions.forEach((y, j) => {
        // The three corners with finder patterns have no alignment pattern.
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        this.drawAlignment(x, y);
      });
    });
    this.drawFormatBits(0);
    this.drawVersion();
  }

  private drawFinder(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const [xx, yy] = [x + dx, y + dy];
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
          this.set(xx, yy, distance !== 2 && distance !== 4);
        }
      }
    }
  }

  private drawAlignment(x: number, y: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++)
        this.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  private alignmentPositions(): number[] {
    if (this.version === 1) return [];
    const count = Math.floor(this.version / 7) + 2;
    const step = Math.floor((this.version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
    const result = [6];
    for (let position = this.size - 7; result.length < count; position -= step) {
      result.splice(1, 0, position);
    }
    return result;
  }

  private drawFormatBits(mask: number): void {
    const data = (FORMAT_BITS_M << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const bits = ((data << 10) | remainder) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(this.size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, this.size - 15 + i, bit(i));
    this.set(8, this.size - 8, true);
  }

  private drawVersion(): void {
    if (this.version < 7) return;
    let remainder = this.version;
    for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (this.version << 12) | remainder;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, dark);
      this.set(b, a, dark);
    }
  }

  private drawCodewords(codewords: number[]): void {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < this.size; vertical++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vertical : vertical;
          if (!this.isFunction[y]![x] && i < codewords.length * 8) {
            this.modules[y]![x] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  private applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.isFunction[y]![x] && maskApplies(mask, x, y)) {
          this.modules[y]![x] = !this.modules[y]![x];
        }
      }
    }
  }

  private penalty(): number {
    let result = 0;
    const lines = (vertical: boolean) => {
      for (let a = 0; a < this.size; a++) {
        let runColor = false;
        let runLength = 0;
        const history = [0, 0, 0, 0, 0, 0, 0];
        for (let b = 0; b < this.size; b++) {
          const color = vertical ? this.modules[b]![a]! : this.modules[a]![b]!;
          if (color === runColor) {
            runLength++;
            if (runLength === 5) result += PENALTY_N1;
            else if (runLength > 5) result++;
          } else {
            this.addRun(runLength, history);
            if (!runColor) result += this.finderLikePatterns(history) * PENALTY_N3;
            runColor = color;
            runLength = 1;
          }
        }
        if (runColor) {
          this.addRun(runLength, history);
          runLength = 0;
        }
        this.addRun(runLength + this.size, history);
        result += this.finderLikePatterns(history) * PENALTY_N3;
      }
    };
    lines(false);
    lines(true);
    for (let y = 0; y < this.size - 1; y++) {
      for (let x = 0; x < this.size - 1; x++) {
        const color = this.modules[y]![x];
        if (
          color === this.modules[y]![x + 1] &&
          color === this.modules[y + 1]![x] &&
          color === this.modules[y + 1]![x + 1]
        ) {
          result += PENALTY_N2;
        }
      }
    }
    const dark = this.modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
    const total = this.size * this.size;
    result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * PENALTY_N4;
    return result;
  }

  private addRun(length: number, history: number[]): void {
    // The light border before the first run.
    if (history[0] === 0) length += this.size;
    history.pop();
    history.unshift(length);
  }

  private finderLikePatterns(history: number[]): number {
    const n = history[1]!;
    const core =
      n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
    return (
      (core && history[0]! >= n * 4 && history[6]! >= n ? 1 : 0) +
      (core && history[6]! >= n * 4 && history[0]! >= n ? 1 : 0)
    );
  }
}

function maskApplies(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}
