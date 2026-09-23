import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "../test-utils/index.js";

const MIB = 1024 * 1024;
const APP_PAGE_SIZE = 40;

describe("daemon E2E - large agent history (#2610)", () => {
  let ctx: DaemonTestContext;
  let cwd: string;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
    cwd = mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
  });

  afterEach(async () => {
    await ctx.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }, 60_000);

  async function createAgentWithHistory(
    rows: number,
    rowBytes: number
  ): Promise<string> {
    const agent = await ctx.client.createAgent({
      provider: "codex",
      cwd,
      title: "Large history",
    });
    const body = "x".repeat(rowBytes);
    for (let index = 0; index < rows; index += 1) {
      await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
        type: "assistant_message",
        text: `${index} ${body}`,
      });
      await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
        type: "user_message",
        text: `next ${index}`,
      });
    }
    return agent.id;
  }

  test("opens an agent whose history totals more than 64 MiB of ordinary rows", async () => {
    const agentId = await createAgentWithHistory(20_000, 4_000);

    const page = await ctx.client.fetchAgentTimeline(agentId, {
      direction: "tail",
      limit: APP_PAGE_SIZE,
      projection: "projected",
      timeout: 60_000,
    });

    expect(page.error).toBeNull();
    expect(page.entries).toHaveLength(APP_PAGE_SIZE);
    expect(page.hasOlder).toBe(true);
  }, 300_000);

  test("opens an agent whose latest file writes total more than 64 MiB", async () => {
    const agent = await ctx.client.createAgent({
      provider: "codex",
      cwd,
      title: "Large writes",
    });
    const content = "x".repeat(2 * MIB);
    for (let index = 0; index < APP_PAGE_SIZE; index += 1) {
      await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
        type: "tool_call",
        callId: `write_${index}`,
        name: "Write",
        status: "completed",
        error: null,
        detail: {
          type: "write",
          filePath: `fixtures/data-${index}.json`,
          content,
        },
      });
    }

    const page = await ctx.client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: APP_PAGE_SIZE,
      projection: "projected",
      timeout: 60_000,
    });

    expect(page.error).toBeNull();
    expect(page.entries.length).toBeGreaterThan(0);
  }, 300_000);
});
