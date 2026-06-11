/**
 * @vitest-environment jsdom
 */

import { describe, expect, test, vi } from "vitest";

import { saveCurrentMeme } from "../public/js/save.js";

describe("saveCurrentMeme", () => {
  test("builds a recent meme payload from the current editor state", async () => {
    const storage = {
      save: vi.fn(async (payload) => ({
        metadata: { id: "recent-1" },
        snapshot: payload,
      })),
    };
    const state = {
      isAiPromptPanelOpen: false,
      editor: {
        generatedImage: "/generated/meme.png",
        templateImage: "/templates/base.png",
        historyStack: [{ overlayText: "seed" }, { overlayText: "saved text" }],
        futureStack: [{ overlayText: "redo text" }],
      },
    };
    const dom = {
      studioTemplateImage: {
        currentSrc: "/generated/from-dom.png",
        src: "/generated/from-src.png",
      },
    };
    const createEditorSnapshot = vi.fn(() => ({
      selectedTemplateId: "drake-hotline-bling",
      templateImage: "/templates/base.png",
      generatedImage: "/generated/meme.png",
      overlayText: "saved text",
      overlayX: 12,
      overlayY: 34,
      overlayWidthPct: 56,
      overlayRotation: 90,
      overlayVisible: true,
      frozenTextItems: [{ text: "bottom text" }],
    }));

    const result = await saveCurrentMeme({
      state,
      dom,
      createEditorSnapshot,
      storage,
      savedAt: 1234,
    });

    expect(result.metadata.id).toBe("recent-1");
    expect(storage.save).toHaveBeenCalledWith({
      id: "template-drake-hotline-bling",
      currentImage: "/generated/meme.png",
      editorSnapshot: expect.objectContaining({
        overlayText: "saved text",
        generatedImage: "/generated/meme.png",
      }),
      historyStack: [{ overlayText: "seed" }, { overlayText: "saved text" }],
      futureStack: [{ overlayText: "redo text" }],
      textContent: {
        activeText: "saved text",
        frozenTextItems: [{ text: "bottom text" }],
      },
      transformation: {
        x: 12,
        y: 34,
        widthPct: 56,
        rotation: 90,
        visible: true,
      },
      mode: "face_swap",
      savedAt: 1234,
    });
    expect(createEditorSnapshot).toHaveBeenCalledTimes(1);
  });

  test("uses ai_prompt mode when the AI prompt panel is open", async () => {
    const storage = {
      save: vi.fn(async (payload) => ({ metadata: {}, snapshot: payload })),
    };

    await saveCurrentMeme({
      state: {
        isAiPromptPanelOpen: true,
        editor: {
          generatedImage: "",
          templateImage: "/templates/base.png",
          historyStack: [],
          futureStack: [],
        },
      },
      dom: {},
      createEditorSnapshot: () => ({
        templateImage: "/templates/base.png",
        overlayText: "prompt text",
      }),
      storage,
      savedAt: 5678,
    });

    expect(storage.save.mock.calls[0][0].mode).toBe("ai_prompt");
  });
});
