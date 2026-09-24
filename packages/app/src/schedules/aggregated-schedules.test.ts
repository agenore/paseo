import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import { describe, expect, it } from "vitest";
import {
  ALL_SCHEDULE_HOSTS_FAILED_MESSAGE,
  fetchAggregatedSchedules,
  type ScheduleRuntime,
  type ScheduleRuntimeSnapshot,
} from "./aggregated-schedules";

function makeSchedule(overrides: Partial<ScheduleSummary> = {}): ScheduleSummary {
  return {
    id: "schedule-1",
    name: "Nightly",
    prompt: "Run the task",
    cadence: { type: "every", everyMs: 60_000 },
    target: { type: "new-agent", config: { provider: "codex", cwd: "/tmp/project" } },
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    nextRunAt: "2026-07-02T01:00:00.000Z",
    lastRunAt: null,
    pausedAt: null,
    expiresAt: null,
    maxRuns: null,
    ...overrides,
  };
}

function makeRuntime(input: {
  snapshots: Record<string, ScheduleRuntimeSnapshot | null>;
  schedules?: Record<string, ScheduleSummary[]>;
}): ScheduleRuntime {
  return {
    getSnapshot: (serverId) => input.snapshots[serverId] ?? null,
    getClient: (serverId) => {
      const schedules = input.schedules?.[serverId];
      if (!schedules) {
        return null;
      }
      return {
        scheduleList: async () => ({ requestId: "test-request", schedules, error: null }),
      };
    },
  };
}

describe("fetchAggregatedSchedules load state", () => {
  it("does not report loaded empty while known hosts are still connecting", async () => {
    const result = await fetchAggregatedSchedules({
      hosts: [
        { serverId: "host-a", serverName: "Host A" },
        { serverId: "host-b", serverName: "Host B" },
      ],
      runtime: makeRuntime({
        snapshots: {
          "host-a": { connectionStatus: "connecting" },
          "host-b": { connectionStatus: "connecting" },
        },
      }),
    });

    expect(result.status).not.toBe("loaded");
    expect(result).toEqual({ status: "connecting" });
  });

  it("reports loaded empty after all reachable hosts answer with no schedules", async () => {
    const result = await fetchAggregatedSchedules({
      hosts: [
        { serverId: "host-a", serverName: "Host A" },
        { serverId: "host-b", serverName: "Host B" },
      ],
      runtime: makeRuntime({
        snapshots: {
          "host-a": { connectionStatus: "online" },
          "host-b": { connectionStatus: "online" },
        },
        schedules: {
          "host-a": [],
          "host-b": [],
        },
      }),
    });

    expect(result).toEqual({ status: "loaded", data: [], hostErrors: [] });
  });

  it("shows the empty result with a warning while another host is connecting", async () => {
    const result = await fetchAggregatedSchedules({
      hosts: [
        { serverId: "host-a", serverName: "Host A" },
        { serverId: "host-b", serverName: "Host B" },
      ],
      runtime: makeRuntime({
        snapshots: {
          "host-a": { connectionStatus: "online" },
          "host-b": { connectionStatus: "connecting" },
        },
        schedules: {
          "host-a": [],
        },
      }),
    });

    expect(result).toEqual({
      status: "loaded",
      data: [],
      hostErrors: [
        {
          serverId: "host-b",
          serverName: "Host B",
          message: "Still connecting; schedules from this host are not shown yet",
        },
      ],
    });
  });

  it.each([
    { initial: "connecting", next: "online", includedHosts: [], missingHosts: ["host-b"] },
    { initial: "online", next: "connecting", includedHosts: ["host-b"], missingHosts: [] },
  ])(
    "keeps warnings consistent when a host changes from $initial to $next",
    async ({ initial, next, includedHosts, missingHosts }) => {
      const snapshots: Record<string, ScheduleRuntimeSnapshot> = {
        "host-a": { connectionStatus: "online" },
        "host-b": { connectionStatus: initial },
      };
      const schedule = makeSchedule();
      const result = await fetchAggregatedSchedules({
        hosts: [
          { serverId: "host-a", serverName: "Host A" },
          { serverId: "host-b", serverName: "Host B" },
        ],
        runtime: {
          getSnapshot: (serverId) => snapshots[serverId],
          getClient: (serverId) => ({
            scheduleList: async () => {
              // Both hosts have been considered before the first response arrives.
              await Promise.resolve();
              snapshots["host-b"] = { connectionStatus: next };
              return {
                requestId: "transition-request",
                schedules: serverId === "host-a" ? [] : [schedule],
                error: null,
              };
            },
          }),
        },
      });
      expect(result).toEqual({
        status: "loaded",
        data: includedHosts.map((serverId) => ({ ...schedule, serverId, serverName: "Host B" })),
        hostErrors: missingHosts.map((serverId) => ({
          serverId,
          serverName: "Host B",
          message: "Still connecting; schedules from this host are not shown yet",
        })),
      });
    },
  );

  it("keeps the error state when the only connected host fails", async () => {
    await expect(
      fetchAggregatedSchedules({
        hosts: [
          { serverId: "host-a", serverName: "Host A" },
          { serverId: "host-b", serverName: "Host B" },
        ],
        runtime: {
          getSnapshot: (serverId) => ({
            connectionStatus: serverId === "host-a" ? "online" : "connecting",
          }),
          getClient: (serverId) =>
            serverId === "host-a"
              ? {
                  scheduleList: async () => ({
                    requestId: "failed-request",
                    schedules: [],
                    error: "Schedule storage unavailable",
                  }),
                }
              : null,
        },
      }),
    ).rejects.toThrow(ALL_SCHEDULE_HOSTS_FAILED_MESSAGE);
  });

  it("loads reachable host data when another known host is still connecting", async () => {
    const schedule = makeSchedule();
    const result = await fetchAggregatedSchedules({
      hosts: [
        { serverId: "host-a", serverName: "Host A" },
        { serverId: "host-b", serverName: "Host B" },
      ],
      runtime: makeRuntime({
        snapshots: {
          "host-a": { connectionStatus: "online" },
          "host-b": { connectionStatus: "connecting" },
        },
        schedules: {
          "host-a": [schedule],
        },
      }),
    });

    expect(result).toEqual({
      status: "loaded",
      data: [{ ...schedule, serverId: "host-a", serverName: "Host A" }],
      hostErrors: [
        {
          serverId: "host-b",
          serverName: "Host B",
          message: "Still connecting; schedules from this host are not shown yet",
        },
      ],
    });
  });
});
