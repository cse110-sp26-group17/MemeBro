/**
 * @vitest-environment jsdom
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import catalog from "../public/templates.json";

vi.mock("../public/.generated/mediapipe/vision_bundle.mjs", () => ({
  FaceDetector: {
    createFromOptions: vi.fn(async () => ({
      detect: vi.fn(() => ({ detections: [] })),
    })),
  },
  FilesetResolver: {
    forVisionTasks: vi.fn(async () => ({})),
  },
}));

const testDir = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.resolve(testDir, "../public/index.html");
const indexHtml = readFileSync(htmlPath, "utf8");
const vibePanelCss = readFileSync(path.resolve(testDir, "../public/styles/studio/vibe-panel.css"), "utf8");
const aiPromptingCss = readFileSync(path.resolve(testDir, "../public/styles/studio/ai-prompting.css"), "utf8");

function mountAppHtml() {
  const mainMarkup = indexHtml.match(/<main[\s\S]*<\/main>/)?.[0] || "";
  document.body.innerHTML = mainMarkup;
}

async function loadApp() {
  return import("../public/app.js");
}

async function settleApp() {
  await Promise.resolve();
  await Promise.resolve();
}

function createMemoryStorage() {
  const values = new Map();

  return {
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key) => {
      const storageKey = String(key);
      return values.has(storageKey) ? values.get(storageKey) : null;
    }),
    removeItem: vi.fn((key) => values.delete(String(key))),
    setItem: vi.fn((key, value) => values.set(String(key), String(value))),
  };
}

function createRequest() {
  return {
    error: null,
    result: undefined,
    onerror: null,
    onsuccess: null,
    onupgradeneeded: null,
  };
}

function createFakeIndexedDB() {
  const stores = new Map();
  let opened = false;

  function ensureStore(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  }

  const db = {
    objectStoreNames: {
      contains: (name) => stores.has(name),
    },
    createObjectStore: (name) => {
      ensureStore(name);
    },
    transaction: (storeNames) => {
      const transaction = {
        error: null,
        onabort: null,
        oncomplete: null,
        onerror: null,
        objectStore: (name) => ({
          put: (value) => {
            ensureStore(name).set(value.id, value);
          },
          delete: (id) => {
            ensureStore(name).delete(id);
          },
          get: (id) => {
            const request = createRequest();
            setTimeout(() => {
              request.result = ensureStore(name).get(id);
              request.onsuccess?.();
            }, 0);
            return request;
          },
        }),
      };

      const names = Array.isArray(storeNames) ? storeNames : [storeNames];
      names.forEach(ensureStore);
      setTimeout(() => transaction.oncomplete?.(), 0);
      return transaction;
    },
    close: vi.fn(),
    onversionchange: null,
  };

  return {
    open: vi.fn(() => {
      const request = createRequest();
      setTimeout(() => {
        request.result = db;
        if (!opened) {
          opened = true;
          request.onupgradeneeded?.();
        }
        request.onsuccess?.();
      }, 0);
      return request;
    }),
  };
}

function seedStudioEditorState(state, templateId = catalog.templates[0].id) {
  const template = catalog.templates.find((entry) => entry.id === templateId) || catalog.templates[0];

  state.templateCatalog = catalog.templates;
  state.view = "studio";
  state.selectedTemplateId = template.id;
  state.editor.templateImage = template.templateImage || template.images.main || template.images.preview || "/assets/memes/placeholder.svg";
  state.editor.generatedImage = "";
  state.editor.overlayText = "Tap to edit text";
  state.editor.overlayVisible = true;
  state.editor.overlayFontKey = "impact";
  state.editor.overlayFontPx = 22;
  state.editor.overlaySizeMode = "default";
  state.editor.overlayTextColor = "black";
  state.editor.overlayOutlineEnabled = true;
  state.editor.overlayAutoScale = 1;
  state.editor.initialSnapshot = {
    selectedTemplateId: template.id,
    templateImage: state.editor.templateImage,
    generatedImage: "",
    overlayText: "Tap to edit text",
    overlayVisible: true,
    overlayFontKey: "impact",
    overlayFontPx: 22,
    overlaySizeMode: "default",
    overlayTextColor: "black",
    overlayOutlineEnabled: true,
  };
  state.editor.historyStack = [];
}

function mockFaceCropCanvas(blobType = "image/jpeg") {
  let canvas;
  const drawImage = vi.fn();

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function getContext() {
    canvas = this;
    return { drawImage };
  });
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function toBlob(callback, type) {
    callback(new Blob(["face-crop"], { type: type || blobType }));
  });

  return {
    drawImage,
    get canvas() {
      return canvas;
    },
  };
}

/**
 * Mocks browser image loading and canvas export for recent thumbnail saves.
 *
 * @returns {{drawImage: import("vitest").Mock}} Canvas draw spy used by thumbnail generation.
 */
function mockRecentThumbnailExport() {
  const drawImage = vi.fn();

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({ drawImage }));
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback, type) => {
    callback(new Blob(["recent-thumbnail"], { type: type || "image/webp" }));
  });

  class MockImage {
    constructor() {
      this.naturalWidth = 512;
      this.naturalHeight = 256;
      this.width = 512;
      this.height = 256;
      this.onload = null;
      this.onerror = null;
      this.decoding = "";
    }

    set src(value) {
      this.currentSrc = value;
      setTimeout(() => this.onload?.(), 0);
    }

    get src() {
      return this.currentSrc;
    }
  }

  Object.defineProperty(globalThis, "Image", {
    configurable: true,
    value: MockImage,
  });
  Object.defineProperty(window, "Image", {
    configurable: true,
    value: MockImage,
  });

  return { drawImage };
}

function seedSelectedFaceCrop(state, options = {}) {
  const source = options.source || { width: 120, height: 90 };
  const face = options.face || {
    id: "face-0",
    boxNatural: { x: 20, y: 15, width: 40, height: 30 },
  };
  const file = options.file || new File(["source-image"], "portrait.png", { type: "image/png" });

  state.file = file;
  state.imageBitmap = {
    source,
    width: source.width,
    height: source.height,
  };
  state.faces = [face];
  state.selectedFaceIds = [face.id];
  state.selectedFaceId = face.id;

  return { file, source, face };
}

