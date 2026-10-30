import { describe, expect, test } from "vitest";
import {
  confirmsWorktreesRoot,
  describeWorktreesChange,
  planWorktreesRoot,
  resolveWorktreesRoot,
} from "../server/worktrees-root";

const HOME = "/home/dev";
const PASEO_HOME = "/home/dev/.paseo";
const base = { homeDirectory: HOME, paseoHome: PASEO_HOME };

test("resolveWorktreesRoot reads ~ as the home, relative paths inside the Paseo home, empty as the default", () => {
  expect(resolveWorktreesRoot("", HOME, PASEO_HOME)).toBe("/home/dev/.paseo/worktrees");
  expect(resolveWorktreesRoot("~", HOME, PASEO_HOME)).toBe(HOME);
  expect(resolveWorktreesRoot("~/trees/", HOME, PASEO_HOME)).toBe("/home/dev/trees");
  expect(resolveWorktreesRoot("trees", HOME, PASEO_HOME)).toBe("/home/dev/.paseo/trees");
  expect(resolveWorktreesRoot("/srv//trees/../wt", HOME, PASEO_HOME)).toBe("/srv/wt");
});

describe("planWorktreesRoot", () => {
  test("writes the value as entered, and leaves an unchanged setting alone", () => {
    expect(planWorktreesRoot({ ...base, requested: "~/trees", previous: "" })).toEqual({
      setting: "~/trees",
      previous: "",
      action: "set",
      root: "/home/dev/trees",
      from: "/home/dev/.paseo/worktrees",
      moves: true,
    });
    expect(planWorktreesRoot({ ...base, requested: "~/trees", previous: "~/trees" }).action).toBe(
      null,
    );
    expect(planWorktreesRoot({ ...base, requested: null, previous: "" }).action).toBe(null);
  });

  test("an empty field removes an earlier setting, and always asks", () => {
    const plan = planWorktreesRoot({ ...base, requested: null, previous: "/srv/wt" });
    expect(plan).toMatchObject({ action: "unset", setting: "", moves: true });
    expect(confirmsWorktreesRoot(plan, 0)).toBe(true);
    expect(describeWorktreesChange(plan, 0)).toBe(
      "The worktree root setting (/srv/wt) is removed, so new worktrees go in Paseo's default, /home/dev/.paseo/worktrees.",
    );
    // Even when the setting named the default directory.
    const same = planWorktreesRoot({ ...base, requested: null, previous: "worktrees" });
    expect(same).toMatchObject({ action: "unset", moves: false });
    expect(confirmsWorktreesRoot(same, null)).toBe(true);
  });

  test("another spelling of the same directory is written and asked about, but strands nothing", () => {
    const plan = planWorktreesRoot({ ...base, requested: "/home/dev/trees", previous: "~/trees" });
    expect(plan).toMatchObject({ action: "set", moves: false });
    expect(confirmsWorktreesRoot(plan, null)).toBe(true);
    expect(describeWorktreesChange(plan, 4)).toBe(
      "The worktree root changes from ~/trees to /home/dev/trees, which is the same directory, /home/dev/trees.",
    );
  });

  test("moving a root with worktrees in it asks, and says how many stay behind", () => {
    const plan = planWorktreesRoot({ ...base, requested: "/srv/wt", previous: "" });
    expect(confirmsWorktreesRoot(plan, 0)).toBe(false);
    expect(confirmsWorktreesRoot(plan, 1)).toBe(true);
    expect(describeWorktreesChange(plan, 1)).toBe(
      "The worktree root is set to /srv/wt, so new worktrees go in /srv/wt. The 1 worktree already " +
        "in /home/dev/.paseo/worktrees stays there, and Paseo no longer deletes it when its " +
        "workspace is archived.",
    );
    expect(describeWorktreesChange(plan, 3)).toMatch(/The 3 worktrees already in .* stay there/u);
  });

  test("an unreadable config.json leaves the earlier root unknown", () => {
    const plan = planWorktreesRoot({ ...base, requested: "/srv/wt", previous: null });
    expect(plan).toMatchObject({ action: "set", from: null, moves: false });
    expect(confirmsWorktreesRoot(plan, null)).toBe(false);
  });
});
