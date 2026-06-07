/**
 * @module index
 * Cloudflare Worker entry point for the MemeBro backend gateway.
 * Accepts client requests, validates upload payloads, and routes supported
 * modes to upstream APIs without exposing external URLs or API keys.
 */

import { callAPI, redactSecrets } from "./callManager.js";
import { ErrorCodes } from "./errors.js";
import {
  assertFeatureEnabled,
  getFeatureAvailability,
} from "./fallback.js";
import { getServiceHealth } from "./healthCheck.js";
import { handleCaptionRequest } from "./openai/caption.js";
import {
  buildImageResponseFromBody,
  handleImageRequest,
} from "./openai/image.js";
import { enqueueRequest } from "./requestQueue.js";
import { compositeImage } from "./image-compositor.js";
import { MAX_FILE_SIZE, sanitizeFilename, validateUpload } from "./validator.js";

const GATEWAY_PATH = "/api/process";
const CAPTION_PATH = "/api/caption";
const IMAGE_PATH = "/api/image";
const HEALTH_PATH = "/api/health";
const RECENTS_PATH = "/api/recents";
const RECENTS_KV_KEY = "memebro:recents";
const RECENTS_MAX_ITEMS = 20;
const RECENTS_MAX_BYTES = 1024 * 1024;

/**
 * Builds a JSON Response with the gateway's common content type.
 *
 * @param {unknown} body - JSON-serializable response body
 * @param {number} status - HTTP status code
 * @returns {Response} Worker response
 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

/**
 * Converts known gateway errors into HTTP response statuses.
 *
 * @param {Error} err - Error thrown by validation or upstream routing
 * @returns {number} HTTP status code
 */
function statusForError(err) {
  if (Number.isInteger(err.status)) return err.status;
  if (err.code === ErrorCodes.PAYLOAD_TOO_LARGE) return 413;
  if (err.code === ErrorCodes.EMPTY_PROMPT) return 400;
  if (err.code === ErrorCodes.PROMPT_TOO_LONG) return 400;
  if (err.code === ErrorCodes.UPSTREAM_BLOCKED) return 400;
  if (err.code === ErrorCodes.INVALID_MODE) return 400;
  if (err.code === ErrorCodes.CLIENT_ERROR) return 400;
  if (err.code === ErrorCodes.INVALID_DIMENSIONS) return 400;
  if (err.code === ErrorCodes.RATE_LIMITED) return 429;
  if (err.code === ErrorCodes.QUEUE_FULL) return 503;
  if (err.code === ErrorCodes.FEATURE_DISABLED) return 503;
  if (err.code === ErrorCodes.SERVICE_UNAVAILABLE) return 503;
  if (err.code === ErrorCodes.NO_API_KEY) return 503;
  if (err.code === ErrorCodes.MISSING_API_KEY) return 500;
  if (err.code === ErrorCodes.OPENAI_ERROR) return 502;
  return 502;
}

/**
 * Builds a structured error response without leaking configured secrets.
 *
 * @param {Error} err - Error thrown while handling the request
 * @param {Object} env - Cloudflare Workers env object
 * @returns {Response} JSON error response
 */
function errorResponse(err, env) {
  const code = err.code || ErrorCodes.SERVER_ERROR;
  const body = {
    code,
    message: redactSecrets(err.message, env),
    retryable: Boolean(err.retryable),
  };
  if (err.feature) body.feature = err.feature;
  return jsonResponse(body, statusForError(err));
}

/**
 * Throws PAYLOAD_TOO_LARGE when Content-Length already exceeds the limit.
 *
 * @param {Request} request - Incoming Worker request
 * @throws {Error} PAYLOAD_TOO_LARGE when Content-Length is over 10 MB
 */
function rejectOversizedContentLength(request) {
  const contentLength = request.headers.get("Content-Length");

  if (contentLength && Number(contentLength) > MAX_FILE_SIZE) {
    const err = new Error("Maximum upload size is 10 MB");
    err.code = ErrorCodes.PAYLOAD_TOO_LARGE;
    err.retryable = false;
    throw err;
  }
}

