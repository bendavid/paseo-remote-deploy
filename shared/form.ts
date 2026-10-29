import type { ConnectVia, DeployRequest, ServiceMode } from "./rpc";

/** What the deploy form edits: text exactly as typed, plus the two selects. */
export interface DeployForm {
  destination: string;
  sshPort: string;
  label: string;
  connectVia: ConnectVia;
  paseoHome: string;
  installDir: string;
  daemonPort: string;
  paseoVersion: string;
  service: ServiceMode;
  /** Relay fields; only read when connectVia is relay. Empty relayEndpoint means Paseo's relay. */
  relayEndpoint: string;
  relayTls: boolean;
  relayPublicEndpoint: string;
  relayPublicTls: boolean;
}

export type DeployFormField = keyof DeployForm;

export const emptyDeployForm: DeployForm = {
  destination: "",
  sshPort: "",
  label: "",
  connectVia: "ssh",
  paseoHome: "",
  installDir: "",
  daemonPort: "",
  paseoVersion: "",
  service: "auto",
  relayEndpoint: "",
  relayTls: true,
  relayPublicEndpoint: "",
  relayPublicTls: true,
};

export type ParsedDeployForm =
  | { ok: true; request: DeployRequest }
  | { ok: false; errors: Partial<Record<DeployFormField, string>> };

export interface SshDestination {
  user: string | null;
  host: string;
  /** What `ssh` receives as its destination argument. */
  destination: string;
  port: number | null;
}

/**
 * Accepts `[user@]host`, `[user@][v6]`, an ~/.ssh/config alias, or `ssh://[user@]host[:port]`.
 * Paseo's own SSH link passes the host straight to `ssh`, so the same rules apply: no whitespace
 * and no leading `-`, which `ssh` would read as an option.
 */
export function parseSshDestination(input: string): SshDestination | string {
  const value = input.trim();
  if (!value) return "Enter a destination, such as user@host.";
  if (value.startsWith("ssh://")) return parseSshUri(value);
  if (/[\s\0]/u.test(value)) return "The destination cannot contain spaces.";
  const at = value.lastIndexOf("@");
  const user = at >= 0 ? value.slice(0, at) : null;
  const host = at >= 0 ? value.slice(at + 1) : value;
  if (user !== null && !user) return "Enter a user name before @.";
  if (!host) return "Enter a host after @.";
  if (value.startsWith("-") || host.startsWith("-")) return "The destination cannot start with -.";
  if (host.startsWith("[") !== host.endsWith("]")) return "Close the IPv6 address with ].";
  return { user, host, destination: value, port: null };
}

