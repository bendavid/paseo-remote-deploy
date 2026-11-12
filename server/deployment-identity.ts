import {
  DEPLOYMENT_ID,
  MACHINE_ID,
  deploymentUnit,
  type DeploymentRecord,
  type UnitFacts,
} from "./remote-files";

export interface IdentityPlan {
  /** Kept in remote-deploy.json; a redeploy of the same home reuses it. */
  id: string;
  unit: string;
  /** The unit's ConditionHost=, or null when this machine has no ID that survives a reboot. */
  pinnedMachine: string | null;
  /** The machine a shared home was deployed from before, when that was another machine. */
  movedFrom: { machineId: string; hostname: string | null } | null;
  /** Other units of this plugin that run this home on this machine: stopped and removed. */
  retire: string[];
  /** Units that run this home on every machine sharing the unit directory: left alone. */
  unpinned: string[];
}

/**
 * One home has one deployment ID, generated at its first deploy and kept in the home's record, so
 * every way of writing the home's path reaches the same unit. A unit belongs to this deployment
 * when it runs this home (by real path) and either is pinned to this machine, is pinned to the
 * machine the home moves away from, or is the unpinned unit an earlier version recorded.
 */
export function planIdentity(input: {
  previous: Partial<DeploymentRecord> | null;
  machineId: string | null;
  machineIdTransient: boolean;
  /** This plugin's units in the unit directory, with whether each runs this home. */
  units: readonly (UnitFacts & { sameHome: boolean })[];
  newId: () => string;
}): IdentityPlan {
  const previousId =
    typeof input.previous?.id === "string" && DEPLOYMENT_ID.test(input.previous.id)
      ? input.previous.id
      : null;
  const id = previousId ?? input.newId();
  const unit = deploymentUnit(id);
  const pinnedMachine =
    input.machineId && MACHINE_ID.test(input.machineId) && !input.machineIdTransient
      ? input.machineId
      : null;
  const previousMachine =
    typeof input.previous?.machineId === "string" && MACHINE_ID.test(input.previous.machineId)
      ? input.previous.machineId
      : null;
  const movedFrom =
    pinnedMachine && previousMachine && previousMachine !== pinnedMachine
      ? {
          machineId: previousMachine,
          hostname: typeof input.previous?.hostname === "string" ? input.previous.hostname : null,
        }
      : null;
  const retire: string[] = [];
  const unpinned: string[] = [];
  for (const candidate of input.units) {
    if (candidate.name === unit || !candidate.sameHome) continue;
    if (
      (pinnedMachine !== null && candidate.machineId === pinnedMachine) ||
      (movedFrom !== null && candidate.machineId === movedFrom.machineId) ||
      (candidate.machineId === null && candidate.name === input.previous?.unit)
    ) {
      retire.push(candidate.name);
    } else if (candidate.machineId === null) {
      unpinned.push(candidate.name);
    }
  }
  return { id, unit, pinnedMachine, movedFrom, retire, unpinned };
}
