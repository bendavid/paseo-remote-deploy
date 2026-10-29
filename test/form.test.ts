import { describe, expect, test } from "vitest";
import {
  defaultLabel,
  emptyDeployForm,
  parseDeployForm,
  parseSshDestination,
} from "../shared/form";

describe("parseSshDestination", () => {
  test.each([
    ["build-box", { user: null, host: "build-box", destination: "build-box", port: null }],
    [
      "deploy@10.0.0.5",
      { user: "deploy", host: "10.0.0.5", destination: "deploy@10.0.0.5", port: null },
    ],
    ["me@[fe80::1]", { user: "me", host: "[fe80::1]", destination: "me@[fe80::1]", port: null }],
    [
      "ssh://deploy@build-box:2222",
      { user: "deploy", host: "build-box", destination: "deploy@build-box", port: 2222 },
    ],
    ["ssh://%40odd@box/", { user: "@odd", host: "box", destination: "@odd@box", port: null }],
  ])("accepts %s", (input, expected) => {
    expect(parseSshDestination(input)).toEqual(expected);
  });

  test.each([
    ["", "Enter a destination"],
    ["-oProxyCommand=evil", "cannot start with -"],
    ["user@-host", "cannot start with -"],
    ["two words", "cannot contain spaces"],
    ["@host", "user name before @"],
    ["user@", "host after @"],
    ["me@[fe80::1", "Close the IPv6"],
    ["ssh://user@host/path", "without a path"],
    ["ssh://user:secret@host", "Leave the password out"],
    ["ssh://host:70000", "between 1 and 65535"],
  ])("rejects %j", (input, message) => {
    const result = parseSshDestination(input);
    expect(typeof result).toBe("string");
    expect(result).toContain(message);
  });
});

describe("parseDeployForm", () => {
  test("turns empty optional fields into null and keeps the selects", () => {
    const parsed = parseDeployForm({
      ...emptyDeployForm,
      destination: " dev@box ",
      connectVia: "relay",
    });
    expect(parsed).toEqual({
      ok: true,
      request: {
        destination: "dev@box",
        sshPort: null,
        connectVia: "relay",
        label: null,
        paseoHome: null,
        installDir: null,
        daemonPort: null,
        paseoVersion: null,
        service: "auto",
        relay: null,
      },
    });
  });

  test("takes the SSH port from an ssh:// destination", () => {
    const parsed = parseDeployForm({ ...emptyDeployForm, destination: "ssh://dev@box:2222" });
    expect(parsed.ok && parsed.request).toMatchObject({ destination: "dev@box", sshPort: 2222 });
  });

  test("reports every invalid field", () => {
    const parsed = parseDeployForm({
      ...emptyDeployForm,
      destination: "ssh://dev@box:2222",
      sshPort: "22",
      daemonPort: "0",
      paseoHome: "~/one\ntwo",
      paseoVersion: "$(rm -rf ~)",
    });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && Object.keys(parsed.errors).sort()).toEqual([
      "daemonPort",
      "paseoHome",
      "paseoVersion",
      "sshPort",
    ]);
  });
});

test("defaultLabel drops the user and IPv6 brackets", () => {
  expect(defaultLabel("dev@build-box")).toBe("build-box");
  expect(defaultLabel("me@[fe80::1]")).toBe("fe80::1");
});

describe("relay settings", () => {
  const relayForm = { ...emptyDeployForm, destination: "dev@box", connectVia: "relay" as const };

  test("are ignored, even when invalid, unless the host is added through the relay", () => {
    const parsed = parseDeployForm({
      ...relayForm,
      connectVia: "ssh",
      relayEndpoint: "wss://nope",
    });
    expect(parsed.ok && parsed.request.relay).toBeNull();
  });

  test("an empty relay address means Paseo's relay", () => {
    const parsed = parseDeployForm(relayForm);
    expect(parsed.ok && parsed.request.relay).toBeNull();
  });

  test("a relay address with TLS, and the public address defaulting to it", () => {
    const parsed = parseDeployForm({ ...relayForm, relayEndpoint: " relay.example.com:443 " });
    expect(parsed.ok && parsed.request.relay).toEqual({
      endpoint: "relay.example.com:443",
      useTls: true,
      publicEndpoint: null,
      publicUseTls: true,
    });
  });

  test("a separate public address with its own TLS setting", () => {
    const parsed = parseDeployForm({
      ...relayForm,
      relayEndpoint: "10.0.0.5:4000",
      relayTls: false,
      relayPublicEndpoint: "[2001:db8::5]:443",
      relayPublicTls: true,
    });
    expect(parsed.ok && parsed.request.relay).toEqual({
      endpoint: "10.0.0.5:4000",
      useTls: false,
      publicEndpoint: "[2001:db8::5]:443",
      publicUseTls: true,
    });
  });

  test.each([
    [{ relayEndpoint: "wss://relay.example.com" }, "relayEndpoint", "without wss://"],
    [{ relayEndpoint: "relay.example.com" }, "relayEndpoint", "host:port"],
    [{ relayEndpoint: "relay.example.com:70000" }, "relayEndpoint", "between 1 and 65535"],
    [
      { relayPublicEndpoint: "relay.example.com:443" },
      "relayPublicEndpoint",
      "relay address first",
    ],
  ] as const)("rejects %j", (fields, field, message) => {
    const parsed = parseDeployForm({ ...relayForm, ...fields });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.errors[field]).toContain(message);
  });
});