/**
 * Reads the request body and enforces the 10 MB upload limit.
 *
 * @param {Request} request - Incoming Worker request
 * @returns {Promise<ArrayBuffer>} Raw request body
 * @throws {Error} PAYLOAD_TOO_LARGE when the body exceeds 10 MB
 */
async function readLimitedBody(request) {
  rejectOversizedContentLength(request);

  const buffer = await request.arrayBuffer();

  if (buffer.byteLength > MAX_FILE_SIZE) {
    const err = new Error("Maximum upload size is 10 MB");
    err.code = ErrorCodes.PAYLOAD_TOO_LARGE;
    err.retryable = false;
    throw err;
  }

  return buffer;
}

/**
 * Extracts a gateway mode from URL search params, headers, or JSON payload.
 *
 * @param {Request} request - Incoming Worker request
 * @param {Object|null} payload - Parsed JSON payload, when available
 * @returns {string|undefined} Requested gateway mode
 */
function getMode(request, payload = null) {
  const url = new URL(request.url);
  return (
    url.searchParams.get("mode") ||
    request.headers.get("X-MemeBro-Mode") ||
    payload?.mode
  );
}

/**
 * Prepares an outbound request from a JSON client payload.
 *
 * @param {Request} request - Incoming Worker request
 * @param {ArrayBuffer} buffer - Raw request body
 * @returns {{ mode: string|undefined, options: RequestInit }} Outbound call
 */
function prepareJsonOutbound(request, buffer) {
  const text = new TextDecoder().decode(buffer);
  const payload = text ? JSON.parse(text) : {};
  const mode = getMode(request, payload);
  const outboundBody = JSON.stringify(payload);

  return {
    mode,
    payload,
    isJson: true,
    options: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: outboundBody,
    },
  };
}

/**
 * Validates a raw image upload and prepares it for upstream forwarding.
 *
 * @param {Request} request - Incoming Worker request
 * @param {ArrayBuffer} buffer - Raw request body
 * @returns {{ mode: string|undefined, options: RequestInit }} Outbound call
 */
function prepareImageOutbound(request, buffer) {
  const mimeType = request.headers.get("Content-Type")?.split(";")[0] || "";
  const filename = request.headers.get("X-MemeBro-Filename") || "upload";
  const validation = validateUpload({
    buffer,
    mimeType,
    filename,
    size: buffer.byteLength,
  });

  return {
    mode: getMode(request),
    payload: null,
    isJson: false,
    buffer,
    mimeType,
    requestHeaders: request.headers,
    options: {
      method: "POST",
      headers: {
        "Content-Type": mimeType,
        "X-MemeBro-Filename": sanitizeFilename(validation.filename),
      },
      body: buffer,
    },
  };
}

/**
 * Parses and validates the gateway request body before an upstream call.
 *
 * @param {Request} request - Incoming Worker request
 * @returns {Promise<{ mode: string|undefined, options: RequestInit }>}
 * Prepared outbound request
 */
async function prepareOutboundRequest(request) {
  const buffer = await readLimitedBody(request);
  const contentType = request.headers.get("Content-Type") || "";

  if (contentType.includes("application/json")) {
    return prepareJsonOutbound(request, buffer);
  }

  if (contentType.startsWith("image/")) {
    return prepareImageOutbound(request, buffer);
  }

  const err = new Error("Unsupported request content type");
  err.code = ErrorCodes.CLIENT_ERROR;
  err.retryable = false;
  throw err;
}

/**
 * Determines whether a gateway mode should run against the worker-local
 * /api/image implementation instead of an external URL.
 *
 * - `ai_prompt` always uses the local pipeline (Issue B, B.7): the request
 *   payload carries the user's free-form prompt and is processed directly by
 *   the OpenAI image handler with safety prefix injection.
 * - `extra_roast` falls back to local only when neither EXTRA_ROAST_API_URL
 *   nor IMAGE_GEN_API_URL is configured, so existing deployments keep their
 *   current upstream behavior without any changes.
 *
 * @param {string|undefined} mode - Requested gateway mode
 * @param {Object} env - Cloudflare Workers env object
 * @returns {boolean}
 */
