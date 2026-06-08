/**
 * @module app
 * Application entry point.
 * Imports all frontend modules, configures dependency injection for
 * the upload and face-detection subsystems, fetches the template
 * catalog, and starts the render loop.
 */

import { dom }                      from "./lib/dom.js";
import { loadTemplates, requestFaceSwap } from "./lib/api.js";
import {
  clearCameraStream, clearCameraReview, clearFaceFitState,
  decodeImage, applyManualTransform,
  enterManualMode, startManualFitFromSelection,
  startCameraCapture, snapCameraPhoto, useReviewedPhoto,
  flipCamera, goBackToUploadChoices,
  startManualDrag, moveManualDrag, configureUpload,
} from "./lib/upload.js";
import adapter from "./lib/faceDetect.js";

import {
  STATES, ALLOWED_TYPES, DETECTION_FAILURE_MESSAGES,
  DEFAULT_MEME_TEXT, DEFAULT_MEME_FONT_KEY, DEFAULT_MEME_FONT_SIZE_MODE,
  DEFAULT_MEME_TEXT_COLOR, DEFAULT_MEME_OUTLINE_ENABLED, DEFAULT_MEME_OUTLINE_COLOR,
  FACE_BOX_TAP_TARGET,
} from "./lib/constants.js";
import { state } from "./lib/state.js";

import * as Editor      from "./lib/editor.js";
import * as TextOverlay from "./lib/textOverlay.js";
import { recentMemeStorage } from "./js/recents.js";
import { saveCurrentMeme } from "./js/save.js";
import * as Templates   from "./lib/templates.js";
import * as Faces       from "./lib/faces.js";
import * as FaceSwap    from "./lib/faceSwap.js";
import * as Render      from "./lib/render.js";
import * as AiPrompting from "./lib/ai-prompting.js";
import * as ProjectActions from "./lib/projectActions.js";
import { registerEvents } from "./lib/events.js";

// ── Shared utilities ──────────────────────────

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function normalizeBox(boxNatural, natural, rendered) {
  return {
    x:      boxNatural.x      * (rendered.width  / natural.width),
    y:      boxNatural.y      * (rendered.height / natural.height),
    width:  boxNatural.width  * (rendered.width  / natural.width),
    height: boxNatural.height * (rendered.height / natural.height),
  };
}

function getRenderedSize() {
  const rect = dom.previewImage.getBoundingClientRect();
  return { width: rect.width || 320, height: rect.height || 320 };
}

// ── Status / error helpers ────────────────────

function setStatus(next) { state.status = next; render(); }

function setError(code, message) { state.error = { code, message }; setStatus(STATES.ERROR); }

function setDetectionRecoveryError(code) {
  state.error = {
    code,
    message: DETECTION_FAILURE_MESSAGES[code] || DETECTION_FAILURE_MESSAGES.DETECTION_FAILED,
  };
}

// ── Template wrappers ─────────────────────────

const getSelectedTemplate     = ()              => Templates.getSelectedTemplate();
const getTemplateFaceCapacity = ()              => Templates.getTemplateFaceCapacity();
const getTemplateMainImage    = (t)             => Templates.getTemplateMainImage(t);
const extractGeneratedImageUrl = (p)            => Templates.extractGeneratedImageUrl(p);
const recordTemplateUsage     = (id)            => Templates.recordTemplateUsage(id);
const renderStudioTemplate    = (t)             => Templates.renderStudioTemplate(t, { dom, state });
const renderTemplates         = ()              => Templates.renderTemplates({ dom, clamp, openStudioForTemplate, openStudioForRecentMeme });

async function showTemplateSelection() {
  return Templates.showTemplateSelection({ loadTemplates, dom, render, renderTemplates });
}

function openStudioForTemplate(templateId) {
  return Templates.openStudioForTemplate(templateId, {
    recordTemplateUsage,
    initializeEditorState,
    restoreEditorSession,
    persistEditorHistory: Editor.persistEditorHistory,
    render,
    STATES,
  });
}

