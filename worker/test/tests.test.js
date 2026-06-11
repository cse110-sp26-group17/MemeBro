/**
 * @vitest-environment jsdom
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import catalog from "../public/templates.json";
import { RECENTS_STORAGE_KEY } from "../public/lib/constants.js";

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
const { templates, grid } = catalog;
const { imageLoading, search } = grid;

/**
 * Mounts the app's main HTML markup into the jsdom document.
 *
 * @returns {void}
 */
function mountAppHtml() {
  const mainMarkup = indexHtml.match(/<main[\s\S]*<\/main>/)?.[0] || "";
  document.body.innerHTML = mainMarkup;
}

/**
 * Sets the jsdom viewport dimensions used by responsive app code.
 *
 * @param {number} width - Viewport width in pixels.
 * @param {number} [height=800] - Viewport height in pixels.
 * @returns {void}
 */
function setViewport(width, height = 800) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });

  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    writable: true,
    value: height,
  });
}

/**
 * Creates an in-memory Storage-compatible object for localStorage tests.
 *
 * @returns {{clear: Function, getItem: Function, removeItem: Function, setItem: Function}} Mock storage API.
 */
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

/**
 * Dynamically imports the app after the DOM fixture has been mounted.
 *
 * @returns {Promise<object>} The app test hooks exported by app.js.
 */
async function loadApp() {
  const { __testHooks } = await import("../public/app.js");
  return __testHooks;
}

/**
 * Waits for queued promise microtasks used by app rendering to settle.
 *
 * @returns {Promise<void>} Resolves after two microtask turns.
 */
async function settleApp() {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Opens the real template grid through the app's start button.
 *
 * @param {number} width - Viewport width to render under.
 * @returns {Promise<object>} App test hooks plus measured render time.
 */
async function renderGrid(width) {
  setViewport(width);
  const app = await loadApp();
  await settleApp();

  const start = performance.now();
  app.dom.titleStartCta.click();
  await settleApp();
  await settleApp();

  return {
    ...app,
    renderTimeMs: performance.now() - start,
  };
}

/**
 * Gets rendered template card elements from the real app grid.
 *
 * @param {object} dom - App DOM references from __testHooks.
 * @returns {HTMLElement[]} Rendered template cards.
 */
function getTemplateCards(dom) {
  return [...dom.templateGrid.querySelectorAll(".template-card")];
}

/**
 * Gets template IDs from the currently rendered app grid.
 *
 * @param {object} dom - App DOM references from __testHooks.
 * @returns {Array<string | undefined>} Template IDs in rendered order.
 */
function getTemplateIds(dom) {
  return getTemplateCards(dom).map((card) => card.dataset.templateId);
}

/**
 * Sorts catalog templates by popularity, matching the app's trending order.
 *
 * @returns {Array<object>} Templates ordered by descending popularity.
 */
function getTrendingTemplates() {
  return [...templates].sort(
    (left, right) => right.popularityScore - left.popularityScore
  );
}

/**
 * Reads recently used template IDs from localStorage in newest-first order.
 *
 * @returns {string[]} Recently used template IDs.
 */
function getRecentUsageIds() {
  const parsed = JSON.parse(localStorage.getItem(RECENTS_STORAGE_KEY) || "{}");
  return Object.entries(parsed)
    .sort((left, right) => right[1] - left[1])
    .map(([templateId]) => templateId);
}

/**
 * Recursively asserts that required catalog fields are populated.
 *
 * @param {*} value - Value to inspect.
 * @param {string} path - Human-readable path used in assertion output.
 * @returns {void}
 */
function assertNoEmptyValues(value, path) {
  expect(value).not.toBeUndefined();
  expect(value).not.toBeNull();

  if (typeof value === "string") {
    expect(value.trim()).not.toBe("");
    return;
  }

  if (Array.isArray(value)) {
    if (path.endsWith(".faceRegions")) return;

    expect(value.length).toBeGreaterThan(0);
    value.forEach((entry, index) =>
      assertNoEmptyValues(entry, `${path}[${index}]`)
    );
    return;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value);
    expect(entries.length).toBeGreaterThan(0);

    entries.forEach(([key, nestedValue]) =>
      assertNoEmptyValues(nestedValue, `${path}.${key}`)
    );
  }
}

