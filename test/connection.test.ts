import { parseHostTarget } from "@getpaseo/protocol/host-target";
import { describe, expect, test } from "vitest";
import { parseRelayConnectionUri } from "@getpaseo/protocol/daemon-endpoints";
import {
  deploymentSourceKey,
  pairingLink,
  relayConnection,
  sshConnection,
} from "../server/connection";

describe("sshConnection", () => {
  // Paseo's own parser is the contract: the saved connection must round-trip through it.
  test("produces a target Paseo parses with the daemon port and password", () => {
    const connection = sshConnection({
      destination: "dev@box",
      sshPort: 2222,
      daemonPort: 41234,
      password: "p+a/s=s",
    });
    expect(parseHostTarget(connection)).toEqual({
      kind: "ssh",
      ssh: { host: "dev@box", sshPort: 2222, daemonPort: 41234 },
      password: "p+a/s=s",
      description: expect.any(String),
    });
  });

  test("keeps an ssh config alias and an IPv6 host", () => {
    expect(
      parseHostTarget(
        sshConnection({ destination: "build", sshPort: null, daemonPort: 6767, password: "x" }),
      ),
    ).toMatchObject({ ssh: { host: "build", daemonPort: 6767 } });
    expect(
      parseHostTarget(
        sshConnection({
          destination: "me@[fe80::1]",
          sshPort: null,
          daemonPort: 6767,
          password: "x",
        }),
      ),
    ).toMatchObject({ ssh: { host: "me@fe80::1" } });
  });

  test("never puts the password in the description", () => {
    const target = parseHostTarget(
      sshConnection({
        destination: "dev@box",
        sshPort: null,
        daemonPort: 6767,
        password: "hunter2",
      }),
    );
    expect(target.description).not.toContain("hunter2");
  });
});

test("relayConnection adds the password to a pairing URI Paseo accepts", () => {
  const uri = "relay://relay.paseo.sh:443/srv_abc?key=AAAA&ssl=true";
  const target = parseHostTarget(relayConnection(uri, "s3cret"));
  expect(target).toMatchObject({
    kind: "socket",
    password: "s3cret",
    offer: { serverId: "srv_abc" },
  });
});

test("deploymentSourceKey stays within the 256-character limit", () => {
  expect(
    deploymentSourceKey({ destination: "dev@box", sshPort: null, paseoHome: "/home/dev/.paseo" }),
  ).toBe("deploy:dev@box:22:/home/dev/.paseo");
  const long = deploymentSourceKey({
    destination: "dev@box",
    sshPort: 22,
    paseoHome: `/${"x".repeat(400)}`,
  });
  expect(long).toMatch(/^deploy:[0-9a-f]{64}$/u);
});

describe("pairingLink", () => {
  const connection = relayConnection(
    "relay://relay.paseo.sh:443/srv_abc?key=k%2Bey%3D&ssl=true",
    "Zx_9-password",
  );

  // The app reads #connect= links with this parser, password included.
  test("carries the relay connection and password in the app's #connect= fragment", () => {
    const link = pairingLink(connection, "https://app.paseo.sh/#offer=eyJ2IjoyfQ");
    expect(link.startsWith("https://app.paseo.sh/#connect=relay%3A%2F%2F")).toBe(true);
    expect(parseRelayConnectionUri(link)).toEqual({
      offer: {
        v: 2,
        serverId: "srv_abc",
        daemonPublicKeyB64: "k+ey=",
        relay: { endpoint: "relay.paseo.sh:443", useTls: true },
      },
      password: "Zx_9-password",
    });
  });

  test("uses the app address of the remote daemon's own pairing link, or Paseo's web app", () => {
    expect(pairingLink(connection, "https://paseo.example.com/app/#offer=x")).toMatch(
      /^https:\/\/paseo\.example\.com\/app\/#connect=/u,
    );
    expect(pairingLink(connection, null)).toMatch(/^https:\/\/app\.paseo\.sh\/#connect=/u);
    expect(pairingLink(connection, "not a url")).toMatch(/^https:\/\/app\.paseo\.sh\/#connect=/u);
    expect(pairingLink(connection, "javascript:alert(1)")).toMatch(
      /^https:\/\/app\.paseo\.sh\/#connect=/u,
    );
  });
});
