import { describe, expect, test } from "vitest";
import { planIdentity } from "../server/deployment-identity";

const HERE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const THERE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ID = "0123456789abcdef";
const base = {
  machineId: HERE,
  machineIdTransient: false,
  units: [],
  newId: () => ID,
};

describe("planIdentity", () => {
  test("a first deploy gets a new ID and is pinned to a machine ID that persists", () => {
    expect(planIdentity({ ...base, previous: null })).toEqual({
      id: ID,
      unit: `paseo-remote-deploy-${ID}.service`,
      pinnedMachine: HERE,
      movedFrom: null,
      retire: [],
      unpinned: [],
    });
  });

  test("a redeploy reuses the home's ID", () => {
    const plan = planIdentity({
      ...base,
      previous: { id: "fedcba9876543210", machineId: HERE },
      newId: () => "unused0000000000",
    });
    expect(plan.unit).toBe("paseo-remote-deploy-fedcba9876543210.service");
    expect(plan.movedFrom).toBeNull();
  });

  test("a transient or missing machine ID pins nothing", () => {
    expect(planIdentity({ ...base, machineIdTransient: true, previous: null }).pinnedMachine).toBe(
      null,
    );
    expect(planIdentity({ ...base, machineId: null, previous: null }).pinnedMachine).toBe(null);
  });

  test("retires this home's units here, its recorded legacy unit, and leaves the rest", () => {
    const plan = planIdentity({
      ...base,
      previous: { unit: "paseo-daemon.service" },
      units: [
        { name: "paseo-daemon.service", home: "/h", machineId: null, sameHome: true },
        {
          name: "paseo-remote-deploy-1111111111111111.service",
          home: "/h",
          machineId: HERE,
          sameHome: true,
        },
        {
          name: "paseo-remote-deploy-2222222222222222.service",
          home: "/h",
          machineId: THERE,
          sameHome: true,
        },
        {
          name: "paseo-remote-deploy-3333333333333333.service",
          home: "/other",
          machineId: HERE,
          sameHome: false,
        },
        { name: "paseo-daemon-abcd1234.service", home: "/h", machineId: null, sameHome: true },
      ],
    });
    expect(plan.retire).toEqual([
      "paseo-daemon.service",
      "paseo-remote-deploy-1111111111111111.service",
    ]);
    // Another machine's local home at the same path keeps its unit; an unpinned one is reported.
    expect(plan.unpinned).toEqual(["paseo-daemon-abcd1234.service"]);
  });

  test("a shared home deployed from another machine moves, taking that machine's unit along", () => {
    const plan = planIdentity({
      ...base,
      previous: { id: ID, machineId: THERE, hostname: "lxplus9108.cern.ch" },
      units: [
        { name: `paseo-remote-deploy-${ID}.service`, home: "/h", machineId: THERE, sameHome: true },
        {
          name: "paseo-remote-deploy-2222222222222222.service",
          home: "/h",
          machineId: THERE,
          sameHome: true,
        },
      ],
    });
    expect(plan.movedFrom).toEqual({ machineId: THERE, hostname: "lxplus9108.cern.ch" });
    // The deployment's own unit is rewritten with this machine's ID rather than removed.
    expect(plan.retire).toEqual(["paseo-remote-deploy-2222222222222222.service"]);
  });
});
