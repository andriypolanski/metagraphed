import { SURFACE_ALIASES_PATH } from "../../src/surface-aliases.mjs";
import {
  composeSurfaceDetail,
  findCuratedSurface,
} from "../../src/surface-detail.mjs";
import { SURFACE_ID_PATTERN } from "../../src/surface-verify.mjs";
import { errorResponse } from "../http.mjs";
import { contractVersion, envelopeResponse } from "../responses.mjs";
import { readArtifact } from "../storage.mjs";

export const SUBNET_SURFACE_DETAIL_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/surfaces\/([^/]+)$/;

export async function handleSurfaceDetail(
  request,
  env,
  netuid,
  surfaceId,
  { resolveLiveHealth, readHealthKv },
) {
  if (!Number.isInteger(netuid) || netuid < 0) {
    return errorResponse(
      "invalid_netuid",
      "netuid must be a non-negative integer.",
      400,
      { netuid },
    );
  }
  if (!SURFACE_ID_PATTERN.test(surfaceId)) {
    return errorResponse(
      "invalid_surface_id",
      "surface_id must be a catalog-safe identifier (no slashes or spaces).",
      400,
      { surface_id: surfaceId },
    );
  }

  const surfacesArtifact = await readArtifact(
    env,
    `/metagraph/surfaces/${netuid}.json`,
  );
  if (!surfacesArtifact.ok) {
    return errorResponse(
      "artifact_unavailable",
      "The curated surfaces artifact for this subnet is unavailable.",
      surfacesArtifact.status === 404 ? 404 : 503,
      { netuid, artifact_path: `/metagraph/surfaces/${netuid}.json` },
    );
  }

  const aliasesArtifact = await readArtifact(env, SURFACE_ALIASES_PATH);
  const surface = findCuratedSurface(
    surfacesArtifact.data?.surfaces,
    surfaceId,
    aliasesArtifact.ok ? aliasesArtifact.data : null,
  );
  if (!surface) {
    return errorResponse(
      "surface_not_found",
      `No curated surface with id, key, or deprecated id "${surfaceId}" on subnet ${netuid}.`,
      404,
      { netuid, surface_id: surfaceId },
    );
  }

  const live =
    (await resolveLiveHealth({
      readHealthKv,
      env,
      db: env.METAGRAPH_HEALTH_DB,
    })) || null;

  const data = composeSurfaceDetail({
    surface,
    live,
    netuid,
    observedAt: live?.last_run_at ?? null,
  });

  return envelopeResponse(
    request,
    {
      data,
      meta: {
        contract_version: contractVersion(env),
        artifact_path: `/metagraph/surfaces/${netuid}/${surface.id}.json`,
        observed_at: live?.last_run_at ?? null,
      },
    },
    "short",
  );
}
