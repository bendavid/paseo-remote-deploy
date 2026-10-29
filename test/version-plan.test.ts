import { expect, test } from "vitest";
import {
  describeInstall,
  describeNodeChange,
  describeNodeInstall,
  describeVersionChange,
  planNodeVersion,
  planPaseoVersion,
} from "../server/version-plan";

test("a first install takes what was asked for, or latest", () => {
  expect(
    planPaseoVersion({ installed: null, requested: null, resolved: null, relation: null }),
  ).toEqual({
    change: "fresh",
    target: "latest",
    from: null,
    to: null,
  });
  expect(
    planPaseoVersion({ installed: null, requested: "0.13.0", resolved: null, relation: null })
      .target,
  ).toBe("0.13.0");
});

test("a redeploy upgrades to the resolved release", () => {
  const plan = planPaseoVersion({
    installed: "0.13.0-beta.2",
    requested: null,
    resolved: "0.13.0",
    relation: "newer",
  });
  expect(plan).toEqual({
    change: "upgrade",
    target: "0.13.0",
    from: "0.13.0-beta.2",
    to: "0.13.0",
  });
  expect(describeVersionChange(plan)).toBe("Paseo is upgraded from 0.13.0-beta.2 to 0.13.0.");
  expect(describeInstall(plan, "0.13.0")).toBe("Upgraded Paseo from 0.13.0-beta.2 to 0.13.0.");
});

test("the same version is kept without reinstalling", () => {
  const plan = planPaseoVersion({
    installed: "0.13.0",
    requested: null,
    resolved: "0.13.0",
    relation: "same",
  });
  expect(plan.change).toBe("same");
  expect(plan.target).toBe("0.13.0");
  expect(describeVersionChange(plan)).toBeNull();
});

test("only an explicitly requested lower version downgrades, with the data warning", () => {
  const plan = planPaseoVersion({
    installed: "0.13.0",
    requested: "0.12.0",
    resolved: "0.12.0",
    relation: "older",
  });
  expect(plan).toMatchObject({ change: "downgrade", target: "0.12.0" });
  expect(describeVersionChange(plan)).toMatch(
    /downgrades Paseo from 0.13.0 to 0.12.0\. .*no migrations/u,
  );
});

test("an install newer than latest stays when no version was asked for", () => {
  const plan = planPaseoVersion({
    installed: "0.14.0-beta.1",
    requested: null,
    resolved: "0.13.0",
    relation: "older",
  });
  expect(plan).toEqual({
    change: "keep-newer",
    target: "0.14.0-beta.1",
    from: "0.14.0-beta.1",
    to: "0.13.0",
  });
  expect(describeVersionChange(plan)).toMatch(
    /stays installed: it is newer than the latest release, 0.13.0/u,
  );
});

test("Node.js moves to the newest release of the pinned major", () => {
  expect(planNodeVersion({ installed: null, target: "v24.22.2" })).toEqual({
    change: "fresh",
    from: null,
    to: "v24.22.2",
  });
  expect(planNodeVersion({ installed: "v24.22.2", target: "v24.22.2" }).change).toBe("same");
  const patch = planNodeVersion({ installed: "v24.9.0", target: "v24.22.2" });
  expect(patch.change).toBe("upgrade");
  const major = planNodeVersion({ installed: "v22.23.4", target: "v24.22.2" });
  expect(major).toEqual({ change: "upgrade", from: "v22.23.4", to: "v24.22.2" });
  expect(describeNodeChange(major)).toBe(
    "Node.js is upgraded from v22.23.4 to v24.22.2, and Paseo reinstalled for it.",
  );
  expect(describeNodeInstall(major, "node-v24.22.2-linux-x64")).toBe(
    "Upgraded Node.js from v22.23.4 to v24.22.2 (node-v24.22.2-linux-x64).",
  );
});

test("anything newer than the pinned release downgrades with a note, a later patch included", () => {
  const major = planNodeVersion({ installed: "v26.13.0", target: "v24.22.2" });
  expect(major.change).toBe("downgrade");
  expect(describeNodeChange(major)).toMatch(
    /downgrades Node.js from v26.13.0 to v24.22.2\. .*native modules/u,
  );
  const patch = planNodeVersion({ installed: "v24.23.0", target: "v24.22.2" });
  expect(patch).toEqual({ change: "downgrade", from: "v24.23.0", to: "v24.22.2" });
  expect(describeNodeChange(patch)).toMatch(/downgrades Node.js from v24.23.0 to v24.22.2\./u);
});
