/** The fields of a saved host that decide whose registration it is. */
export interface Registration {
  registrationId: string;
  serverId: string | null;
  source: { id: string; key: string };
  metadata: Record<string, unknown>;
}

/** The source key of a deployment's registration: the same however its machine is reached. */
export function deploymentKey(id: string): string {
  return `deployment:${id}`;
}

export const DEPLOYMENT_METADATA = "remote-deploy.deployment";

/** Only this plugin writes remote-deploy.* metadata, however its registrations are sourced. */
export function isFromThisPlugin(host: Registration): boolean {
  return Object.keys(host.metadata).some((key) => key.startsWith("remote-deploy."));
}

export interface RegistrationPlan<Host extends Registration> {
  /** This deployment's registration, updated in place; null adds one. */
  update: Host | null;
  /** More of this plugin's registrations for the deployment: removed without asking. */
  removeOwn: Host[];
  /** Registrations for the same daemon made by hand or another tool: removed only if confirmed. */
  conflicts: Host[];
}

/**
 * A registration is this deployment's when this plugin made it and it carries the deployment's
 * key or ID, the key of earlier versions (destination, SSH port and home), or the daemon's server
 * ID, which belongs to one Paseo home. The last two find registrations made before deployment IDs,
 * including ones saved under another name for the same machine, such as a load-balanced alias.
 */
export function planRegistration<Host extends Registration>(input: {
  hosts: readonly Host[];
  deploymentId: string;
  legacyKey: string;
  /** The daemon's server ID: from the home's server-id file before deploying, else null. */
  serverId: string | null;
}): RegistrationPlan<Host> {
  const key = deploymentKey(input.deploymentId);
  const rank = (host: Host): number | null => {
    if (!isFromThisPlugin(host)) return null;
    if (host.source.key === key) return 0;
    if (host.metadata[DEPLOYMENT_METADATA] === input.deploymentId) return 1;
    if (host.source.key === input.legacyKey) return 2;
    if (input.serverId !== null && host.serverId === input.serverId) return 3;
    return null;
  };
  const own = input.hosts
    .map((host) => ({ host, rank: rank(host) }))
    .filter((entry): entry is { host: Host; rank: number } => entry.rank !== null)
    .sort((left, right) => left.rank - right.rank)
    .map((entry) => entry.host);
  const conflicts =
    input.serverId === null
      ? []
      : input.hosts.filter((host) => !own.includes(host) && host.serverId === input.serverId);
  return { update: own[0] ?? null, removeOwn: own.slice(1), conflicts };
}