async function openStudioForRecentMeme(recentMemeId) {
  const recent = await recentMemeStorage.get(recentMemeId);
  const snapshot = recent?.snapshot;
  const editorSnapshot = snapshot?.editorSnapshot;

  if (!snapshot || !editorSnapshot) return null;

  const restoredEditorSnapshot = {
    ...editorSnapshot,
    generatedImage: editorSnapshot.generatedImage || snapshot.currentImage || "",
  };

  state.selectedTemplateId = restoredEditorSnapshot.selectedTemplateId || state.selectedTemplateId;
  state.status = STATES.IDLE;
  state.view = "studio";
  state.uploadModalOpen = false;
  state.isEditingMemeText = false;
  state.isTextSelected = false;
  state.isTextLocked = false;
  state.showTextMore = false;
  state.showResetConfirmation = false;
  state.showBackConfirmation = false;
  state.isAiPromptPanelOpen = false;
  state.editor.historyStack = Array.isArray(snapshot.editHistory?.historyStack)
    ? [...snapshot.editHistory.historyStack]
    : [];
  state.editor.futureStack = Array.isArray(snapshot.editHistory?.futureStack)
    ? [...snapshot.editHistory.futureStack]
    : [];
  state.editor.initialSnapshot = state.editor.historyStack[0] || restoredEditorSnapshot;
  Editor.applyEditorSnapshot(restoredEditorSnapshot, { getTemplateMainImage });
  Editor.persistEditorHistory();
  render();
  return recent;
}

const getMemeFontFamily = (fontKey = DEFAULT_MEME_FONT_KEY) =>
  TextOverlay.getMemeFontFamily(fontKey);

const applyMemeOutline = (preview) =>
  TextOverlay.applyMemeOutline(preview);

const positionTextHandles = () =>
  TextOverlay.positionTextHandles({ dom, clamp });

const createOrSelectTextAtPointer = (event) =>
  TextOverlay.createOrSelectTextAtPointer(event, {
    dom,
    clamp,
    recordEditorSnapshot,
    beginInlineTextEdit,
  });
// ── Editor wrappers ───────────────────────────

const initializeEditorState  = ()  => Editor.initializeEditorState({ getTemplateMainImage, getSelectedTemplate });
const recordEditorSnapshot   = ()  => Editor.recordEditorSnapshot({ getTemplateMainImage, getSelectedTemplate });
const restoreEditorSession   = ()  => Editor.restoreEditorSession({ getTemplateMainImage });
const hasUnsavedStudioEdits  = ()  => Editor.hasUnsavedStudioEdits();
const undoEditorSnapshot     = ()  => Editor.undoEditorSnapshot({ getTemplateMainImage, render });
const redoEditorSnapshot     = ()  => Editor.redoEditorSnapshot({ getTemplateMainImage, render });
const resetEditorToTemplate  = ()  => Editor.resetEditorToTemplate({ getTemplateMainImage, getSelectedTemplate, render });
const confirmBackAndResetStudio = () => Editor.confirmBackAndResetStudio({ getTemplateMainImage, getSelectedTemplate, render, renderTemplates });

// ── Text overlay wrappers ─────────────────────

const getMemeTextColor        = (k) => TextOverlay.getMemeTextColor(k);
const getEditableTextValue    = (n) => TextOverlay.getEditableTextValue(n);
const syncOutlineSwatchState  = ()  => TextOverlay.syncOutlineSwatchState({ dom });
const syncMemeTextAppearance  = ()  => TextOverlay.syncMemeTextAppearance({ dom, clamp });
const fitMemeTextToCanvas     = ()  => TextOverlay.fitMemeTextToCanvas({ dom });
const renderFrozenTextItems   = ()  => TextOverlay.renderFrozenTextItems({ dom, clamp });
const freezeCurrentTextItem   = ()  => TextOverlay.freezeCurrentTextItem();
const selectFrozenTextItem    = (i) => TextOverlay.selectFrozenTextItem(i, { recordEditorSnapshot, render });
const deleteMemeText          = ()  => TextOverlay.deleteMemeText({ recordEditorSnapshot, render });
const finishInlineTextEdit    = ()  => TextOverlay.finishInlineTextEdit({ dom, recordEditorSnapshot, render });
const rotateTextOneStep       = (e) => TextOverlay.rotateTextOneStep(e, { recordEditorSnapshot, render });
const startTextDrag           = (e) => TextOverlay.startTextDrag(e, { dom });
const moveTextDrag            = (e) => TextOverlay.moveTextDrag(e, { dom, clamp, render });
const endTextDrag             = (e) => TextOverlay.endTextDrag(e, { recordEditorSnapshot });
const startTextResize         = (e) => TextOverlay.startTextResize(e);
const moveTextResize          = (e) => TextOverlay.moveTextResize(e, { dom, clamp, render });
const endTextResize           = (e) => TextOverlay.endTextResize(e, { recordEditorSnapshot });
const selectTextObject        = (e) => TextOverlay.selectTextObject(e, { render });
const updateEditorTextSetting = (k, v) => TextOverlay.updateEditorTextSetting(k, v, { recordEditorSnapshot, render });

