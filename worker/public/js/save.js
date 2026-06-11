import { recentMemeStorage } from "./recents.js";

/**
 * Creates a deep clone of plain editor state data.
 *
 * @param {*} value - Value to clone.
 * @returns {*} Cloned value.
 */
function cloneData(value) {
  if (value == null) return value;
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Fall through to JSON cloning for plain editor state objects.
    }
  }
  return JSON.parse(JSON.stringify(value));
}

/**
 * Resolves the best image source to save for the current meme.
 *
 * @param {object} options - Current image dependencies.
 * @param {object} options.state - App state object.
 * @param {object} options.dom - App DOM references.
 * @param {object} options.editorSnapshot - Current editor snapshot.
 * @returns {string} Image URL or data URL to save.
 */
function getCurrentImage({ state, dom, editorSnapshot }) {
  return editorSnapshot.generatedImage
    || state.editor.generatedImage
    || dom?.studioTemplateImage?.currentSrc
    || dom?.studioTemplateImage?.src
    || editorSnapshot.templateImage
    || state.editor.templateImage
    || "";
}

/**
 * Determines which editor mode should be stored with the saved meme.
 *
 * @param {object} options - Mode resolution options.
 * @param {object} options.state - App state object.
 * @param {"face_swap" | "ai_prompt" | "text"} [options.mode] - Explicit mode override.
 * @returns {"face_swap" | "ai_prompt" | "text"} Editor mode to persist.
 */
function getEditorMode({ state, mode }) {
  if (mode) return mode;
  if (state.isAiPromptPanelOpen) return "ai_prompt";
  if (state.editor.generatedImage) return "face_swap";
  return "text";
}

/**
 * Extracts text content from an editor snapshot for the recents payload.
 *
 * @param {object} editorSnapshot - Current editor snapshot.
 * @returns {{activeText: string, frozenTextItems: Array<object>}} Text content state.
 */
function getTextContent(editorSnapshot) {
  return {
    activeText: editorSnapshot.overlayText || "",
    frozenTextItems: cloneData(editorSnapshot.frozenTextItems) || [],
  };
}

/**
 * Extracts transform fields from an editor snapshot for the recents payload.
 *
 * @param {object} editorSnapshot - Current editor snapshot.
 * @returns {{x: number, y: number, widthPct: number, rotation: number, visible: boolean}} Transform state.
 */
function getTransformation(editorSnapshot) {
  return {
    x: editorSnapshot.overlayX ?? 50,
    y: editorSnapshot.overlayY ?? 80,
    widthPct: editorSnapshot.overlayWidthPct ?? 48,
    rotation: editorSnapshot.overlayRotation ?? 0,
    visible: editorSnapshot.overlayVisible ?? false,
  };
}

function hashRecentSource(value = "") {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Builds a stable recents key so saving the same template updates one record.
 *
 * @param {object} options - Current save state.
 * @param {object} options.state - App state object.
 * @param {object} options.editorSnapshot - Current editor snapshot.
 * @returns {string} Stable recent meme ID.
 */
function getStableRecentMemeId({ state, editorSnapshot }) {
  const templateId = editorSnapshot.selectedTemplateId || state.selectedTemplateId;
  if (templateId) return `template-${templateId}`;

  const sourceImage = editorSnapshot.templateImage || state.editor.templateImage || editorSnapshot.generatedImage || state.editor.generatedImage || "";
  return `template-custom-${hashRecentSource(sourceImage)}`;
}

/**
 * Saves the current editor state as a recent meme.
 *
 * @param {object} options - Save dependencies and optional overrides.
 * @param {object} options.state - App state object.
 * @param {object} options.dom - App DOM references.
 * @param {Function} options.createEditorSnapshot - Function that returns the current editor snapshot.
 * @param {object} [options.storage=recentMemeStorage] - Recent meme storage adapter.
 * @param {"face_swap" | "ai_prompt" | "text"} [options.mode] - Explicit editor mode override.
 * @param {number} [options.savedAt=Date.now()] - Save timestamp.
 * @returns {Promise<{metadata: object, snapshot: object}>} Saved recent meme records.
 */
export async function saveCurrentMeme({
  state,
  dom,
  createEditorSnapshot,
  storage = recentMemeStorage,
  mode,
  savedAt = Date.now(),
}) {
  if (!state || !state.editor) {
    throw new Error("Editor state is required to save a meme.");
  }
  if (typeof createEditorSnapshot !== "function") {
    throw new Error("createEditorSnapshot is required to save a meme.");
  }

  const editorSnapshot = createEditorSnapshot();
  const currentImage = getCurrentImage({ state, dom, editorSnapshot });

  return storage.save({
    id: getStableRecentMemeId({ state, editorSnapshot }),
    currentImage,
    editorSnapshot,
    historyStack: cloneData(state.editor.historyStack) || [],
    futureStack: cloneData(state.editor.futureStack) || [],
    textContent: getTextContent(editorSnapshot),
    transformation: getTransformation(editorSnapshot),
    mode: getEditorMode({ state, mode }),
    savedAt,
  });
}

export const saveMeme = {
  saveCurrent: saveCurrentMeme,
};
