/**
 * Cloudflare Worker handler: POST /api/image
 *
 * Mirrors the previous MemeBro image endpoint contract:
 * - 503 { error: "no_api_key" } when OPENAI_API_KEY is missing
 * - 413 { error: "reference_too_large" } for oversized refs
 * - 400 { error: "blocked", ... } for moderation rejects
 * - 400 { error: "prompt_too_long" } for ai_prompt prompts exceeding MAX_AI_PROMPT_LENGTH
 * - 200 { b64, model, quality, size, mode } on success
 *
 * Note: the "ai_prompt" gateway mode is text-to-image only. It is not a value
 * in ALLOWED_MODES, so successful ai_prompt responses report mode "generate".
 */
import { ErrorCodes } from "../errors.js";
import { MAX_AI_PROMPT_LENGTH, buildAiPrompt } from "./aiPromptMode.js";

/**
 * Legacy hard cap applied to non-ai_prompt prompts via silent truncation.
 * Kept separate from MAX_AI_PROMPT_LENGTH (which rejects rather than truncates)
 * so the two limits can diverge without coupling their behavior by accident.
 */
const LEGACY_PROMPT_MAX = 800;

const EDIT_SUBJECT_HINT = "The attached photo is the subject of the scene below.";
const EDIT_BYO_HINT =
  "The first attached photo is the subject; the second is the scene/composition reference.";

const ALLOWED_QUALITIES = ["low", "high"];
const ALLOWED_SIZES = ["1024x1024", "1024x1536", "1536x1024"];
const ALLOWED_MODES = ["generate", "restyle", "cast"];

const MAX_REF_BYTES = 4 * 1024 * 1024;
const LEGACY_DETAIL_CODES = new Set(["prompt_too_long", "openai_error"]);

/**
 * Handles an HTTP request for POST /api/image.
 *
 * @param {Request} request
 * @param {Object} env
 * @returns {Promise<Response>}
 */
export async function handleImageRequest(request, env) {
  if (request.method !== "POST") {
    return jsonError(405, "method_not_allowed");
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_json");
  }

  return buildImageResponseFromBody(body, env);
}

/**
 * Reuses the same image pipeline from non-HTTP call sites (for example
 * /api/process compatibility mode) while preserving the old response contract.
 *
 * @param {Object} body
 * @param {Object} env
 * @param {{ throwErrors?: boolean }} [options]
 * @returns {Promise<Response>}
 */
export async function buildImageResponseFromBody(body, env, options = {}) {
  const { throwErrors = false } = options;

  if (!env?.OPENAI_API_KEY) {
    return imageError(throwErrors, {
      status: 503,
      gatewayCode: ErrorCodes.NO_API_KEY,
      legacyCode: "no_api_key",
      message: "OpenAI API key is not configured.",
    });
  }

  const rawPrompt = String(body?.prompt ?? "").trim();
  if (!rawPrompt) {
    return imageError(throwErrors, {
      status: 400,
      gatewayCode: ErrorCodes.EMPTY_PROMPT,
      legacyCode: "empty_prompt",
      message: "Prompt is required.",
    });
  }

  const isAiPromptMode = body?.mode === "ai_prompt";

  if (isAiPromptMode && rawPrompt.length > MAX_AI_PROMPT_LENGTH) {
    return imageError(throwErrors, {
      status: 400,
      gatewayCode: ErrorCodes.PROMPT_TOO_LONG,
      legacyCode: "prompt_too_long",
      message: `Prompt must be ${MAX_AI_PROMPT_LENGTH} characters or fewer`,
    });
  }

  const prompt = isAiPromptMode
    ? buildAiPrompt(rawPrompt)
    : rawPrompt.slice(0, LEGACY_PROMPT_MAX);

  const quality = ALLOWED_QUALITIES.includes(body?.quality)
    ? body.quality
    : "low";

  const size = ALLOWED_SIZES.includes(body?.size)
    ? body.size
    : "1024x1024";

  const model = env.OPENAI_IMAGE_MODEL || "gpt-image-2";

  // When the client sends a reference image with ai_prompt mode, use it so
  // OpenAI edits the existing template instead of generating from scratch.
  const hasRef = Boolean(body?.referenceB64);
  const mode = ALLOWED_MODES.includes(body?.mode)
    ? body.mode
    : hasRef
      ? "cast"
      : "generate";

  if (body?.referenceB64 && String(body.referenceB64).length > MAX_REF_BYTES) {
    return imageError(throwErrors, {
      status: 413,
      gatewayCode: ErrorCodes.PAYLOAD_TOO_LARGE,
      legacyCode: "reference_too_large",
      message: "Reference image is too large.",
    });
  }

  if (body?.templateRefB64 && String(body.templateRefB64).length > MAX_REF_BYTES) {
    return imageError(throwErrors, {
      status: 413,
      gatewayCode: ErrorCodes.PAYLOAD_TOO_LARGE,
      legacyCode: "reference_too_large",
      message: "Reference image is too large.",
    });
  }

  const callOpenAI = () =>
    hasRef
      ? callEditsEndpoint(env.OPENAI_API_KEY, model, prompt, quality, size, body)
      : callGenerationsEndpoint(env.OPENAI_API_KEY, model, prompt, quality, size);

  let oa = await callOpenAI();
  if (!oa.ok && oa.status >= 500 && oa.status < 600) {
    await sleep(700);
    oa = await callOpenAI();
  }

  if (!oa.ok) {
    const text = await oa.text().catch(() => "");
    const upstream = parseUpstreamError(text);

    if (
      oa.status >= 400 &&
      oa.status < 500 &&
      (upstream.code === "moderation_blocked" ||
        upstream.code === "safety_violation" ||
        /safety system|content policy|moderation/i.test(upstream.message ?? ""))
    ) {
      return blockedError(throwErrors, upstream.message ?? "OpenAI rejected this request.");
    }

    let passthrough;
    if (oa.status === 503) {
      passthrough = 502;
    } else if (oa.status >= 500 && oa.status < 600) {
      passthrough = oa.status;
    } else {
      passthrough = 502;
    }

    return imageError(throwErrors, {
      status: passthrough,
      gatewayCode: ErrorCodes.OPENAI_ERROR,
      legacyCode: "openai_error",
      message: (upstream.message ?? text).slice(0, 800),
      retryable: passthrough >= 500,
    });
  }

  const data = await oa
    .json()
    .catch(() => null);

  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) {
    return imageError(throwErrors, {
      status: 502,
      gatewayCode: ErrorCodes.OPENAI_ERROR,
      legacyCode: "no_image_returned",
      message: "OpenAI did not return an image.",
      retryable: true,
    });
  }

  return new Response(
    JSON.stringify({ b64, model, quality, size, mode }),
    {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    }
  );
}

