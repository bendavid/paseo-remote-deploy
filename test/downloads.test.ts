import { expect, test } from "vitest";
import { describeDownloads } from "../server/deploy";
import type { NodeRelease } from "../server/node-release";
import { planNodeVersion, planPaseoVersion } from "../server/version-plan";

const inspection = { installDir: "/home/dev/.local/share/paseo", hostname: "build-box" };
const release: NodeRelease = {
  version: "v24.22.2",
  url: "https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.gz",
  sha256: "0".repeat(64),
  directory: "node-v24.22.2-linux-x64",
};
const fresh = planPaseoVersion({
  installed: null,
  requested: null,
  resolved: null,
  relation: null,
});
const same = planPaseoVersion({
  installed: "0.13.2",
  requested: null,
  resolved: "0.13.2",
  relation: "same",
});

test("a first deploy lists Node.js and Paseo with their sources", () => {
  expect(
    describeDownloads(
      inspection,
      release,
      planNodeVersion({ installed: null, target: "v24.22.2" }),
      fresh,
    ),
  ).toBe(
    [
      "This deploy downloads and installs into /home/dev/.local/share/paseo on build-box:",
      "• Node.js v24.22.2 from nodejs.org, checked against its published SHA-256",
      "• @getpaseo/cli@latest and its dependencies from the npm registry configured for your account there",
      "Cancelling leaves that machine as it is.",
    ].join("\n"),
  );
});

test("a new Node.js also fetches Paseo again, at the same version", () => {
  const text = describeDownloads(
    inspection,
    release,
    planNodeVersion({ installed: "v22.23.4", target: "v24.22.2" }),
    same,
  );
  expect(text).toContain("• Node.js v24.22.2 from nodejs.org");
  expect(text).toContain("• @getpaseo/cli@0.13.2 and its dependencies");
});

test("nothing to download means no question", () => {
  expect(
    describeDownloads(
      inspection,
      release,
      planNodeVersion({ installed: "v24.22.2", target: "v24.22.2" }),
      same,
    ),
  ).toBeNull();
});
