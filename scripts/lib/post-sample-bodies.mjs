// Sample JSON bodies for POST routes in docs try-it examples (#1652).
// Keep aligned with docs-site/guides/quickstart.md and scripts/smoke-live-api.mjs.

export const GRAPHQL_SAMPLE_QUERY =
  "{ subnet(netuid: 7) { name health { status } surfaces { kind url } } } }";

const POST_BODY_SAMPLES = {
  "/api/v1/graphql": { query: GRAPHQL_SAMPLE_QUERY },
  "/api/v1/ask": { question: "Which subnets have live OpenAPI specs?" },
  "/api/v1/search/semantic": { q: "subnet health", limit: 3 },
  "/rpc/v1/finney": {
    jsonrpc: "2.0",
    id: 1,
    method: "system_health",
    params: [],
  },
  "/rpc/v1/finney/wss": {
    jsonrpc: "2.0",
    id: 1,
    method: "system_health",
    params: [],
  },
  "/mcp": {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  },
};

function openApiOperation(openapi, routePath, method) {
  const pathItem = openapi?.paths?.[routePath];
  if (!pathItem) return null;
  return pathItem[method.toLowerCase()] ?? null;
}

function extractRequestBodyExample(requestBody) {
  if (!requestBody) return null;
  const content = requestBody.content?.["application/json"];
  if (!content) return null;
  if (content.example !== undefined) return content.example;
  const schema = content.schema;
  if (!schema || typeof schema !== "object") return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.properties?.query) {
    return {
      query: schema.properties.query.example ?? "{ __typename }",
    };
  }
  if (schema.properties?.question) {
    return {
      question:
        schema.properties.question.example ??
        "Which subnets have live OpenAPI specs?",
    };
  }
  if (schema.properties?.q) {
    return {
      q: schema.properties.q.example ?? "subnet health",
      ...(schema.properties.limit
        ? { limit: schema.properties.limit.example ?? 3 }
        : {}),
    };
  }
  if (Array.isArray(schema.required) && schema.required.includes("query")) {
    return { query: "{ __typename }" };
  }
  return null;
}

export function postBodyRequired(route, openapi) {
  if (route.method !== "POST") return false;
  if (route.request_body_required === true) return true;
  const requestBody = openApiOperation(
    openapi,
    route.path,
    route.method,
  )?.requestBody;
  if (requestBody?.required === true) return true;
  return Object.hasOwn(POST_BODY_SAMPLES, route.path);
}

export function samplePostBody(route, openapi) {
  if (route.method !== "POST") return null;
  if (route.sample_body && typeof route.sample_body === "object") {
    return route.sample_body;
  }
  const fromOpenapi = extractRequestBodyExample(
    openApiOperation(openapi, route.path, route.method)?.requestBody,
  );
  if (fromOpenapi) return fromOpenapi;
  if (Object.hasOwn(POST_BODY_SAMPLES, route.path)) {
    return POST_BODY_SAMPLES[route.path];
  }
  return null;
}

export function formatCurlJsonBody(body) {
  const json = JSON.stringify(body);
  return `'${json.replaceAll("'", "'\\''")}'`;
}

export function buildPostCurl(route, openapi, baseUrl, samplePath) {
  const body = samplePostBody(route, openapi);
  if (body === null) {
    if (postBodyRequired(route, openapi)) {
      return null;
    }
    return `curl -s -X POST '${baseUrl}${samplePath}' -H 'content-type: application/json' -d '{}'`;
  }
  return `curl -s -X POST '${baseUrl}${samplePath}' -H 'content-type: application/json' -d ${formatCurlJsonBody(body)}`;
}
