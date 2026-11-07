import type { TestProject } from "vitest/node";
import { startTestCluster } from "./testing";

/**
 * Vitest global setup: one Postgres container per package run instead of one per test
 * file. Each file then clones the migrated template (`startTestDatabase`).
 */
export default async function setup(project: TestProject) {
  const cluster = await startTestCluster();
  project.provide("postgresUrl", cluster.url);
  return cluster.stop;
}
