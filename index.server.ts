import type { PluginServerContext } from "@getpaseo/plugin/server";
import { DeployJobs } from "./server/jobs";
import { resolveNodeRelease } from "./server/node-release";
import { answerPrompt, cancelDeploy, getJob, listJobs, startDeploy } from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  const jobs = new DeployJobs();
  // The handler's PaseoApi belongs to the plugin process, so a deploy keeps using it after the
  // RPC that started it returns.
  server.handle(startDeploy, (request, { paseo }) => ({
    jobId: jobs.start(request, { hosts: paseo.hosts, resolveNode: resolveNodeRelease }),
  }));
  server.handle(listJobs, () => ({ jobs: jobs.list() }));
  server.handle(getJob, ({ jobId }) => ({ job: jobs.get(jobId) }));
  server.handle(answerPrompt, ({ jobId, promptId, value }) => ({
    accepted: jobs.answer(jobId, promptId, value),
  }));
  server.handle(cancelDeploy, ({ jobId }) => ({ cancelled: jobs.cancel(jobId) }));
  return () => jobs.cancelAll();
}