function shouldUseLocalImageGeneration(mode, env) {
  if (mode === "ai_prompt") return true;
  if (mode !== "extra_roast") return false;
  const hasExtraRoastUrl = Boolean(String(env?.EXTRA_ROAST_API_URL ?? "").trim());
  const hasImageGenUrl = Boolean(String(env?.IMAGE_GEN_API_URL ?? "").trim());
  return !hasExtraRoastUrl && !hasImageGenUrl;
}

function shouldUseLocalFaceSwap(mode, isJson, requestHeaders) {
  return mode === "face_swap" && !isJson && Boolean(requestHeaders?.get("X-MemeBro-Face-Crop"));
}

/**
 * Derives a stable per-client key for rate limiting. Prefers Cloudflare's
 * trusted client IP header and falls back so a missing header can never throw.
 *
 * @param {Request} request - Incoming Worker request
 * @returns {string} Rate-limit bucket key
 */
function clientRateLimitKey(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For") ||
    "anonymous"
  );
}

/**
 * Throttles the paid ai_prompt image-generation mode per client (bug #2).
 * Backed by the AI_PROMPT_RATE_LIMITER binding declared in wrangler.jsonc.
 * When the binding is absent (local dev / tests) this is a no-op, so the
 * longer-window dashboard rule remains the primary production control.
 *
 * @param {Request} request - Incoming Worker request
 * @param {Object} env - Cloudflare Workers env object
 * @throws {Error} RATE_LIMITED when the per-minute burst limit is exceeded
 */
async function enforceAiPromptRateLimit(request, env) {
  const limiter = env?.AI_PROMPT_RATE_LIMITER;
  if (typeof limiter?.limit !== "function") return;

  const { success } = await limiter.limit({ key: clientRateLimitKey(request) });
  if (!success) {
    const err = new Error(
      "Too many AI image requests; please wait a minute and try again."
    );
    err.code = ErrorCodes.RATE_LIMITED;
    err.retryable = true;
    throw err;
  }
}

async function handleLocalFaceSwap({ buffer, mimeType, requestHeaders }, env) {
  const selectedTemplateId = requestHeaders.get("X-MemeBro-Template") || "";
  const faceCropBounds = parseJsonHeader(requestHeaders, "X-MemeBro-Face-Crop") || {};
  const textOptions = parseJsonHeader(requestHeaders, "X-MemeBro-Text-Style") || {};
  const memeText = requestHeaders.get("X-MemeBro-Meme-Text") || "TAP TO EDIT TEXT";
  const templateImage = await loadTemplateImage(selectedTemplateId, env);
  const faceRegion = getTemplateFaceRegion(templateImage.template);

  const result = await compositeImage({
    templateImage,
    faceCrop: {
      b64: arrayBufferToBase64(buffer),
      mimeType,
      width: Number(faceCropBounds.width),
      height: Number(faceCropBounds.height),
      bounds: faceCropBounds,
    },
    text: memeText,
    faceRegion,
    textOptions,
    env,
  });

  if (result instanceof Response) return result;
  return jsonResponse(result);
}

function parseJsonHeader(headers, name) {
  const raw = headers.get(name);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error(`Invalid ${name} header`);
    err.code = ErrorCodes.CLIENT_ERROR;
    err.retryable = false;
    throw err;
  }
}

