import { describe, expect, test } from "vitest";
import {
  newestVersionInIndex,
  nodeBuildFor,
  releaseFromShasums,
  resolveNodeRelease,
  UnsupportedPlatformError,
} from "../server/node-release";

const SHASUMS = [
  "c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428  node-v22.23.4-darwin-arm64.tar.gz",
  "f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9  node-v22.23.4-linux-arm64.tar.gz",
  "b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406  node-v22.23.4-linux-x64.tar.gz",
  "1111111111111111111111111111111111111111111111111111111111111111  node-v22.23.4-linux-x64.tar.xz",
].join("\n");

describe("nodeBuildFor", () => {
  test("uses official builds for macOS and current glibc", () => {
    expect(nodeBuildFor({ os: "darwin", arch: "arm64", libc: null, glibcVersion: null })).toEqual({
      platform: "darwin-arm64",
      official: true,
    });
    expect(nodeBuildFor({ os: "linux", arch: "x64", libc: "glibc", glibcVersion: "2.28" })).toEqual(
      {
        platform: "linux-x64",
        official: true,
      },
    );
  });

  test("uses the glibc 2.17 build on old x64 systems", () => {
    expect(nodeBuildFor({ os: "linux", arch: "x64", libc: "glibc", glibcVersion: "2.17" })).toEqual(
      {
        platform: "linux-x64-glibc-217",
        official: false,
      },
    );
  });

  test("refuses macOS older than Node.js 24 supports", () => {
    expect(() =>
      nodeBuildFor({
        os: "darwin",
        arch: "arm64",
        libc: null,
        glibcVersion: null,
        macosVersion: "12.7.6",
      }),
    ).toThrow(/needs macOS 13.5 or newer/u);
    expect(
      nodeBuildFor({
        os: "darwin",
        arch: "arm64",
        libc: null,
        glibcVersion: null,
        macosVersion: "13.5",
      }),
    ).toEqual({ platform: "darwin-arm64", official: true });
  });

  test("refuses musl and old arm64", () => {
    expect(() =>
      nodeBuildFor({ os: "linux", arch: "x64", libc: "musl", glibcVersion: null }),
    ).toThrow(UnsupportedPlatformError);
    expect(() =>
      nodeBuildFor({ os: "linux", arch: "arm64", libc: "glibc", glibcVersion: "2.27" }),
    ).toThrow(/glibc 2.28/u);
  });
});

test("releaseFromShasums picks the .tar.gz for the exact platform", () => {
  expect(releaseFromShasums(SHASUMS, "linux-x64", "https://nodejs.org/dist")).toEqual({
    version: "v22.23.4",
    url: "https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-x64.tar.gz",
    sha256: "b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406",
    directory: "node-v22.23.4-linux-x64",
  });
  expect(releaseFromShasums(SHASUMS, "linux-x64-glibc-217", "https://x")).toBeNull();
});

test("newestVersionInIndex compares versions numerically", () => {
  const index = [
    { version: "v23.0.0", files: ["linux-x64-glibc-217"] },
    { version: "v22.9.0", files: ["linux-x64-glibc-217"] },
    { version: "v22.10.0", files: ["linux-x64-glibc-217"] },
    { version: "v22.11.0", files: ["linux-x64-musl"] },
  ];
  expect(newestVersionInIndex(index, 22, "linux-x64-glibc-217")).toBe("v22.10.0");
});

test("resolveNodeRelease reads the unofficial index for old glibc", async () => {
  const requested: string[] = [];
  const release = await resolveNodeRelease(
    { os: "linux", arch: "x64", libc: "glibc", glibcVersion: "2.17" },
    async (url) => {
      requested.push(url);
      if (url.endsWith("index.json")) {
        return JSON.stringify([{ version: "v22.23.4", files: ["linux-x64-glibc-217"] }]);
      }
      return "abababababababababababababababababababababababababababababababab  node-v22.23.4-linux-x64-glibc-217.tar.gz";
    },
    22,
  );
  expect(requested).toEqual([
    "https://unofficial-builds.nodejs.org/download/release/index.json",
    "https://unofficial-builds.nodejs.org/download/release/v22.23.4/SHASUMS256.txt",
  ]);
  expect(release.directory).toBe("node-v22.23.4-linux-x64-glibc-217");
});
