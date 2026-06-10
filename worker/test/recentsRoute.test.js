import { describe, expect, it, vi } from "vitest";
import worker from "../src";

function createKvStore(initialValue = null) {
  let value = initialValue;
  return {
    get: vi.fn(async () => value),
    put: vi.fn(async (_key, nextValue) => {
      value = nextValue;
    }),
  };
}

function createEnv(store) {
  return {
    RECENTS_CLOUD_SYNC: "1",
    RECENTS_KV: store,
  };
}

async function readJson(response) {
  return response.json();
}

describe("/api/recents", () => {
  it("is disabled unless RECENTS_CLOUD_SYNC is enabled", async () => {
    const response = await worker.fetch(new Request("https://example.com/api/recents"), {});

    expect(response.status).toBe(503);
    await expect(readJson(response)).resolves.toMatchObject({
      code: "FEATURE_DISABLED",
      retryable: false,
    });
  });

  it("requires a configured recents storage binding", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/api/recents"),
      { RECENTS_CLOUD_SYNC: "1" }
    );

    expect(response.status).toBe(503);
    await expect(readJson(response)).resolves.toMatchObject({
      code: "FEATURE_DISABLED",
      message: "Cloud recents storage is not configured.",
    });
  });

  it("returns an empty recents list when storage has no value", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/api/recents"),
      createEnv(createKvStore())
    );

    expect(response.status).toBe(200);
    await expect(readJson(response)).resolves.toEqual({ recents: [] });
  });

  it("stores and retrieves recent meme data from KV", async () => {
    const store = createKvStore();
    const recents = [{ id: "recent-1", mode: "text" }];

    const putResponse = await worker.fetch(
      new Request("https://example.com/api/recents", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recents }),
      }),
      createEnv(store)
    );
    const getResponse = await worker.fetch(
      new Request("https://example.com/api/recents"),
      createEnv(store)
    );

    expect(putResponse.status).toBe(200);
    expect(store.put).toHaveBeenCalledWith("memebro:recents", JSON.stringify(recents));
    await expect(readJson(getResponse)).resolves.toEqual({ recents });
  });

  it("reads R2-style object bodies", async () => {
    const recents = [{ id: "recent-r2", mode: "face_swap" }];
    const store = {
      get: vi.fn(async () => ({
        text: async () => JSON.stringify(recents),
      })),
      put: vi.fn(),
    };

    const response = await worker.fetch(
      new Request("https://example.com/api/recents"),
      createEnv(store)
    );

    expect(response.status).toBe(200);
    await expect(readJson(response)).resolves.toEqual({ recents });
  });

  it("rejects invalid JSON without overwriting stored recents", async () => {
    const store = createKvStore(JSON.stringify([{ id: "existing" }]));

    const response = await worker.fetch(
      new Request("https://example.com/api/recents", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      }),
      createEnv(store)
    );

    expect(response.status).toBe(400);
    expect(store.put).not.toHaveBeenCalled();
    await expect(readJson(response)).resolves.toMatchObject({
      code: "CLIENT_ERROR",
      message: "Recents payload must be valid JSON.",
    });
  });

  it("rejects recents payloads that are not arrays of objects", async () => {
    const store = createKvStore();

    const response = await worker.fetch(
      new Request("https://example.com/api/recents", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recents: ["bad"] }),
      }),
      createEnv(store)
    );

    expect(response.status).toBe(400);
    expect(store.put).not.toHaveBeenCalled();
  });

  it("rejects unsupported methods", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/api/recents", { method: "POST" }),
      createEnv(createKvStore())
    );

    expect(response.status).toBe(405);
    await expect(readJson(response)).resolves.toMatchObject({
      code: "METHOD_NOT_ALLOWED",
    });
  });
});