/**
 * Verifies the real app template grid behavior through app.js rendering paths.
 *
 * Covers responsive rendering, search, tab switching, recent template usage,
 * trending order, image source selection, and catalog data completeness.
 */
describe("Grid UI", () => {
  beforeEach(() => {
    vi.resetModules();
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
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (url === "/templates.json") {
        return { json: async () => ({ templates: catalog.templates }) };
      }
      return { ok: true, json: async () => ({}) };
    }));
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  test("renders properly in desktop resolution", async () => {
    const { dom, state } = await renderGrid(1440);
    const cards = getTemplateCards(dom);
    const firstCaption = cards[0].querySelector(".template-name");

    expect(window.innerWidth).toBe(1440);
    expect(state.view).toBe("templates");
    expect(cards).toHaveLength(templates.length);
    expect(firstCaption.textContent).toBe(getTrendingTemplates()[0].name);
  });

  test("renders properly in mobile resolution", async () => {
    const { dom, state } = await renderGrid(390);
    const cards = getTemplateCards(dom);
    const firstCaption = cards[0].querySelector(".template-name");

    expect(window.innerWidth).toBe(390);
    expect(state.view).toBe("templates");
    expect(cards).toHaveLength(templates.length);
    expect(firstCaption.textContent).toBe(getTrendingTemplates()[0].name);
  });

  test.each([
    ["desktop", 1440],
    ["mobile", 390],
  ])("renders in under 1.5 seconds on %s", async (_label, width) => {
    const { renderTimeMs } = await renderGrid(width);

    expect(renderTimeMs).toBeLessThanOrEqual(imageLoading.maxInitialLoadMs);
  });

  test("loads preview images instead of full-resolution images", async () => {
    const { dom } = await renderGrid(1440);
    const images = [...dom.templateGrid.querySelectorAll(".template-art-image")];

    expect(images).toHaveLength(getTrendingTemplates().length);

    images.forEach((image, index) => {
      const meme = getTrendingTemplates()[index];
      const expectedPreview = meme.previewImage || meme.images.preview;

      expect(image.getAttribute("src")).toBe(expectedPreview);
      expect(image.getAttribute("src")).not.toBe(meme.images.main);
    });
  });

  test("loads the correct meme name underneath each image", async () => {
    const { dom } = await renderGrid(1440);
    const cards = getTemplateCards(dom);

    expect(cards).toHaveLength(getTrendingTemplates().length);

    cards.forEach((card, index) => {
      const image = card.querySelector(".template-art-image");
      const caption = card.querySelector(".template-name");
      const meme = getTrendingTemplates()[index];

      expect(image.alt).toBe(meme.name);
      expect(caption.textContent).toBe(meme.name);
    });
  });

  test("renders the search bar at the top of the grid", async () => {
    const { dom } = await renderGrid(1440);

    expect(search.enabled).toBe(true);
    expect(dom.templateSearch.getAttribute("placeholder")).toBe("Search templates");
    expect(dom.templateSearch.closest(".template-controls")).not.toBeNull();
    expect(dom.templateSearch.closest(".template-controls").nextElementSibling).toBe(dom.templateGrid);
  });

  test("filters memes by name in real time by hiding non-matching results", async () => {
    const { dom } = await renderGrid(1440);

    dom.templateSearch.value = "drake";
    dom.templateSearch.dispatchEvent(new Event("input", { bubbles: true }));
    await settleApp();

    const visibleCards = getTemplateCards(dom);
    expect(visibleCards).toHaveLength(1);
    expect(visibleCards[0].dataset.templateId).toBe("drake-hotline-bling");
  });

  test("filters memes by tag in real time by hiding non-matching results", async () => {
    const { dom } = await renderGrid(1440);

    dom.templateSearch.value = "pokemon";
    dom.templateSearch.dispatchEvent(new Event("input", { bubbles: true }));
    await settleApp();

    const visibleCards = getTemplateCards(dom);
    expect(visibleCards).toHaveLength(1);
    expect(visibleCards[0].dataset.templateId).toBe("surprised-pikachu");
  });

  test("restores all memes when the search query is cleared", async () => {
    const { dom } = await renderGrid(1440);

    dom.templateSearch.value = "reaction";
    dom.templateSearch.dispatchEvent(new Event("input", { bubbles: true }));
    await settleApp();
    dom.templateSearch.value = "";
    dom.templateSearch.dispatchEvent(new Event("input", { bubbles: true }));
    await settleApp();

    const visibleCards = getTemplateCards(dom);
    expect(visibleCards).toHaveLength(getTrendingTemplates().length);
  });

  test("applies search results in under 500ms", async () => {
    const { dom } = await renderGrid(1440);

    dom.templateSearch.value = "reaction";
    const start = performance.now();
    dom.templateSearch.dispatchEvent(new Event("input", { bubbles: true }));
    await settleApp();

    expect(performance.now() - start).toBeLessThanOrEqual(search.maxFilterResponseMs);
  });

  test("is able to switch between tabs", async () => {
    const { dom, state } = await renderGrid(1440);
    const recentsTab = dom.templateTabs.querySelector("[data-tab='recents']");
    const trendingTab = dom.templateTabs.querySelector("[data-tab='trending']");

    expect(state.activeTemplateTab).toBe("trending");
    expect(getTemplateCards(dom)).toHaveLength(templates.length);

    recentsTab.click();
    await settleApp();

    expect(state.activeTemplateTab).toBe("recents");
    expect(getTemplateCards(dom)).toHaveLength(0);

    trendingTab.click();
    await settleApp();

    expect(state.activeTemplateTab).toBe("trending");
    expect(getTemplateCards(dom)).toHaveLength(templates.length);
  });

  test("clicking templates does not add them to recents", async () => {
    let currentTime = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => {
      currentTime += 1_000;
      return currentTime;
    });

    const firstSession = await renderGrid(1440);
    let trendingCards = getTemplateCards(firstSession.dom);

    trendingCards[4].click();
    firstSession.state.view = "templates";
    await firstSession.renderTemplates();
    trendingCards = getTemplateCards(firstSession.dom);
    trendingCards[2].click();
    firstSession.state.view = "templates";
    await firstSession.renderTemplates();
    trendingCards = getTemplateCards(firstSession.dom);
    trendingCards[0].click();

    vi.resetModules();
    mountAppHtml();
    await renderGrid(1440);

    expect(getRecentUsageIds()).toEqual([]);
  });

  test("trending tab is consistent across sessions", async () => {
    const firstSession = await renderGrid(1440);
    const firstTrendingOrder = getTemplateIds(firstSession.dom);

    vi.resetModules();
    mountAppHtml();
    const secondSession = await renderGrid(1440);
    const secondTrendingOrder = getTemplateIds(secondSession.dom);

    expect(secondTrendingOrder).toEqual(firstTrendingOrder);
  });

  test("memes in trending tab are ordered by descending popularity", async () => {
    const { dom } = await renderGrid(1440);
    const popularityScores = getTemplateIds(dom).map((templateId) => {
      const template = templates.find((entry) => entry.id === templateId);
      return template.popularityScore;
    });

    const sortedScores = [...popularityScores].sort((left, right) => right - left);

    expect(popularityScores).toEqual(sortedScores);
  });

  test("ensures none of the meme properties are empty", () => {
    templates.forEach((meme, index) => {
      assertNoEmptyValues(meme, `templates[${index}]`);
    });
  });
});
