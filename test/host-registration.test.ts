import { describe, expect, test } from "vitest";
import {
  deploymentKey,
  isFromThisPlugin,
  planRegistration,
  type Registration,
} from "../server/host-registration";

const ID = "0123456789abcdef";
const LEGACY = "deploy:lxplus9108.cern.ch:22:/afs/cern.ch/user/b/bendavid/.paseo";
const SERVER = "srv_tAbKKdNA3E43";

function host(
  registrationId: string,
  fields: { key?: string; serverId?: string | null; metadata?: Record<string, unknown> },
): Registration {
  return {
    registrationId,
    serverId: fields.serverId ?? null,
    source: { id: "plugin:remote-deploy", key: fields.key ?? "" },
    metadata: fields.metadata ?? {},
  };
}
const ours = { "remote-deploy.paseoHome": "/afs/cern.ch/user/b/bendavid/.paseo" };
const plan = (hosts: Registration[], serverId: string | null = SERVER) =>
  planRegistration({ hosts, deploymentId: ID, legacyKey: LEGACY, serverId });

describe("planRegistration", () => {
  test("a new deployment adds a registration keyed by its ID", () => {
    expect(deploymentKey(ID)).toBe(`deployment:${ID}`);
    expect(plan([], null)).toEqual({ update: null, removeOwn: [], conflicts: [] });
  });

  test("finds its registration by key or ID, whatever the machine was called", () => {
    const keyed = host("a", { key: deploymentKey(ID), metadata: ours });
    expect(plan([keyed]).update).toBe(keyed);
    const tagged = host("b", {
      key: "other",
      metadata: { ...ours, "remote-deploy.deployment": ID },
    });
    expect(plan([tagged], null).update).toBe(tagged);
  });

  test("adopts registrations from before deployment IDs, keeping one and removing the rest", () => {
    // As on lxplus: saved through the alias first, then through the node's own name.
    const alias = host("alias", {
      key: "deploy:lxplus.cern.ch:22:/afs/cern.ch/user/b/bendavid/.paseo",
      serverId: SERVER,
      metadata: ours,
    });
    const named = host("named", { key: LEGACY, serverId: SERVER, metadata: ours });
    const result = plan([alias, named]);
    expect(result.update).toBe(named);
    expect(result.removeOwn).toEqual([alias]);
    expect(result.conflicts).toEqual([]);
  });

  test("a registration for the same daemon made elsewhere is a conflict, never adopted", () => {
    const manual: Registration = {
      registrationId: "manual",
      serverId: SERVER,
      source: { id: "manual", key: "" },
      metadata: {},
    };
    expect(isFromThisPlugin(manual)).toBe(false);
    const result = plan([manual]);
    expect(result).toEqual({ update: null, removeOwn: [], conflicts: [manual] });
    // Unknown until the daemon has run once: nothing to compare.
    expect(plan([manual], null).conflicts).toEqual([]);
  });

  test("this plugin's registrations for other daemons are left alone", () => {
    const other = host("other", {
      key: "deployment:ffffffffffffffff",
      serverId: "srv_other",
      metadata: ours,
    });
    expect(plan([other])).toEqual({ update: null, removeOwn: [], conflicts: [] });
  });
});