function beginInlineTextEdit(event) {
  return TextOverlay.beginInlineTextEdit(event, { dom, render });
}

// ── Face wrappers ─────────────────────────────

const getFaceCropBounds       = (f, n) => Faces.getFaceCropBounds(f, n, { clamp });
const getFaceCropMimeType     = (f)    => Faces.getFaceCropMimeType(f);
const extractFaceCrop         = (b, f, o) => Faces.extractFaceCrop(b, f, o, { decodeImage, clamp });
const setSelectedFaceIds      = (ids) => Faces.setSelectedFaceIds(ids);
const selectSingleFace        = (id)  => Faces.selectSingleFace(id);
const getSelectedFaces        = ()    => Faces.getSelectedFaces();
const getSelectableFaceLimit  = ()    => Faces.getSelectableFaceLimit({ getTemplateFaceCapacity });

function toggleDetectedFaceSelection(faceId) {
  return Faces.toggleDetectedFaceSelection(faceId, { getTemplateFaceCapacity, getSelectableFaceLimit });
}

async function detectFaces(file) {
  return Faces.detectFaces(file, {
    adapter, decodeImage, clamp, normalizeBox,
    clearFaceFitState, enterManualMode,
    setStatus, setError, setDetectionRecoveryError,
    getRenderedSize, getTemplateFaceCapacity,
    selectSingleFace,
  });
}

// ── Face swap wrappers ────────────────────────

const startFaceSwapLoadingState = () => FaceSwap.startFaceSwapLoadingState({ render });
const stopFaceSwapLoadingState  = () => FaceSwap.stopFaceSwapLoadingState({ render });

/**
 * Saves the currently edited meme through the save module.
 *
 * @returns {Promise<{metadata: object, snapshot: object}>} Saved recent meme records.
 */
async function saveCurrentEditorMeme() {
  return saveCurrentMeme({
    state,
    dom,
    createEditorSnapshot: Editor.createEditorSnapshot,
  });
}

async function submitSelectedFace() {
  return FaceSwap.submitSelectedFace({
    state, getSelectedFaces, getSelectedTemplate,
    getFaceCropMimeType, extractFaceCrop, extractGeneratedImageUrl,
    requestFaceSwap, recordEditorSnapshot,
    startFaceSwapLoading: startFaceSwapLoadingState,
    stopFaceSwapLoading:  stopFaceSwapLoadingState,
    render, STATES,
  });
}

// ── Render ────────────────────────────────────

function renderOverlay() {
  return Render.renderOverlay({
    dom, state, normalizeBox, clamp,
    FACE_BOX_TAP_TARGET, toggleDetectedFaceSelection,
    getRenderedSize, render,
  });
}

function renderAiPromptHistory() {
  return AiPrompting.renderAiPromptHistory({ dom, state });
}

function renderAiPromptLoadMode() {
  return AiPrompting.renderAiPromptLoadMode({ dom, state });
}

function endDrag(event) {
  if (state.dragPointerId !== event.pointerId) return;
  event.preventDefault();
  state.dragPointerId = null;
  dom.previewImage.classList.remove("dragging");
}
function render() {
  const result = Render.render({
    dom, state,
    getSelectedTemplate, getSelectedFaces, getSelectableFaceLimit,
    renderStudioTemplate, renderFrozenTextItems,
    syncMemeTextAppearance, syncOutlineSwatchState,
    applyManualTransform: () => applyManualTransform(),
    renderOverlay, renderAiPromptHistory, renderAiPromptLoadMode,
    getMemeTextColor,
  });
  projectActions?.scheduleAutoSave();
  return result;
}

const projectActions = ProjectActions.configureProjectActions({
  dom, state, render,
  getTemplateMainImage,
  recordEditorSnapshot,
});

// ── Events ────────────────────────────────────

