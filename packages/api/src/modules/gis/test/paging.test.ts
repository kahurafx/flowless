import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { setupTestEnv, type TestEnv } from "./test-support";

describe("paged lists", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setupTestEnv();
  });
  afterAll(async () => {
    await env.close();
  });

  it("walks every live node a page at a time, skipping deleted ones and seeing the branch's view", async () => {
    // Org C starts empty, so the counts are exact.
    const org = () => env.gisOnly();
    const made = [];
    for (let i = 0; i < 7; i++) {
      made.push(await org().gis.nodes.create({ type: "junction", name: `J${i}`, location: { lat: -1.3, lng: 36.8 + i * 0.001 } }));
    }
    const sorted = [...made].sort((a, b) => a.id.localeCompare(b.id));
    const gone = sorted[2]!;
    await org().gis.nodes.delete({ id: gone.id, baseVersionId: gone.versionId });
    const hidden = sorted[3]!;
    await org().gis.nodes.delete({ id: hidden.id, baseVersionId: hidden.versionId, branch: "trim" });

    const walk = async (branch: string) => {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await org().gis.nodes.page({ branch, limit: 2, ...(cursor ? { cursor } : {}) });
        seen.push(...page.items.map((n) => n.id));
        cursor = page.nextCursor ?? undefined;
        pages++;
      } while (cursor);
      return { seen, pages };
    };

    const main = await walk("main");
    assert.deepEqual(
      main.seen,
      sorted.filter((n) => n.id !== gone.id).map((n) => n.id),
    );
    assert.equal(main.pages, 3);
    const branch = await walk("trim");
    assert.deepEqual(
      branch.seen,
      sorted.filter((n) => n.id !== gone.id && n.id !== hidden.id).map((n) => n.id),
    );
  });
});