// React Native's URL has no hostname or port, so this runs on a regular expression.
function parseSshUri(value: string): SshDestination | string {
  const match = /^ssh:\/\/(?:([^@/?#\s]+)@)?(\[[^\]\s]+\]|[^:/?#\s]+)(?::(\d+))?\/?$/u.exec(value);
  if (!match) return "Use ssh://user@host or ssh://user@host:port, without a path or options.";
  const [, rawUser, host = "", port] = match;
  let user: string | null = null;
  try {
    user = rawUser ? decodeURIComponent(rawUser) : null;
  } catch {
    return "The user name in that ssh:// address is not valid.";
  }
  if (port && (Number(port) < 1 || Number(port) > 65535))
    return "SSH port must be between 1 and 65535.";
  if (user?.includes(":")) return "Leave the password out of the address; you are asked for it.";
  const parsed = parseSshDestination(user ? `${user}@${host}` : host);
  if (typeof parsed === "string") return parsed;
  return { ...parsed, port: port ? Number(port) : null };
}

function parsePort(text: string, label: string): number | null | string {
  const value = text.trim();
  if (!value) return null;
  if (!/^\d+$/u.test(value)) return `${label} must be a number.`;
  const port = Number(value);
  if (port < 1 || port > 65535) return `${label} must be between 1 and 65535.`;
  return port;
}

/** Remote paths travel inside shell scripts and line-based output, so they stay on one line. */
function parseRemotePath(text: string): string | null | { error: string } {
  const value = text.trim();
  if (!value) return null;
  if (/[\0\r\n]/u.test(value)) return { error: "The path must be on one line." };
  return value;
}

/** `host:port`, `[v6]:port` or `v4:port`, as Paseo's relay settings expect. */
export function parseRelayEndpoint(text: string): string | null | { error: string } {
  const value = text.trim();
  if (!value) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
    return { error: "Enter host:port, without wss:// or https://. TLS is a separate switch." };
  }
  const match = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):(\d+)$/u.exec(value);
  if (!match) return { error: "Enter the relay as host:port, for example relay.example.com:443." };
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return { error: "The relay port must be between 1 and 65535." };
  return value;
}

export function parseDeployForm(form: DeployForm): ParsedDeployForm {
  const errors: Partial<Record<DeployFormField, string>> = {};
  const destination = parseSshDestination(form.destination);
  if (typeof destination === "string") errors.destination = destination;

  const sshPort = parsePort(form.sshPort, "SSH port");
  if (typeof sshPort === "string") errors.sshPort = sshPort;
  if (
    typeof destination !== "string" &&
    destination.port !== null &&
    typeof sshPort === "number" &&
    sshPort !== destination.port
  ) {
    errors.sshPort = "The destination already names a different port.";
  }

  const daemonPort = parsePort(form.daemonPort, "Daemon port");
  if (typeof daemonPort === "string") errors.daemonPort = daemonPort;

  const paseoHome = parseRemotePath(form.paseoHome);
  if (paseoHome && typeof paseoHome === "object") errors.paseoHome = paseoHome.error;
  const installDir = parseRemotePath(form.installDir);
  if (installDir && typeof installDir === "object") errors.installDir = installDir.error;

  const paseoVersion = form.paseoVersion.trim();
  if (paseoVersion && !/^[0-9A-Za-z.+\-^~<>=*|x ]+$/u.test(paseoVersion)) {
    errors.paseoVersion = "Use an npm version, range, or tag such as latest or 0.13.0.";
  }

  // Relay fields are hidden, and ignored, unless the host is added through the relay.
  let relay: DeployRequest["relay"] = null;
  if (form.connectVia === "relay") {
    const endpoint = parseRelayEndpoint(form.relayEndpoint);
    const publicEndpoint = parseRelayEndpoint(form.relayPublicEndpoint);
    if (endpoint && typeof endpoint === "object") errors.relayEndpoint = endpoint.error;
    if (publicEndpoint && typeof publicEndpoint === "object") {
      errors.relayPublicEndpoint = publicEndpoint.error;
    }
    if (endpoint === null && typeof publicEndpoint === "string") {
      errors.relayPublicEndpoint = "Enter the relay address first.";
    }
    if (typeof endpoint === "string") {
      relay = {
        endpoint,
        useTls: form.relayTls,
        publicEndpoint: typeof publicEndpoint === "string" ? publicEndpoint : null,
        publicUseTls: typeof publicEndpoint === "string" ? form.relayPublicTls : form.relayTls,
      };
    }
  }

  if (Object.keys(errors).length > 0 || typeof destination === "string") {
    return { ok: false, errors };
  }
  return {
    ok: true,
    request: {
      destination:
        destination.port === null ? destination.destination : destinationWithoutPort(destination),
      sshPort: destination.port ?? (typeof sshPort === "number" ? sshPort : null),
      connectVia: form.connectVia,
      label: form.label.trim() || null,
      paseoHome: typeof paseoHome === "string" ? paseoHome : null,
      installDir: typeof installDir === "string" ? installDir : null,
      daemonPort: typeof daemonPort === "number" ? daemonPort : null,
      paseoVersion: paseoVersion || null,
      service: form.service,
      relay,
    },
  };
}

function destinationWithoutPort(destination: SshDestination): string {
  return destination.user ? `${destination.user}@${destination.host}` : destination.host;
}

/** The host part of a destination, without user or IPv6 brackets: the default label. */
export function defaultLabel(destination: string): string {
  const parsed = parseSshDestination(destination);
  if (typeof parsed === "string") return destination;
  return parsed.host.replace(/^\[(.*)\]$/u, "$1");
}
