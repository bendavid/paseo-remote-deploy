import { z } from "zod";

/**
 * The Node.js major every deploy installs, pinned deliberately: Paseo declares no engines.node.
 * Paseo's CI and Docker image use 22 and its desktop app runs on Electron's Node 24; 24 is
 * supported until 2028-04-30, against 22's 2027-04-30. Redeploys move installs to this major.
 */
export const NODE_MAJOR = 24;

const OFFICIAL = "https://nodejs.org/dist";
const UNOFFICIAL = "https://unofficial-builds.nodejs.org/download/release";

/** Official Linux builds of Node.js 18 and later need glibc 2.28. */
const OFFICIAL_MIN_GLIBC: readonly [number, number] = [2, 28];

/** Node.js 24 supports macOS 13.5 and later (22 supported 11.0); see its BUILDING.md. */
const MIN_MACOS: readonly [number, number] = [13, 5];

export interface RemotePlatform {
  os: "linux" | "darwin";
  arch: "x64" | "arm64";
  libc: "glibc" | "musl" | null;
  /** `2.31`, or null when unknown or not Linux. */
  glibcVersion: string | null;
  /** `14.6.1`, or null when unknown or not macOS. */
  macosVersion?: string | null;
}

export interface NodeBuild {
  /** `linux-x64`, or `linux-x64-glibc-217` for the unofficial build for old glibc. */
  platform: string;
  official: boolean;
}

export interface NodeRelease {
  version: string;
  url: string;
  sha256: string;
  /** The archive's top-level directory, which also becomes the npm prefix. */
  directory: string;
}

export class UnsupportedPlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedPlatformError";
  }
}

function versionAtLeast(version: string, minimum: readonly [number, number]): boolean {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  return major > minimum[0] || (major === minimum[0] && minor >= minimum[1]);
}

/**
 * Paseo's native modules (node-pty, sherpa-onnx) ship glibc and macOS prebuilds only, so musl
 * would need a compiler on the remote machine.
 */
export function nodeBuildFor(platform: RemotePlatform): NodeBuild {
  if (platform.os === "darwin") {
    if (platform.macosVersion && !versionAtLeast(platform.macosVersion, MIN_MACOS)) {
      throw new UnsupportedPlatformError(
        `This Mac runs macOS ${platform.macosVersion}. Node.js ${NODE_MAJOR} needs macOS ${MIN_MACOS.join(".")} or newer.`,
      );
    }
    return { platform: `darwin-${platform.arch}`, official: true };
  }
  if (platform.libc === "musl") {
    throw new UnsupportedPlatformError(
      "This machine uses musl libc (for example Alpine). Paseo's native modules need glibc.",
    );
  }
  if (platform.glibcVersion === null || versionAtLeast(platform.glibcVersion, OFFICIAL_MIN_GLIBC)) {
    return { platform: `linux-${platform.arch}`, official: true };
  }
  if (platform.arch === "x64") return { platform: "linux-x64-glibc-217", official: false };
  throw new UnsupportedPlatformError(
    `This machine has glibc ${platform.glibcVersion}. Node.js ${NODE_MAJOR} for arm64 needs glibc 2.28 or newer.`,
  );
}

/** Finds `node-v<version>-<platform>.tar.gz` in a SHASUMS256.txt listing. */
export function releaseFromShasums(
  shasums: string,
  platform: string,
  baseUrl: string,
): NodeRelease | null {
  for (const line of shasums.split("\n")) {
    const match = /^([0-9a-f]{64})\s+(node-(v\d+\.\d+\.\d+)-(.+)\.tar\.gz)$/u.exec(line.trim());
    if (!match || match[4] !== platform) continue;
    const [, sha256, file, version] = match as unknown as [string, string, string, string];
    return {
      version,
      url: `${baseUrl}/${version}/${file}`,
      sha256,
      directory: file.slice(0, -".tar.gz".length),
    };
  }
  return null;
}

const indexEntrySchema = z.object({
  version: z.string(),
  files: z.array(z.string()),
});

/** The newest `v<major>.x` release in a Node.js index.json that has a build for `platform`. */
export function newestVersionInIndex(
  index: unknown,
  major: number,
  platform: string,
): string | null {
  if (!Array.isArray(index)) return null;
  let newest: { version: string; parts: number[] } | null = null;
  for (const raw of index) {
    const parsed = indexEntrySchema.safeParse(raw);
    if (!parsed.success || !parsed.data.files.includes(platform)) continue;
    const entry = parsed.data;
    const match = /^v(\d+)\.(\d+)\.(\d+)$/u.exec(entry.version);
    if (!match || Number(match[1]) !== major) continue;
    const parts = match.slice(1).map(Number);
    if (!newest || compareParts(parts, newest.parts) > 0)
      newest = { version: entry.version, parts };
  }
  return newest?.version ?? null;
}

function compareParts(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export type FetchText = (url: string) => Promise<string>;

export const fetchText: FetchText = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.text();
};

/**
 * Resolves the newest build of a Node.js major (NODE_MAJOR by default) for the remote machine.
 * The remote downloads the archive itself and checks it against the SHA-256 found here.
 */
export async function resolveNodeRelease(
  platform: RemotePlatform,
  fetch: FetchText = fetchText,
  major: number = NODE_MAJOR,
): Promise<NodeRelease> {
  const build = nodeBuildFor(platform);
  if (build.official) {
    const shasums = await fetch(`${OFFICIAL}/latest-v${major}.x/SHASUMS256.txt`);
    const release = releaseFromShasums(shasums, build.platform, OFFICIAL);
    if (!release)
      throw new Error(`nodejs.org lists no Node.js ${major} build for ${build.platform}`);
    return release;
  }
  const index: unknown = JSON.parse(await fetch(`${UNOFFICIAL}/index.json`));
  const version = newestVersionInIndex(index, major, build.platform);
  if (!version) {
    throw new Error(
      `unofficial-builds.nodejs.org lists no Node.js ${major} build for ${build.platform}`,
    );
  }
  const release = releaseFromShasums(
    await fetch(`${UNOFFICIAL}/${version}/SHASUMS256.txt`),
    build.platform,
    UNOFFICIAL,
  );
  if (!release)
    throw new Error(`No checksum for the ${build.platform} build of Node.js ${version}`);
  return release;
}