async function callGenerationsEndpoint(apiKey, model, prompt, quality, size) {
  return fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
      size,
      quality,
    }),
  });
}

async function callEditsEndpoint(apiKey, model, prompt, quality, size, body) {
  const refB64 = String(body?.referenceB64 ?? "");
  const mime = String(body?.referenceMime ?? "image/png").split(";")[0].trim();
  const bytes = base64ToBytes(refB64);
  const blob = new Blob([bytes], { type: mime });

  const hasTemplateRef = Boolean(body?.templateRefB64);

  const hint = hasTemplateRef ? EDIT_BYO_HINT : EDIT_SUBJECT_HINT;
  const finalPrompt = `${hint} ${prompt}`;

  const fd = new FormData();
  fd.append("model", model);
  fd.append("prompt", finalPrompt);
  fd.append("n", "1");
  fd.append("size", size);
  fd.append("quality", quality);

  const imageField = hasTemplateRef ? "image[]" : "image";
  fd.append(imageField, blob, fileNameFor(mime));

  if (hasTemplateRef) {
    const tplMime = String(body?.templateRefMime ?? "image/png")
      .split(";")[0]
      .trim();
    const tplBytes = base64ToBytes(String(body?.templateRefB64 ?? ""));
    const tplBlob = new Blob([tplBytes], { type: tplMime });
    fd.append(
      imageField,
      tplBlob,
      fileNameFor(tplMime).replace("reference", "template")
    );
  }

  return fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
    body: fd,
  });
}

function fileNameFor(mime) {
  if (mime === "image/jpeg") return "reference.jpg";
  if (mime === "image/webp") return "reference.webp";
  return "reference.png";
}

function base64ToBytes(b64) {
  const clean = String(b64).replace(/^data:[^,]+,/, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function jsonError(status, code, detail) {
  return new Response(JSON.stringify({ error: code, detail }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function imageError(throwErrors, { status, gatewayCode, legacyCode, message, retryable = false }) {
  if (!throwErrors) {
    const legacyDetail = LEGACY_DETAIL_CODES.has(legacyCode) ? message : undefined;
    return jsonError(status, legacyCode, legacyDetail);
  }

  const err = new Error(message);
  err.code = gatewayCode;
  err.status = status;
  err.retryable = retryable;
  throw err;
}

function blockedError(throwErrors, message) {
  if (!throwErrors) {
    return new Response(
      JSON.stringify({
        error: "blocked",
        category: "upstream",
        message,
      }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  const err = new Error(message);
  err.code = ErrorCodes.UPSTREAM_BLOCKED;
  err.status = 400;
  err.retryable = false;
  throw err;
}

function parseUpstreamError(text) {
  if (!text) return {};

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && parsed.error) {
      return {
        message: parsed.error.message,
        code: parsed.error.code,
      };
    }
  } catch {
    // not JSON
  }

  return { message: text };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
