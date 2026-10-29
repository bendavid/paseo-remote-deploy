import { describe, expect, test } from "vitest";
import {
  cronTag,
  killsOnLogout,
  lingerAllowed,
  planService,
  readServiceFacts,
  renderCronLines,
  type ServiceFacts,
} from "../server/service-plan";

const debianDefault: ServiceFacts = {
  systemd: true,
  linger: "no",
  lingerAllowed: "yes",
  killOnLogout: "no",
  cron: "ok",
};

describe("killsOnLogout follows logind's rules", () => {
  const base = { user: "dev", killOnlyUsers: "", killExcludeUsers: "" };
  test.each([
    [{ ...base, killUserProcesses: "no" }, "no"],
    [{ ...base, killUserProcesses: "yes" }, "yes"],
    [{ ...base, killUserProcesses: "yes", user: "root" }, "no"],
    [{ ...base, killUserProcesses: "yes", killExcludeUsers: "root dev" }, "no"],
    [{ ...base, killUserProcesses: "no", killOnlyUsers: "alice dev" }, "yes"],
    [{ ...base, killUserProcesses: "yes", killOnlyUsers: "alice" }, "no"],
    [{ ...base, killUserProcesses: undefined }, "unknown"],
  ] as const)("%j is %s", (input, expected) => {
    expect(killsOnLogout(input)).toBe(expected);
  });
});

test("lingerAllowed reads pkcheck's exit status and a missing polkit", () => {
  expect(lingerAllowed("pkcheck 0")).toBe("yes");
  expect(lingerAllowed("pkcheck 1")).toBe("no");
  expect(lingerAllowed("pkcheck 2")).toBe("no");
  expect(lingerAllowed("no polkit")).toBe("no");
  expect(lingerAllowed("polkit without pkcheck")).toBe("unknown");
  expect(lingerAllowed("pkcheck 127")).toBe("unknown");
  expect(lingerAllowed(undefined)).toBe("unknown");
});

test("readServiceFacts treats a machine without systemd as never killing at logout", () => {
  const facts = readServiceFacts(
    new Map([
      ["systemd", "no"],
      ["user", "dev"],
      ["cron", "stopped"],
    ]),
  );
  expect(facts).toEqual({
    systemd: false,
    linger: "unknown",
    lingerAllowed: "unknown",
    killOnLogout: "no",
    cron: "stopped",
  });
});

describe("planService in automatic mode", () => {
  test("uses a systemd user service when linger is allowed", () => {
    expect(planService(debianDefault, "auto")).toEqual({
      runAs: "systemd",
      enableLinger: true,
      cron: "none",
      survivesLogout: true,
      startsAtBoot: true,
      caveats: [],
    });
  });

  test("does not enable linger again when it is on, even if polkit would refuse", () => {
    const plan = planService({ ...debianDefault, linger: "yes", lingerAllowed: "no" }, "auto");
    expect(plan).toMatchObject({ runAs: "systemd", enableLinger: false, caveats: [] });
  });

  test("tries linger when polkit's answer is unknown", () => {
    expect(planService({ ...debianDefault, lingerAllowed: "unknown" }, "auto")).toMatchObject({
      runAs: "systemd",
      enableLinger: true,
    });
  });

  test("backgrounds the daemon with a @reboot line when linger is refused", () => {
    expect(planService({ ...debianDefault, lingerAllowed: "no" }, "auto")).toEqual({
      runAs: "background",
      enableLinger: false,
      cron: "reboot",
      survivesLogout: true,
      startsAtBoot: true,
      caveats: [],
    });
  });

  test("backgrounds the daemon on machines without systemd", () => {
    expect(
      planService({ ...debianDefault, systemd: false, lingerAllowed: "unknown" }, "auto"),
    ).toMatchObject({ runAs: "background", cron: "reboot", caveats: [] });
  });

  test("starts it from a keep-alive line when logind kills processes at logout", () => {
    expect(
      planService({ ...debianDefault, lingerAllowed: "no", killOnLogout: "yes" }, "auto"),
    ).toEqual({
      runAs: "cron",
      enableLinger: false,
      cron: "keepalive",
      survivesLogout: true,
      startsAtBoot: true,
      caveats: [],
    });
  });

  test("asks before installing when nothing restarts the daemon after a reboot", () => {
    const plan = planService({ ...debianDefault, lingerAllowed: "no", cron: "denied" }, "auto");
    expect(plan).toMatchObject({ runAs: "background", cron: "none", startsAtBoot: false });
    expect(plan.caveats.join(" ")).toMatch(
      /after a reboot \(you are not allowed to use crontab\)/u,
    );
  });

  test("falls back to a service without linger when neither linger nor cron can keep it up", () => {
    const plan = planService(
      { ...debianDefault, lingerAllowed: "no", killOnLogout: "yes", cron: "missing" },
      "auto",
    );
    expect(plan).toMatchObject({ runAs: "systemd", enableLinger: false, survivesLogout: false });
    expect(plan.caveats.join(" ")).toMatch(/only runs while you are logged in/u);
  });

  test("never falls back to a service when the user manager is unusable", () => {
    const plan = planService(
      {
        ...debianDefault,
        systemd: false,
        lingerAllowed: "no",
        killOnLogout: "yes",
        cron: "missing",
      },
      "auto",
    );
    expect(plan.runAs).toBe("background");
    expect(plan.survivesLogout).toBe(false);
  });
});

describe("planService honours an explicit mode", () => {
  test("background keeps a @reboot line and warns when logout kills it", () => {
    const plan = planService({ ...debianDefault, killOnLogout: "yes" }, "background");
    expect(plan).toMatchObject({ runAs: "background", cron: "reboot", survivesLogout: false });
    expect(plan.caveats.join(" ")).toMatch(/stops when this deploy's SSH session ends/u);
  });

  test("systemd warns when linger is refused", () => {
    const plan = planService({ ...debianDefault, lingerAllowed: "no" }, "systemd");
    expect(plan).toMatchObject({ runAs: "systemd", survivesLogout: false, startsAtBoot: false });
    expect(plan.caveats).toHaveLength(1);
  });
});

test("renderCronLines quotes paths, escapes % and tags both lines", () => {
  const tag = cronTag("paseo-daemon.service");
  expect(tag).toBe("#[paseo-remote-deploy:paseo-daemon]");
  const lines = renderCronLines({
    schedule: "keepalive",
    installDir: "/home/dev/my apps/paseo",
    paseoHome: "/home/dev/100%/.paseo",
    tag,
  }).split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^# Paseo daemon for .*#\[paseo-remote-deploy:paseo-daemon\]$/u);
  expect(lines[1]).toBe(
    "* * * * * '/home/dev/my apps/paseo/bin/paseo' 'daemon' 'start' '--home' '/home/dev/100\\%/.paseo' >/dev/null 2>&1 #[paseo-remote-deploy:paseo-daemon]",
  );
  expect(renderCronLines({ schedule: "none", installDir: "/x", paseoHome: "/y", tag })).toBe("");
});
