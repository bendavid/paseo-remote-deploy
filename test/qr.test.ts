import { describe, expect, test } from "vitest";
import { encodeQr } from "../server/qr";
import { decodeQr as decode } from "./qr-decode";

function text(length: number, seed: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~:/?#=&%+";
  let state = seed;
  let result = "";
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    result += alphabet[state % alphabet.length];
  }
  return result;
}

describe("encodeQr", () => {
  // One block (v1-3), several blocks of one length (v4-9), mixed short and long blocks with
  // version information (v7+), and the largest symbols.
  test.each([1, 14, 30, 61, 100, 154, 230, 321, 500, 1000, 2000, 2331])(
    "%i bytes decode to the same text",
    (length) => {
      const value = text(length, length);
      const modules = encodeQr(value);
      expect(modules.length % 4).toBe(1);
      expect(decode(modules)).toBe(value);
    },
  );

  test("a pairing link fits a symbol a phone reads easily", () => {
    const link =
      "https://app.paseo.sh/#connect=" +
      encodeURIComponent(
        "relay://relay.paseo.sh:443/srv_0123456789abcdef?key=" +
          "A".repeat(43) +
          "%3D&ssl=true&password=" +
          "x".repeat(32),
      );
    const modules = encodeQr(link);
    expect(modules.length).toBeLessThanOrEqual(65);
    expect(decode(modules)).toBe(link);
  });

  test("refuses text longer than a version 40 symbol holds", () => {
    expect(() => encodeQr("x".repeat(2332))).toThrow(RangeError);
  });
});