async function loadTemplateImage(templateId, env) {
  if (!env?.ASSETS?.fetch) {
    const err = new Error("Static assets are required for local face compositing");
    err.code = ErrorCodes.CLIENT_ERROR;
    err.retryable = false;
    throw err;
  }

  const catalogResponse = await env.ASSETS.fetch(new Request("https://assets.local/templates.json"));
  if (!catalogResponse.ok) {
    const err = new Error("Template catalog could not be loaded");
    err.code = ErrorCodes.SERVER_ERROR;
    err.retryable = true;
    throw err;
  }

  const catalog = await catalogResponse.json();
  const template = catalog.templates?.find((entry) => entry.id === templateId);
  if (!template) {
    const err = new Error("Selected template was not found");
    err.code = ErrorCodes.CLIENT_ERROR;
    err.retryable = false;
    throw err;
  }

  const imagePath = template.templateImage || template.images?.main || template.previewImage;
  const imageResponse = await env.ASSETS.fetch(new Request(`https://assets.local${imagePath}`));
  if (!imageResponse.ok) {
    const err = new Error("Template image could not be loaded");
    err.code = ErrorCodes.SERVER_ERROR;
    err.retryable = true;
    throw err;
  }

  const mimeType = imageResponse.headers.get("content-type")?.split(";")[0] || "image/png";
  const buffer = await imageResponse.arrayBuffer();
  return {
    template,
    b64: arrayBufferToBase64(buffer),
    mimeType,
    width: template.images?.width,
    height: template.images?.height,
    path: imagePath,
  };
}

function getTemplateFaceRegion(template) {
  const region = template?.faceRegions?.[0];
  if (!region) {
    const err = new Error("Selected template does not define a face region");
    err.code = ErrorCodes.CLIENT_ERROR;
    err.retryable = false;
    throw err;
  }
  return region;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Handles the MemeBro API gateway route.
 *
 * @param {Request} request - Incoming Worker request
 * @param {Object} env - Cloudflare Workers env object
 * @returns {Promise<Response>} JSON response from the gateway
 */
export async function handleGatewayRequest(request, env) {
  try {
    if (request.method !== "POST") {
      return jsonResponse(
        { code: "METHOD_NOT_ALLOWED", message: "Use POST for API requests" },
        405
      );
    }

    const prepared = await prepareOutboundRequest(request);
    const { mode, options, payload, isJson } = prepared;

    // Fallback strategy (issue #33): refuse the request early when the
    // upstream powering this mode is currently unhealthy. The client sees a
    // FEATURE_DISABLED error code so it can disable the affected UI affordance
    // instead of looking like the whole app crashed.
    await assertFeatureEnabled(mode, env);

    // Cost + abuse control (bug #2): throttle the paid ai_prompt mode before it
    // can reach OpenAI. No-op when the rate-limit binding is not configured.
    if (mode === "ai_prompt") {
      await enforceAiPromptRateLimit(request, env);
    }

    if (isJson && shouldUseLocalImageGeneration(mode, env)) {
      return await enqueueRequest(() =>
        buildImageResponseFromBody(payload ?? {}, env, { throwErrors: true })
      );
    }

    if (shouldUseLocalFaceSwap(mode, isJson, prepared.requestHeaders)) {
      return handleLocalFaceSwap(prepared, env);
    }

    // Request queue (issue #34): smooths bursts above 10 req/s and applies
    // backpressure once the FIFO queue is saturated.
    const data = await enqueueRequest(() => callAPI(mode, options, env));

    return jsonResponse(data);
  } catch (err) {
    return errorResponse(err, env);
  }
}

/**
 * Handles GET /api/health. Returns the current upstream health snapshot so
 * monitoring tools and the frontend can detect degraded modes without
 * hitting the real API.
 *
 * @param {Request} request - Incoming Worker request
 * @param {Object} env - Cloudflare Workers env object
 * @returns {Promise<Response>}
 */
export async function handleHealthRequest(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse(
      { code: "METHOD_NOT_ALLOWED", message: "Use GET for /api/health" },
      405
    );
  }

  try {
    const url = new URL(request.url);
    const force = url.searchParams.get("force") === "1";

    const features = await getFeatureAvailability(env);
    const faceSwap = await getServiceHealth("face_swap", env, { force });

    const allHealthy = Object.values(features).every((f) => f.healthy);

    return jsonResponse({
      status: allHealthy ? "ok" : "degraded",
      timestamp: Date.now(),
      services: {
        face_swap: {
          healthy: faceSwap.healthy,
          checkedAt: faceSwap.checkedAt,
          cached: faceSwap.cached,
          statusCode: faceSwap.statusCode,
          reason: faceSwap.reason,
        },
      },
      features,
    });
  } catch (err) {
    return jsonResponse(
      {
        status: "error",
        timestamp: Date.now(),
        message: redactSecrets(err.message, env),
      },
      500
    );
  }
}

