// Per-curated-surface detail composition for GET
// /api/v1/subnets/{netuid}/surfaces/{surface_id}. Reads the subnet's curated
// surfaces artifact and overlays the live cron probe row — a REST deeplink to
// one full Surface record without fetching the whole list. Integration snippets
// intentionally omitted (agent-catalog + MCP already expose those).
import { resolveSurfaceAlias } from "./surface-aliases.mjs";

export function findCuratedSurface(surfaces, surfaceRef, aliasArtifact = null) {
  if (!Array.isArray(surfaces) || typeof surfaceRef !== "string") return null;
  const direct =
    surfaces.find(
      (surface) => surface?.id === surfaceRef || surface?.key === surfaceRef,
    ) || null;
  if (direct) return direct;

  const alias = resolveSurfaceAlias(aliasArtifact, surfaceRef);
  if (!alias) return null;
  return (
    surfaces.find(
      (surface) =>
        surface?.key === alias.surface_key || surface?.id === alias.current_id,
    ) || null
  );
}

function liveRowForCuratedSurface(live, netuid, surface) {
  if (!live || !Array.isArray(live.surfaces) || !surface) return null;
  const id = surface.id;
  const key = surface.key;
  return (
    live.surfaces.find(
      (row) =>
        row.netuid === netuid &&
        (row.surface_id === id ||
          row.surface_key === key ||
          (key && row.surface_id === key) ||
          (id && row.surface_key === id)),
    ) || null
  );
}

export function composeSurfaceLiveHealth(live, netuid, surface) {
  const row = liveRowForCuratedSurface(live, netuid, surface);
  if (!row) {
    return {
      status: "unknown",
      classification: surface?.classification ?? null,
      latency_ms: null,
      last_checked_at: null,
      observed_by: "unavailable",
    };
  }
  return {
    status: row.status,
    classification: row.classification ?? null,
    latency_ms: row.latency_ms ?? null,
    last_checked_at: row.last_checked ?? row.last_checked_at ?? null,
    observed_by: "live-cron-prober",
  };
}

export function composeSurfaceDetail({ surface, live, netuid, observedAt }) {
  return {
    schema_version: 1,
    source: "registry+live-cron-prober",
    observed_at: observedAt ?? null,
    surface,
    live_health: composeSurfaceLiveHealth(live, netuid, surface),
  };
}
