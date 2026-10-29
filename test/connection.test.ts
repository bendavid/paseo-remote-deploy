import { parseHostTarget } from "@getpaseo/protocol/host-target";
import { describe, expect, test } from "vitest";
import { deploymentSourceKey, relayConnection, sshConnection } from "../server/connection";

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