describe("US-03 scenario 7.4: inline text editing + face-swap loader", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    mountAppHtml();
    const localStorage = createMemoryStorage();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: localStorage,
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: localStorage,
    });
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: createFakeIndexedDB(),
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:http://localhost/recent-thumb"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    vi.stubGlobal("requestAnimationFrame", (cb) => cb());
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (url === "/templates.json") {
        return { json: async () => ({ templates: catalog.templates }) };
      }
      return { ok: true, json: async () => ({ generatedImageUrl: "/generated/default.png" }) };
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.__MEMEBRO_AI_PROMPT_REQUEST__;
    delete globalThis.__MEMEBRO_EXPORT_BLOB__;
  });

  test("custom: text is editable inline and preview updates live", async () => {
    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, render } = __testHooks;

    seedStudioEditorState(state);
    render();

    dom.memeTextPreview.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(state.isEditingMemeText).toBe(true);
    expect(dom.memeTextPreview.getAttribute("contenteditable")).toBe("true");

    dom.memeTextPreview.textContent = "new meme text";
    dom.memeTextPreview.dispatchEvent(new Event("input", { bubbles: true }));
    expect(dom.memeTextPreview.textContent).toBe("new meme text");

    dom.memeTextPreview.dispatchEvent(new Event("blur", { bubbles: true }));
    expect(state.isEditingMemeText).toBe(false);
    expect(dom.memeTextPreview.getAttribute("contenteditable")).toBe("false");
  });

  test("custom: text settings update preview styles and undo restores them", async () => {
    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, render, updateEditorTextSetting } = __testHooks;

    seedStudioEditorState(state);
    render();

    expect(dom.memeFontSelect.value).toBe("impact");
    expect(dom.memeFontSizeInput.value).toBe("22");
    expect(dom.memeTextColorInput.value).toBe("#000000");
    expect(dom.memeOutlineRemoveCta).toBeNull();

    updateEditorTextSetting("overlayFontKey", "comic-sans");
    updateEditorTextSetting("overlayFontPx", 14);
    updateEditorTextSetting("overlayTextColor", "red");
    updateEditorTextSetting("overlayOutlineEnabled", false);

    expect(state.editor.overlayFontKey).toBe("comic-sans");
    expect(state.editor.overlayFontPx).toBe(14);
    expect(state.editor.overlayTextColor).toBe("red");
    expect(state.editor.overlayOutlineEnabled).toBe(false);
    expect(dom.memeTextPreview.style.fontFamily).toContain("Comic Sans MS");
    expect(dom.memeTextPreview.style.color).toBe("rgb(214, 40, 40)");
    expect(dom.memeTextPreview.style.textShadow).toBe("none");

    dom.undoCta.click();
    dom.undoCta.click();
    dom.undoCta.click();
    dom.undoCta.click();

    expect(state.editor.overlayFontKey).toBe("impact");
    expect(state.editor.overlayFontPx).toBe(22);
    expect(state.editor.overlayTextColor).toBe("black");
    expect(state.editor.overlayOutlineEnabled).toBe(true);
  });

  test("custom: gallery cards use previewImage sources and preserve image dimensions", async () => {
    const { __testHooks } = await loadApp();
    await settleApp();
    const { dom } = __testHooks;

    dom.titleStartCta.click();
    await settleApp();
    await settleApp();

    const firstCardImage = dom.templateGrid.querySelector(".template-art-image");
    const firstCardArt = dom.templateGrid.querySelector(".template-art");

    expect(firstCardImage).not.toBeNull();
    expect(firstCardImage.getAttribute("src")).toBe(catalog.templates[0].previewImage);
    expect(firstCardImage.loading).toBe("lazy");
    expect(firstCardArt.style.aspectRatio).toBe(`${catalog.templates[0].images.width} / ${catalog.templates[0].images.height}`);
  });

  test("custom: empty recents tab shows CTA that switches back to trending", async () => {
    const { __testHooks } = await loadApp();
    await settleApp();
    const { dom } = __testHooks;

    dom.titleStartCta.click();
    await settleApp();
    dom.templateTabs.querySelector("[data-tab='recents']").click();
    await settleApp();

    expect(dom.templateEmpty.textContent).toContain("No Recent Memes Yet.");
    expect(dom.templateEmpty.textContent).toContain("Create your first meme from the Trending Tab");

    dom.templateEmpty.querySelector(".template-empty-cta").click();
    await settleApp();

    expect(dom.templateTabs.querySelector("[data-tab='trending']").classList.contains("active")).toBe(true);
    expect(dom.templateGrid.querySelector(".template-card")).not.toBeNull();
  });

  test("custom: recents tab renders saved thumbnails and restores snapshots on click", async () => {
    const app = await loadApp();
    const { saveRecentMeme } = await import("../public/js/recents.js");
    await settleApp();
    const { __testHooks } = app;
    const { state, dom } = __testHooks;
    const template = catalog.templates[0];

    state.templateCatalog = catalog.templates;
    const savedRecent = await saveRecentMeme({
      id: "recent-editor-state",
      savedAt: 2000,
      currentImage: "/generated/recent.png",
      mode: "face_swap",
      editorSnapshot: {
        selectedTemplateId: template.id,
        templateImage: template.images.main,
        generatedImage: "/generated/recent.png",
        overlayText: "restored caption",
        overlayVisible: true,
        overlayX: 22,
        overlayY: 33,
        overlayWidthPct: 44,
        overlayRotation: 90,
        frozenTextItems: [{ text: "saved lower caption" }],
      },
      historyStack: [
        { selectedTemplateId: template.id, overlayText: "seed" },
        { selectedTemplateId: template.id, overlayText: "restored caption" },
      ],
      futureStack: [{ selectedTemplateId: template.id, overlayText: "redo caption" }],
      thumbnail: {
        blob: new Blob(["recent-thumb"], { type: "image/webp" }),
        width: 256,
        height: 144,
        type: "image/webp",
      },
    });

    dom.titleStartCta.click();
    await settleApp();
    dom.templateTabs.querySelector("[data-tab='recents']").click();
    await settleApp();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const recentCard = dom.templateGrid.querySelector("[data-recent-meme-id='recent-editor-state']");
    expect(recentCard).not.toBeNull();
    expect(recentCard.querySelector("img").getAttribute("src")).toBe("blob:http://localhost/recent-thumb");

    recentCard.click();
    await settleApp();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state.view).toBe("studio");
    expect(state.selectedTemplateId).toBe(template.id);
    expect(state.editor.generatedImage).toBe("/generated/recent.png");
    expect(state.editor.overlayText).toBe("restored caption");
    expect(state.editor.overlayX).toBe(22);
    expect(state.editor.overlayY).toBe(33);
    expect(state.editor.overlayWidthPct).toBe(44);
    expect(state.editor.overlayRotation).toBe(90);
    expect(state.editor.historyStack).toHaveLength(2);
    expect(state.editor.futureStack).toHaveLength(1);
    expect(state.editor.historyStack).not.toBe(savedRecent.snapshot.editHistory.historyStack);
  });

  test("custom: save button stores the current editor state as a recent meme", async () => {
    mockRecentThumbnailExport();
    const { __testHooks } = await loadApp();
    const { getRecentMeme } = await import("../public/js/recents.js");
    await settleApp();
    const { state, dom, render } = __testHooks;

    seedStudioEditorState(state);
    state.editor.generatedImage = "/generated/saved-by-button.png";
    state.editor.overlayText = "saved from button";
    state.editor.overlayX = 24;
    state.editor.overlayY = 36;
    state.editor.overlayWidthPct = 58;
    state.editor.overlayRotation = 90;
    state.editor.frozenTextItems = [{ text: "lower text" }];
    state.editor.historyStack = [
      { overlayText: "seed" },
      { overlayText: "saved from button" },
    ];
    state.editor.futureStack = [{ overlayText: "redo text" }];
    render();

    dom.saveCta.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const metadata = JSON.parse(localStorage.getItem("recent-memes"));
    expect(metadata).toHaveLength(1);
    expect(metadata[0].currentImage).toBe("/generated/saved-by-button.png");
    expect(metadata[0].mode).toBe("face_swap");
    expect(metadata[0].thumbnail).toEqual({
      id: metadata[0].id,
      width: 256,
      height: 128,
      type: "image/webp",
    });

    const recent = await getRecentMeme(metadata[0].id);
    expect(recent.snapshot.currentImage).toBe("/generated/saved-by-button.png");
    expect(recent.snapshot.editorSnapshot.overlayText).toBe("saved from button");
    expect(recent.snapshot.editHistory.historyStack).toHaveLength(2);
    expect(recent.snapshot.editHistory.futureStack).toHaveLength(1);
    expect(recent.snapshot.textContent).toEqual({
      activeText: "saved from button",
      frozenTextItems: [{ text: "lower text" }],
    });
    expect(recent.snapshot.transformation).toEqual({
      x: 24,
      y: 36,
      widthPct: 58,
      rotation: 90,
      visible: true,
    });
    expect(recent.thumbnail.blob.type).toBe("image/webp");
  });

  test("custom: save button surfaces a visible error when no current image exists", async () => {
    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom } = __testHooks;

    state.view = "studio";
    state.selectedTemplateId = null;
    state.editor.templateImage = "";
    state.editor.generatedImage = "";
    Object.defineProperty(dom.studioTemplateImage, "currentSrc", {
      configurable: true,
      value: "",
    });
    Object.defineProperty(dom.studioTemplateImage, "src", {
      configurable: true,
      value: "",
    });

    dom.saveCta.click();

    await vi.waitFor(() => {
      expect(state.error).toMatchObject({
        code: "MISSING_CURRENT_IMAGE",
        message: "A current image is required to save this meme.",
      });
    });
    expect(dom.errorState.classList.contains("hidden")).toBe(false);
    expect(dom.errorMessage.textContent).toContain("current image is required");
  });

  test("custom: template face regions stay inside the actual meme image bounds", () => {
    for (const template of catalog.templates) {
      for (const region of template.faceRegions || []) {
        expect(region.x).toBeGreaterThanOrEqual(0);
        expect(region.y).toBeGreaterThanOrEqual(0);
        expect(region.width).toBeGreaterThan(0);
        expect(region.height).toBeGreaterThan(0);
        expect(region.x + region.width).toBeLessThanOrEqual(template.images.width);
        expect(region.y + region.height).toBeLessThanOrEqual(template.images.height);
      }
    }
  });

  test("custom: long text shrinks to stay inside the meme canvas", async () => {
    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, render, syncMemeTextAppearance } = __testHooks;

    seedStudioEditorState(state);
    state.editor.overlayText = "this is a much longer meme caption that should shrink to stay visible";

    dom.studioTemplateArt.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 320,
      bottom: 320,
      width: 320,
      height: 320,
    });

    dom.memeTextPreview.getBoundingClientRect = () => {
      const fontSize = dom.memeTextPreview.style.fontSize;
      const scale = Number(fontSize.match(/\*\s([0-9.]+)\)/)?.[1] || 1);
      const width = 360 * scale;
      const height = 150 * scale;
      return {
        left: (320 - width) / 2,
        right: (320 + width) / 2,
        top: 320 - 70 - height,
        bottom: 320 - 70,
        width,
        height,
      };
    };

    render();
    const scale = syncMemeTextAppearance();

    expect(scale).toBeLessThan(1);
    expect(Number(dom.memeTextPreview.dataset.fitScale)).toBeLessThan(1);
    expect(state.editor.overlayAutoScale).toBeLessThan(1);
  });

  test("custom: rotated text drags to template edges using its rotated bounds", async () => {
    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, render } = __testHooks;
    const { moveTextDrag } = await import("../public/lib/textOverlay.js");

    seedStudioEditorState(state);
    state.editor.overlayText = "ROTATED";
    state.editor.overlayX = 50;
    state.editor.overlayY = 50;
    state.editor.overlayWidthPct = 48;
    state.editor.overlayRotation = 90;
    state.textDragPointerId = 1;
    state.textPointerStartX = 150;
    state.textPointerStartY = 100;
    state.textStartX = 50;
    state.textStartY = 50;
    dom.studioTemplateArt.getBoundingClientRect = () => ({ width: 300, height: 200 });
    Object.defineProperty(dom.memeTextPreview, "offsetWidth", { configurable: true, value: 144 });
    Object.defineProperty(dom.memeTextPreview, "offsetHeight", { configurable: true, value: 40 });
    render();

    moveTextDrag(
      { pointerId: 1, clientX: -300, clientY: 100, preventDefault: vi.fn() },
      { dom, clamp: (value, min, max) => Math.min(Math.max(value, min), max), render }
    );

    expect(state.editor.overlayX).toBeCloseTo(6.67, 1);
  });

  test("custom: studio template uses full image source without cover-cropping", async () => {
    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, render } = __testHooks;

    seedStudioEditorState(state, "expanding-brain");
    render();

    const template = catalog.templates.find((entry) => entry.id === "expanding-brain");
    const { getStudioTemplateBox } = await import("../public/lib/templates.js");
    const expectedBox = getStudioTemplateBox(template);

    expect(dom.studioTemplateImage.getAttribute("src")).toBe(template.templateImage);
    expect(dom.studioTemplateArt.style.width).toBe(`${expectedBox.width}px`);
    expect(dom.studioTemplateArt.style.height).toBe(`${expectedBox.height}px`);
  });

  test("custom: selected face crop matches clamped dimensions without black borders", async () => {
    const cropCanvas = mockFaceCropCanvas("image/png");
    const { __testHooks } = await loadApp();
    await settleApp();

    const source = { width: 100, height: 80 };
    const file = new File(["source-image"], "edge-face.png", { type: "image/png" });
    const face = {
      id: "face-edge",
      boxNatural: { x: -4.4, y: 9.2, width: 34.1, height: 24.3 },
    };

    const crop = await __testHooks.extractFaceCrop(file, face, {
      decodedImage: { source, width: source.width, height: source.height },
      type: "image/png",
    });

    expect(crop.bounds).toEqual({ x: 0, y: 9, width: 30, height: 25 });
    expect(crop.width).toBe(30);
    expect(crop.height).toBe(25);
    expect(crop.blob.type).toBe("image/png");
    expect(cropCanvas.canvas.width).toBe(30);
    expect(cropCanvas.canvas.height).toBe(25);
    expect(cropCanvas.drawImage).toHaveBeenCalledWith(
      source,
      0,
      9,
      30,
      25,
      0,
      0,
      30,
      25
    );

    const [, sourceX, sourceY, sourceWidth, sourceHeight] = cropCanvas.drawImage.mock.calls[0];
    expect(sourceX).toBeGreaterThanOrEqual(0);
    expect(sourceY).toBeGreaterThanOrEqual(0);
    expect(sourceX + sourceWidth).toBeLessThanOrEqual(source.width);
    expect(sourceY + sourceHeight).toBeLessThanOrEqual(source.height);
  });

  test("custom: submit sends the extracted face crop blob to the backend", async () => {
    const cropCanvas = mockFaceCropCanvas("image/png");
    global.fetch = vi.fn(async (url) => {
      if (url === "/templates.json") {
        return { json: async () => ({ templates: catalog.templates }) };
      }
      if (url === "/api/process") {
        return { ok: true, json: async () => ({ generatedImageUrl: "/generated/cropped.png" }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, submitSelectedFace } = __testHooks;

    seedStudioEditorState(state);
    state.status = "ready";
    const { source, face } = seedSelectedFaceCrop(state, {
      source: { width: 160, height: 120 },
      face: { id: "face-0", boxNatural: { x: 24, y: 18, width: 50, height: 42 } },
    });

    await submitSelectedFace();

    const processCall = global.fetch.mock.calls.find(([url]) => url === "/api/process");
    expect(processCall).toBeTruthy();
    const [, requestOptions] = processCall;
    expect(requestOptions.method).toBe("POST");
    expect(requestOptions.headers["Content-Type"]).toBe("image/png");
    expect(requestOptions.headers["X-MemeBro-Mode"]).toBe("face_swap");
    expect(requestOptions.headers["X-MemeBro-Filename"]).toBe("portrait-face-crop.png");
    expect(JSON.parse(requestOptions.headers["X-MemeBro-Face-Crop"])).toEqual({
      x: 24,
      y: 18,
      width: 50,
      height: 42,
    });
    expect(requestOptions.body).toBeInstanceOf(Blob);
    expect(requestOptions.body.type).toBe("image/png");
    expect(cropCanvas.canvas.width).toBe(50);
    expect(cropCanvas.canvas.height).toBe(42);
    expect(cropCanvas.drawImage).toHaveBeenCalledWith(
      source,
      face.boxNatural.x,
      face.boxNatural.y,
      face.boxNatural.width,
      face.boxNatural.height,
      0,
      0,
      face.boxNatural.width,
      face.boxNatural.height
    );
  });

  test("custom: loader shows immediately, shows slower message at 5s, then hides", async () => {
    vi.useFakeTimers();
    mockFaceCropCanvas("image/png");
    let resolveRequest;
    global.fetch = vi.fn((url) => {
      if (url === "/templates.json") {
        return Promise.resolve({ json: async () => ({ templates: catalog.templates }) });
      }
      if (url === "/api/process") {
        return new Promise((resolve) => {
          resolveRequest = resolve;
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, submitSelectedFace } = __testHooks;

    seedStudioEditorState(state);
    state.status = "ready";
    state.selectedTemplateId = catalog.templates[0].id;
    seedSelectedFaceCrop(state, {
      face: { id: "face-0", boxNatural: { x: 0, y: 0, width: 10, height: 10 } },
    });

    const pending = submitSelectedFace();
    expect(dom.faceSwapLoader.classList.contains("hidden")).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    vi.advanceTimersByTime(45001);
    expect(dom.faceSwapLoaderDelay.classList.contains("hidden")).toBe(false);

    resolveRequest({ ok: true, json: async () => ({ generatedImageUrl: "/generated/slow.png" }) });
    await pending;

    expect(dom.faceSwapLoader.classList.contains("hidden")).toBe(true);
  });

  test("custom: face swap result replaces the template image and stays editable", async () => {
    mockFaceCropCanvas("image/png");
    global.fetch = vi.fn(async (url) => {
      if (url === "/templates.json") {
        return { json: async () => ({ templates: catalog.templates }) };
      }
      if (url === "/api/process") {
        return { ok: true, json: async () => ({ generatedImageUrl: "/generated/swapped.png" }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, render, submitSelectedFace } = __testHooks;

    seedStudioEditorState(state);
    state.status = "ready";
    seedSelectedFaceCrop(state, {
      face: { id: "face-0", boxNatural: { x: 0, y: 0, width: 10, height: 10 } },
    });
    render();

    await submitSelectedFace();
    expect(dom.studioTemplateImage.getAttribute("src")).toBe("/generated/swapped.png");

    dom.memeTextPreview.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    dom.memeTextPreview.textContent = "fresh text";
    dom.memeTextPreview.dispatchEvent(new Event("input", { bubbles: true }));

    expect(state.editor.overlayText).toBe("fresh text");
    expect(dom.memeTextPreview.textContent).toBe("fresh text");
  });

  test("custom: undo restores the previous snapshot and reset clears history", async () => {
    mockFaceCropCanvas("image/png");
    global.fetch = vi.fn(async (url) => {
      if (url === "/templates.json") {
        return { json: async () => ({ templates: catalog.templates }) };
      }
      if (url === "/api/process") {
        return { ok: true, json: async () => ({ generatedImageUrl: "/generated/undoable.png" }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, render, submitSelectedFace } = __testHooks;

    seedStudioEditorState(state);
    state.status = "ready";
    seedSelectedFaceCrop(state, {
      face: { id: "face-0", boxNatural: { x: 0, y: 0, width: 10, height: 10 } },
    });
    render();

    await submitSelectedFace();
    dom.memeTextPreview.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    dom.memeTextPreview.textContent = "edited once";
    dom.memeTextPreview.dispatchEvent(new Event("input", { bubbles: true }));
    dom.memeTextPreview.dispatchEvent(new Event("blur", { bubbles: true }));

    const historyLengthAfterEdit = state.editor.historyStack.length;
    dom.undoCta.click();
    expect(state.editor.overlayText).toBe("Tap to edit text");
    expect(state.editor.generatedImage).toBe("/generated/undoable.png");
    expect(state.editor.historyStack.length).toBe(historyLengthAfterEdit - 1);

    dom.resetCta.click();
    expect(dom.resetConfirmation.classList.contains("hidden")).toBe(false);
    dom.resetCancelCta.click();
    expect(dom.resetConfirmation.classList.contains("hidden")).toBe(true);

    dom.resetCta.click();
    dom.resetConfirmCta.click();
    expect(state.editor.generatedImage).toBe("");
    expect(state.editor.overlayText).toBe("TAP TO EDIT TEXT");
    expect(state.editor.historyStack).toEqual([]);
    expect(localStorage.getItem("meme-editor-history")).toBeNull();
  });

  test("custom: AI prompt overlay opens with accessible textarea and rem-based copy", async () => {
    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, render } = __testHooks;

    seedStudioEditorState(state);
    render();

    dom.aiPromptCta.click();

    expect(state.aiPrompt.panelState).toBe("open");
    expect(dom.aiPromptPanel.classList.contains("hidden")).toBe(false);
    expect(dom.aiPromptInput.tagName).toBe("TEXTAREA");
    expect(dom.aiPromptInput.getAttribute("aria-label")).toBe("Prompt AI for meme changes");
    expect(document.querySelector('label[for="ai-prompt-input"]')).not.toBeNull();
    expect(vibePanelCss).not.toMatch(/\.ai-prompt-panel/);
    expect(aiPromptingCss).toMatch(/\.ai-prompt-panel textarea[\s\S]*font-size:\s*1rem/);
    expect(aiPromptingCss).toMatch(/\.ai-prompt-form textarea[\s\S]*border-radius:\s*22px/);
    expect(aiPromptingCss).toMatch(/\.ai-prompt-form textarea[\s\S]*resize:\s*none/);
    expect(aiPromptingCss).toMatch(/\.ai-prompt-form textarea[\s\S]*overflow-y:\s*auto/);
    expect(aiPromptingCss).toMatch(/\.ai-prompt-form[\s\S]*align-items:\s*end/);
    expect(dom.aiPromptWordCount.textContent).toBe("0 / 500");
    expect(dom.aiPromptWordCount.classList.contains("hidden")).toBe(true);
  });

  test("custom: text more button opens Copy/Paste/Link menu", async () => {
    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, render } = __testHooks;

    seedStudioEditorState(state);
    state.isTextSelected = true;
    render();

    expect(dom.textMoreMenu.classList.contains("hidden")).toBe(true);

    dom.textMoreCta.click();

    expect(state.showTextMore).toBe(true);
    expect(dom.textMoreMenu.classList.contains("hidden")).toBe(false);
    expect(dom.textMoreCta.getAttribute("aria-expanded")).toBe("true");
  });

  test("custom: AI prompt textarea expands as the user types", async () => {
    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, render } = __testHooks;

    seedStudioEditorState(state);
    render();

    Object.defineProperty(dom.aiPromptInput, "scrollHeight", {
      configurable: true,
      value: 96,
    });

    dom.aiPromptCta.click();
    dom.aiPromptInput.value = "line one\nline two\nline three";
    dom.aiPromptInput.dispatchEvent(new Event("input", { bubbles: true }));

    expect(dom.aiPromptInput.style.height).toBe("96px");
  });

  test("custom: AI prompt enforces a 500 character limit and updates counter", async () => {
    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, render } = __testHooks;

    seedStudioEditorState(state);
    render();

    const characters = "a".repeat(505);

    dom.aiPromptCta.click();
    dom.aiPromptInput.value = characters;
    dom.aiPromptInput.dispatchEvent(new Event("input", { bubbles: true }));

    expect(dom.aiPromptInput.value).toHaveLength(500);
    expect(dom.aiPromptWordCount.textContent).toBe("500 / 500");
    expect(dom.aiPromptWordCount.classList.contains("hidden")).toBe(false);
    expect(dom.aiPromptWordCount.classList.contains("is-at-limit")).toBe(true);
  });

  test("custom: AI prompt counter appears only within 50 characters of the limit", async () => {
    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, render } = __testHooks;

    seedStudioEditorState(state);
    render();

    dom.aiPromptCta.click();
    dom.aiPromptInput.value = "a".repeat(449);
    dom.aiPromptInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(dom.aiPromptWordCount.classList.contains("hidden")).toBe(true);

    dom.aiPromptInput.value = "a".repeat(450);
    dom.aiPromptInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(dom.aiPromptWordCount.textContent).toBe("450 / 500");
    expect(dom.aiPromptWordCount.classList.contains("hidden")).toBe(false);
    expect(dom.aiPromptWordCount.classList.contains("is-at-limit")).toBe(false);
  });

  test("custom: AI prompt bottom sheet tracks mobile keyboard viewport offset", async () => {
    const visualViewport = new EventTarget();
    visualViewport.height = 500;
    visualViewport.offsetTop = 0;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: 800,
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: visualViewport,
    });

    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, render } = __testHooks;

    seedStudioEditorState(state);
    render();

    dom.aiPromptCta.click();
    visualViewport.dispatchEvent(new Event("resize"));

    expect(dom.uploadPage.style.getPropertyValue("--ai-prompt-keyboard-offset")).toBe("300px");
  });

  test("custom: AI prompt submit renders load mode until async placeholder resolves", async () => {
    let resolvePrompt;
    globalThis.__MEMEBRO_AI_PROMPT_REQUEST__ = vi.fn(() => new Promise((resolve) => {
      resolvePrompt = resolve;
    }));

    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, render } = __testHooks;

    seedStudioEditorState(state);
    render();

    dom.aiPromptCta.click();
    dom.aiPromptInput.value = "make it more dramatic";
    dom.aiPromptForm.requestSubmit();

    expect(state.aiPrompt.requestState).toBe("submitting");
    expect(dom.aiPromptLoadMode.classList.contains("hidden")).toBe(false);
    expect(dom.aiPromptLoadMessage.textContent).toBe("Generating your meme variant…");

    resolvePrompt({ text: "Placeholder response" });
    await vi.waitFor(() => {
      expect(state.aiPrompt.requestState).toBe("idle");
      expect(dom.aiPromptLoadMode.classList.contains("hidden")).toBe(true);
      expect(dom.aiPromptHistory.textContent).toContain("Placeholder response");
    });
  });

  test.each([
    ["FEATURE_DISABLED", "temporarily unavailable"],
    ["QUEUE_FULL", "heavy load"],
    ["RATE_LIMITED", "rate-limiting"],
  ])("custom: AI prompt handles %s with friendly retry UI", async (code, copy) => {
    let calls = 0;
    globalThis.__MEMEBRO_AI_PROMPT_REQUEST__ = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error(`${code}: raw backend message`);
        error.code = code;
        throw error;
      }
      return { text: "Retry worked" };
    });

    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, render } = __testHooks;

    seedStudioEditorState(state);
    render();

    dom.aiPromptCta.click();
    dom.aiPromptInput.value = "make a variant";
    dom.aiPromptForm.requestSubmit();

    await vi.waitFor(() => {
      expect(dom.aiPromptLoadMode.classList.contains("hidden")).toBe(false);
      expect(dom.aiPromptRetryCta.classList.contains("hidden")).toBe(false);
      expect(dom.aiPromptLoadMessage.textContent).toContain(copy);
    });

    dom.aiPromptRetryCta.click();

    await vi.waitFor(() => {
      expect(calls).toBe(2);
      expect(dom.aiPromptHistory.textContent).toContain("Retry worked");
      expect(dom.aiPromptLoadMode.classList.contains("hidden")).toBe(true);
    });
  });

  test("custom: acute load errors show retry UI and retry face swap", async () => {
    mockFaceCropCanvas("image/png");
    let processCalls = 0;
    global.fetch = vi.fn(async (url) => {
      if (url === "/templates.json") {
        return { json: async () => ({ templates: catalog.templates }) };
      }
      if (url === "/api/process") {
        processCalls += 1;
        if (processCalls === 1) {
          return {
            ok: false,
            status: 503,
            json: async () => ({ code: "QUEUE_FULL", message: "queue saturated" }),
          };
        }
        return { ok: true, json: async () => ({ generatedImageUrl: "/generated/retry.png" }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, render } = __testHooks;

    seedStudioEditorState(state);
    state.status = "ready";
    seedSelectedFaceCrop(state, {
      face: { id: "face-0", boxNatural: { x: 0, y: 0, width: 10, height: 10 } },
    });
    render();

    dom.continueBtn.click();

    await vi.waitFor(() => {
      expect(dom.errorState.classList.contains("hidden")).toBe(false);
    });
    expect(dom.errorMessage.textContent).toContain("heavy load");
    expect(dom.errorRetryCta.classList.contains("hidden")).toBe(false);

    dom.errorRetryCta.click();

    await vi.waitFor(() => {
      expect(processCalls).toBe(2);
      expect(state.editor.generatedImage).toBe("/generated/retry.png");
    });
    expect(dom.errorRetryCta.classList.contains("hidden")).toBe(true);
  });

  test("custom: save button is owned by recents and does not also download a PNG", async () => {
    mockRecentThumbnailExport();
    globalThis.__MEMEBRO_EXPORT_BLOB__ = vi.fn(async () => new Blob(["png"], { type: "image/png" }));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:memebro-download");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, render } = __testHooks;

    seedStudioEditorState(state);
    state.editor.generatedImage = "/generated/save-only-recents.png";
    render();
    dom.saveCta.click();

    await vi.waitFor(() => {
      expect(JSON.parse(localStorage.getItem("recent-memes"))).toHaveLength(1);
    });
    expect(globalThis.__MEMEBRO_EXPORT_BLOB__).not.toHaveBeenCalled();
  });

  test("custom: studio actions use Face Swap label and keep project utilities in a menu", async () => {
    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, render } = __testHooks;

    seedStudioEditorState(state);
    render();

    expect(dom.openUploadModalCta.textContent).toContain("Face Swap");
    expect(dom.projectMenu.classList.contains("hidden")).toBe(true);

    dom.projectMenuCta.click();

    expect(dom.projectMenu.classList.contains("hidden")).toBe(false);
    expect(dom.projectMenuCta.getAttribute("aria-expanded")).toBe("true");
    expect(dom.exportProjectCta.textContent).toContain("Export");
    expect(dom.importProjectCta.textContent).toContain("Import");
  });

  test("custom: canvas exporter composites the base image and text layers to a PNG blob", async () => {
    const drawImage = vi.fn();
    const fillText = vi.fn();
    const strokeText = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      fillText,
      strokeText,
      measureText: (text) => ({ width: String(text).length * 10 }),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      set font(value) { this._font = value; },
      get font() { return this._font; },
      set textAlign(value) { this._textAlign = value; },
      set textBaseline(value) { this._textBaseline = value; },
      set fillStyle(value) { this._fillStyle = value; },
      get fillStyle() { return this._fillStyle; },
      set lineJoin(value) { this._lineJoin = value; },
      set lineWidth(value) { this._lineWidth = value; },
      get lineWidth() { return this._lineWidth || 0; },
      set strokeStyle(value) { this._strokeStyle = value; },
    });
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function toBlob(callback, type) {
      callback(new Blob(["exported"], { type }));
    });
    vi.stubGlobal("Image", class MockImage {
      set src(value) {
        this._src = value;
        this.onload?.();
      }
      get src() {
        return this._src;
      }
    });

    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, render } = __testHooks;
    const { exportCanvasBlob } = await import("../public/lib/projectActions.js");

    seedStudioEditorState(state);
    state.editor.templateImage = "/assets/memes/placeholder.svg";
    state.editor.overlayText = "EXPORT ME";
    dom.studioTemplateArt.getBoundingClientRect = () => ({ width: 320, height: 240 });
    render();

    const blob = await exportCanvasBlob({ dom, state });

    expect(blob.type).toBe("image/png");
    expect(drawImage).toHaveBeenCalled();
    expect(fillText).toHaveBeenCalledWith("EXPORT ME", 0, expect.any(Number), expect.any(Number));
    expect(strokeText).toHaveBeenCalledWith("EXPORT ME", 0, expect.any(Number), expect.any(Number));
  });

  test("custom: project actions share with Web Share when available", async () => {
    const share = vi.fn(async () => {});
    globalThis.__MEMEBRO_EXPORT_BLOB__ = vi.fn(async () => new Blob(["png"], { type: "image/png" }));
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    Object.defineProperty(navigator, "canShare", { configurable: true, value: vi.fn(() => true) });

    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, render } = __testHooks;

    seedStudioEditorState(state);
    render();
    dom.shareCta.click();

    await vi.waitFor(() => {
      expect(share).toHaveBeenCalledWith(expect.objectContaining({
        title: "MemeBro meme",
        files: [expect.any(File)],
      }));
    });
  });

  test("custom: project actions fall back to download when Web Share is unavailable", async () => {
    globalThis.__MEMEBRO_EXPORT_BLOB__ = vi.fn(async () => new Blob(["png"], { type: "image/png" }));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:memebro-share");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });

    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, render } = __testHooks;

    seedStudioEditorState(state);
    render();
    dom.shareCta.click();

    await vi.waitFor(() => {
      expect(click).toHaveBeenCalled();
      expect(state.saveStatusMessage).toBe("Downloaded");
    });
  });

  test("custom: project export and import round-trip MemeBro JSON", async () => {
    let exportedBlob;
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      exportedBlob = blob;
      return "blob:memebro-project";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, render, projectActions } = __testHooks;

    seedStudioEditorState(state);
    state.editor.overlayText = "ROUND TRIP";
    state.editor.generatedImage = "/generated/project.png";
    render();

    dom.exportProjectCta.click();

    const exported = JSON.parse(await exportedBlob.text());
    expect(exported.version).toBe(1);
    expect(exported.baseImage.generatedImage).toBe("/generated/project.png");
    expect(exported.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "ROUND TRIP" }),
    ]));

    state.editor.overlayText = "changed";
    await projectActions.importProjectFile(new File([JSON.stringify(exported)], "meme.memebro.json", { type: "application/json" }));

    expect(state.view).toBe("studio");
    expect(state.editor.overlayText).toBe("ROUND TRIP");
    expect(state.editor.generatedImage).toBe("/generated/project.png");
  });

  test("custom: project import rejects external image sources", async () => {
    const { __testHooks } = await loadApp();
    await settleApp();
    const { projectActions } = __testHooks;
    const unsafeProject = {
      version: 1,
      selectedTemplateId: "drake",
      baseImage: {
        templateImage: "https://tracker.example/image.png",
        generatedImage: "",
      },
      layers: [],
      editor: {
        selectedTemplateId: "drake",
        templateImage: "https://tracker.example/image.png",
        generatedImage: "",
      },
    };

    await expect(projectActions.importProjectFile(
      new File([JSON.stringify(unsafeProject)], "unsafe.memebro.json", { type: "application/json" })
    )).rejects.toThrow(/unsupported image sources/i);
  });

  test("custom: project autosave is throttled, updates status, and restores after reload", async () => {
    vi.useFakeTimers();
    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, render } = __testHooks;

    seedStudioEditorState(state);
    state.editor.overlayText = "autosaved text";
    render();

    expect(state.saveStatusMessage).toBe("Saving...");
    expect(localStorage.getItem("memebro-project-autosave")).toBeNull();

    await vi.advanceTimersByTimeAsync(499);
    expect(localStorage.getItem("memebro-project-autosave")).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    const raw = localStorage.getItem("memebro-project-autosave");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw).editor.overlayText).toBe("autosaved text");
    expect(state.saveStatusMessage).toBe("Saved");

    vi.resetModules();
    mountAppHtml();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: localStorage,
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: localStorage,
    });

    const reloaded = await loadApp();
    await settleApp();
    expect(reloaded.__testHooks.state.view).toBe("studio");
    expect(reloaded.__testHooks.state.editor.overlayText).toBe("autosaved text");
  });

  test("custom: project autosave reports failed when storage is unavailable", async () => {
    vi.useFakeTimers();
    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, render } = __testHooks;

    localStorage.setItem.mockImplementation(() => {
      throw new Error("storage full");
    });

    seedStudioEditorState(state);
    state.editor.overlayText = "cannot save";
    render();
    await vi.advanceTimersByTimeAsync(500);

    expect(state.saveStatusMessage).toBe("Failed");
    expect(state.saveStatus).toBe("failed");
  });

  test("custom: export uses natural image dimensions instead of display size", async () => {
    const drawImage = vi.fn();
    const clearRect = vi.fn();
    const fillRect = vi.fn();
    const fillText = vi.fn();
    const strokeText = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
      clearRect,
      fillRect,
      fillText,
      strokeText,
      measureText: (text) => ({ width: String(text).length * 10 }),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      set font(value) { this._font = value; },
      get font() { return this._font; },
      set textAlign(value) { this._textAlign = value; },
      set textBaseline(value) { this._textBaseline = value; },
      set fillStyle(value) { this._fillStyle = value; },
      get fillStyle() { return this._fillStyle; },
      set lineJoin(value) { this._lineJoin = value; },
      set lineWidth(value) { this._lineWidth = value; },
      get lineWidth() { return this._lineWidth || 0; },
      set strokeStyle(value) { this._strokeStyle = value; },
    });
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function toBlob(callback, type) {
      callback(new Blob(["exported"], { type }));
    });
    vi.stubGlobal("Image", class MockImage {
      set src(value) {
        this._src = value;
        this.onload?.();
      }
      get src() { return this._src; }
    });

    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, render } = __testHooks;
    const { exportCanvasBlob } = await import("../public/lib/projectActions.js");

    seedStudioEditorState(state);
    state.editor.templateImage = "/assets/memes/placeholder.svg";

    Object.defineProperty(dom.studioTemplateImage, "naturalWidth", { value: 1920, configurable: true });
    Object.defineProperty(dom.studioTemplateImage, "naturalHeight", { value: 1080, configurable: true });
    dom.studioTemplateArt.getBoundingClientRect = () => ({ width: 320, height: 180 });
    render();

    const blob = await exportCanvasBlob({ dom, state });

    expect(blob.type).toBe("image/png");
    const widthSpy = vi.spyOn(HTMLCanvasElement.prototype, "width", "set");
    const heightSpy = vi.spyOn(HTMLCanvasElement.prototype, "height", "set");
    await exportCanvasBlob({ dom, state });
    const setWidthCalls = widthSpy.mock.calls;
    const setHeightCalls = heightSpy.mock.calls;
    expect(setWidthCalls[setWidthCalls.length - 1][0]).toBe(1920);
    expect(setHeightCalls[setHeightCalls.length - 1][0]).toBe(1080);
  });

  test("custom: export calls clearRect before drawing to preserve transparency", async () => {
    const clearRect = vi.fn();
    const drawImage = vi.fn();
    const fillRect = vi.fn();
    const callOrder = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: (...args) => { callOrder.push("clearRect"); clearRect(...args); },
      drawImage: (...args) => { callOrder.push("drawImage"); drawImage(...args); },
      fillRect: (...args) => { callOrder.push("fillRect"); fillRect(...args); },
      fillText: vi.fn(),
      strokeText: vi.fn(),
      measureText: (text) => ({ width: String(text).length * 10 }),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      set font(value) { this._font = value; },
      get font() { return this._font; },
      set textAlign(value) { this._textAlign = value; },
      set textBaseline(value) { this._textBaseline = value; },
      set fillStyle(value) { this._fillStyle = value; },
      get fillStyle() { return this._fillStyle; },
      set lineJoin(value) { this._lineJoin = value; },
      set lineWidth(value) { this._lineWidth = value; },
      get lineWidth() { return this._lineWidth || 0; },
      set strokeStyle(value) { this._strokeStyle = value; },
    });
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function toBlob(callback, type) {
      callback(new Blob(["exported"], { type }));
    });
    vi.stubGlobal("Image", class MockImage {
      set src(value) { this._src = value; this.onload?.(); }
      get src() { return this._src; }
    });

    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, render } = __testHooks;
    const { exportCanvasBlob } = await import("../public/lib/projectActions.js");

    seedStudioEditorState(state);
    state.editor.templateImage = "/assets/memes/placeholder.svg";
    dom.studioTemplateArt.getBoundingClientRect = () => ({ width: 320, height: 240 });
    render();

    await exportCanvasBlob({ dom, state, type: "image/png" });

    expect(clearRect).toHaveBeenCalled();
    expect(drawImage).toHaveBeenCalled();
    expect(callOrder.indexOf("clearRect")).toBeLessThan(callOrder.indexOf("drawImage"));
    expect(fillRect).not.toHaveBeenCalled();
  });

  test("custom: JPEG export fills white background before drawing image", async () => {
    const fillRect = vi.fn();
    const clearRect = vi.fn();
    const drawImage = vi.fn();
    const fillStyles = [];
    const callOrder = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: (...args) => { callOrder.push("clearRect"); clearRect(...args); },
      drawImage: (...args) => { callOrder.push("drawImage"); drawImage(...args); },
      fillRect: (...args) => { callOrder.push("fillRect"); fillRect(...args); },
      fillText: vi.fn(),
      strokeText: vi.fn(),
      measureText: (text) => ({ width: String(text).length * 10 }),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      set font(value) { this._font = value; },
      get font() { return this._font; },
      set textAlign(value) { this._textAlign = value; },
      set textBaseline(value) { this._textBaseline = value; },
      set fillStyle(value) { this._fillStyle = value; fillStyles.push(value); },
      get fillStyle() { return this._fillStyle; },
      set lineJoin(value) { this._lineJoin = value; },
      set lineWidth(value) { this._lineWidth = value; },
      get lineWidth() { return this._lineWidth || 0; },
      set strokeStyle(value) { this._strokeStyle = value; },
    });
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function toBlob(callback, type) {
      callback(new Blob(["exported"], { type }));
    });
    vi.stubGlobal("Image", class MockImage {
      set src(value) { this._src = value; this.onload?.(); }
      get src() { return this._src; }
    });

    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, render } = __testHooks;
    const { exportCanvasBlob } = await import("../public/lib/projectActions.js");

    seedStudioEditorState(state);
    state.editor.templateImage = "/assets/memes/placeholder.svg";
    dom.studioTemplateArt.getBoundingClientRect = () => ({ width: 320, height: 240 });
    render();

    await exportCanvasBlob({ dom, state, type: "image/jpeg" });

    expect(clearRect).toHaveBeenCalled();
    expect(fillRect).toHaveBeenCalled();
    expect(fillStyles).toContain("#ffffff");
    expect(callOrder.indexOf("fillRect")).toBeLessThan(callOrder.indexOf("drawImage"));
  });

  test("custom: file input rejects non-image files and shows error", async () => {
    const { __testHooks } = await loadApp();
    await settleApp();
    const { state, dom, render } = __testHooks;

    const pdfFile = new File(["fake pdf"], "document.pdf", { type: "application/pdf" });
    Object.defineProperty(dom.libraryInput, "files", {
      configurable: true,
      get() { return [pdfFile]; },
    });
    dom.libraryInput.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      expect(state.error).not.toBeNull();
      expect(state.error.code).toBe("INVALID_FILE_TYPE");
      expect(state.error.message).toContain("image file");
    });
  });
});