async function readRecentsStorage(store) {
  const stored = await store.get(RECENTS_KV_KEY);
  if (!stored) return [];

  const raw = typeof stored === "string"
    ? stored
    : typeof stored.text === "function"
      ? await stored.text()
      : null;

  if (raw == null) {
    const err = new Error("Cloud recents storage returned an unsupported value.");
    err.code = ErrorCodes.SERVER_ERROR;
    err.retryable = true;
    throw err;
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through to the structured corrupt-storage error below.
  }

  const err = new Error("Cloud recents storage contains invalid JSON.");
  err.code = ErrorCodes.SERVER_ERROR;
  err.retryable = true;
  throw err;
}

async function parseRecentsPayload(request) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > RECENTS_MAX_BYTES) {
    const err = new Error("Recents payload is too large.");
    err.code = ErrorCodes.PAYLOAD_TOO_LARGE;
    err.retryable = false;
    throw err;
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > RECENTS_MAX_BYTES) {
    const err = new Error("Recents payload is too large.");
    err.code = ErrorCodes.PAYLOAD_TOO_LARGE;
    err.retryable = false;
    throw err;
  }

  let payload;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    const err = new Error("Recents payload must be valid JSON.");
    err.code = ErrorCodes.CLIENT_ERROR;
    err.retryable = false;
    throw err;
  }

  const recents = payload?.recents;
  if (
    !Array.isArray(recents)
    || recents.length > RECENTS_MAX_ITEMS
    || recents.some((item) => !item || typeof item !== "object" || Array.isArray(item))
  ) {
    const err = new Error("Recents payload must include up to 20 recent meme objects.");
    err.code = ErrorCodes.CLIENT_ERROR;
    err.retryable = false;
    throw err;
  }

  return recents;
}

export async function handleRecentsRequest(request, env) {
  if (env?.RECENTS_CLOUD_SYNC !== "1") {
    return jsonResponse(
      {
        code: ErrorCodes.FEATURE_DISABLED,
        message: "Cloud recents sync is disabled.",
        retryable: false,
      },
      503
    );
  }

  const store = env?.RECENTS_KV || env?.RECENTS;

  if (!store || typeof store.get !== "function" || typeof store.put !== "function") {
    return jsonResponse(
      {
        code: ErrorCodes.FEATURE_DISABLED,
        message: "Cloud recents storage is not configured.",
        retryable: false,
      },
      503
    );
  }

  try {
    if (request.method === "GET") {
      const recents = await readRecentsStorage(store);
      return jsonResponse({ recents });
    }

    if (request.method === "PUT") {
      const recents = await parseRecentsPayload(request);
      await store.put(RECENTS_KV_KEY, JSON.stringify(recents));

      return jsonResponse({
        recents,
        saved: true,
      });
    }
  } catch (err) {
    return errorResponse(err, env);
  }

  return jsonResponse(
    {
      code: "METHOD_NOT_ALLOWED",
      message: "Use GET or PUT for /api/recents",
    },
    405
  );
}

export default {
  /**
   * Cloudflare Worker fetch handler.
   *
   * @param {Request} request - Incoming Worker request
   * @param {Object} env - Cloudflare Workers env object
   * @returns {Promise<Response>} Worker response
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === HEALTH_PATH) {
      return handleHealthRequest(request, env);
    }

    if (url.pathname === CAPTION_PATH) {
      return handleCaptionRequest(request, env);
    }

    if (url.pathname === IMAGE_PATH) {
      return handleImageRequest(request, env);
    }

    if (url.pathname === RECENTS_PATH) {
      return handleRecentsRequest(request, env);
    }

    if (url.pathname === GATEWAY_PATH) {
      return handleGatewayRequest(request, env);
    }

    // Serve static frontend/docs assets in dev and production deployments.
    if (env.ASSETS?.fetch) {
      return env.ASSETS.fetch(request);
    }

    return jsonResponse({
      name: "MemeBro API gateway",
      route: GATEWAY_PATH,
    });
  },
};