registerEvents({
  dom, state, STATES, clamp,
  // Camera / upload
  startCameraCapture, snapCameraPhoto, flipCamera,
  clearCameraStream, clearCameraReview,
  useReviewedPhoto, goBackToUploadChoices,
  startManualFitFromSelection, startManualDrag, moveManualDrag,
  configureUpload, detectFaces,
  applyManualTransform: () => applyManualTransform(),
  // Template
  showTemplateSelection, renderTemplates, openStudioForTemplate,
  // Text overlay
  createOrSelectTextAtPointer, selectTextObject, beginInlineTextEdit,
  finishInlineTextEdit, deleteMemeText, freezeCurrentTextItem,
  selectFrozenTextItem, updateEditorTextSetting,
  startTextDrag, moveTextDrag, endTextDrag,
  startTextResize, moveTextResize, endTextResize,
  rotateTextOneStep, syncMemeTextAppearance, syncOutlineSwatchState,
  getEditableTextValue,
  // Editor
  undoEditorSnapshot, redoEditorSnapshot, resetEditorToTemplate,
  confirmBackAndResetStudio, recordEditorSnapshot,
  // Save
  saveCurrentEditorMeme,
  // Face swap
  submitSelectedFace, startFaceSwapLoadingState, stopFaceSwapLoadingState,
  // Render
  render, renderOverlay,
  // Misc
  getSelectedFaces, selectSingleFace, getRenderedSize,
  hasUnsavedStudioEdits, normalizeBox, setStatus, setError,
  showToast,
});

// ── Test hooks (keep for test suite) ─────────

export const __testHooks = {
  dom,
  state,
  render,
  renderTemplates,
  setStatus,
  selectSingleFace,
  submitSelectedFace,
  saveCurrentEditorMeme,
  openStudioForRecentMeme,
  undoEditorSnapshot,
  redoEditorSnapshot,
  resetEditorToTemplate,
  beginInlineTextEdit,
  finishInlineTextEdit,
  startFaceSwapLoadingState,
  stopFaceSwapLoadingState,
  getFaceCropBounds,
  extractFaceCrop,
  syncMemeTextAppearance,
  fitMemeTextToCanvas,
  updateEditorTextSetting,
  projectActions,
};

// ── Toast helper ──────────────────────────────

function showToast(message, duration = 3000) {
  const el = document.createElement("div");
  el.className = "memebro-toast";
  el.textContent = message;
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("visible"));
  setTimeout(() => {
    el.classList.remove("visible");
    el.addEventListener("transitionend", () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  }, duration);
}

// ── Init ──────────────────────────────────────

async function init() {
  await Templates.loadTemplateCatalog({ loadTemplates });
  const restored = await projectActions.restoreAutoSave();

  const onboarded = (() => { try { return localStorage.getItem("memebro-onboarding-complete"); } catch (_) { return null; } })();
  if (onboarded) {
    await showTemplateSelection();
  } else {
    render();
  }
  if (restored) showToast("Welcome back! Restored your previous work.");

  // Save current state before the page unloads
  window.addEventListener("beforeunload", () => {
    projectActions.saveProjectNow();
  });
  // Bridge from the React scroll-morph hero island to the existing template flow.
  window.addEventListener('memebro:start', () => showTemplateSelection());

  // "Drop a meme" CTA — load the image directly into the studio editor,
  // skipping template selection entirely.
  window.addEventListener('memebro:launch-meme', (e) => {
    const dataUrl = e.detail?.dataUrl;
    if (!dataUrl) return;
    state.selectedTemplateId    = null;
    state.status                = STATES.IDLE;
    state.view                  = 'studio';
    state.uploadModalOpen       = false;
    state.isEditingMemeText     = false;
    state.showResetConfirmation = false;
    state.showBackConfirmation  = false;
    state.isTextSelected        = false;
    state.isTextLocked          = false;
    state.showTextMore          = false;
    state.editor.templateImage  = dataUrl;
    state.editor.generatedImage = '';
    state.editor.initialSnapshot = Editor.createEditorSnapshot({
      selectedTemplateId:    null,
      templateImage:         dataUrl,
      generatedImage:        '',
      overlayText:           DEFAULT_MEME_TEXT,
      overlayFontKey:        DEFAULT_MEME_FONT_KEY,
      overlaySizeMode:       DEFAULT_MEME_FONT_SIZE_MODE,
      overlayFontPx:         22,
      overlayTextColor:      DEFAULT_MEME_TEXT_COLOR,
      overlayOutlineEnabled: DEFAULT_MEME_OUTLINE_ENABLED,
      overlayOutlineColor:   DEFAULT_MEME_OUTLINE_COLOR,
      overlayBold:           false,
      overlayItalic:         false,
      overlayUnderline:      false,
      overlayX:              50,
      overlayY:              80,
      overlayWidthPct:       48,
      overlayRotation:       0,
      overlayVisible:        false,
      frozenTextItems:       [],
    });
    state.editor.historyStack   = [];
    state.editor.futureStack    = [];
    Editor.applyEditorSnapshot(state.editor.initialSnapshot, {
      getTemplateMainImage: () => dataUrl,
    });
    Editor.persistEditorHistory();
    render();
  });
}
init();
