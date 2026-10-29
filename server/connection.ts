import { createHash } from "node:crypto";
import { parseSshDestination } from "../shared/form";

/** The saved-host connection Paseo opens through `ssh -W 127.0.0.1:<daemonPort>`. */
export function sshConnection(input: {
  destination: string;
  sshPort: number | null;
  daemonPort: number;
  password: string;
}): string {
  const parsed = parseSshDestination(input.destination);
  if (typeof parsed === "string") throw new Error(parsed);
  const user = parsed.user ? `${encodeURIComponent(parsed.user)}@` : "";
  const host =
    parsed.host.includes(":") && !parsed.host.startsWith("[") ? `[${parsed.host}]` : parsed.host;
  const port = input.sshPort ? `:${input.sshPort}` : "";
  const query = new URLSearchParams({
    daemonPort: String(input.daemonPort),
    password: input.password,
  });
  return `ssh://${user}${host}${port}?${query.toString()}`;
}

/** Adds the daemon password to the `relay://` URI that `paseo daemon pair --json` prints. */
export function relayConnection(connectionUri: string, password: string): string {
  const url = new URL(connectionUri);
  if (url.protocol !== "relay:") throw new Error("The pairing offer is not a relay:// URI");
  url.searchParams.set("password", password);
  return url.toString();
}

/**
 * Identifies one deployment among the hosts this plugin saved, so redeploying the same remote
 * home updates its registration instead of adding a second one.
 */
export function deploymentSourceKey(input: {
  destination: string;
  sshPort: number | null;
  paseoHome: string;
}): string {
  const key = `deploy:${input.destination}:${input.sshPort ?? 22}:${input.paseoHome}`;
  if (key.length <= 256) return key;
  return `deploy:${createHash("sha256").update(key).digest("hex")}`;
}
