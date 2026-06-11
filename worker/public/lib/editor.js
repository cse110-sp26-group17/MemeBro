/**
 * @module editor
 * Editor history, snapshot, and session logic.
 * Manages undo/redo stacks, project autosave via IndexedDB, and
 * snapshot serialization for the meme editor state.
 */

import {
    DEFAULT_MEME_TEXT,
    EDITOR_HISTORY_STORAGE_KEY,
    DEFAULT_MEME_FONT_KEY,
    DEFAULT_MEME_FONT_SIZE_MODE,
    DEFAULT_MEME_TEXT_COLOR,
    DEFAULT_MEME_OUTLINE_ENABLED,
    DEFAULT_MEME_OUTLINE_COLOR,
} from "./constants.js";
import { state } from "./state.js";
import { idbSet, idbGet, idbRemoveSync, idbSetSync } from "./storage.js";

// ── Helpers ──────────────────────────────────

function cloneSnapshot(snapshot) {
    return JSON.parse(JSON.stringify(snapshot));
}

// ── Snapshot shape ───────────────────────────

/**
 * Creates a serializable snapshot of the current editor state.
 *
 * @param {object} [overrides={}] - Optional field overrides
 * @returns {object} Snapshot object suitable for JSON serialization
 */
export function createEditorSnapshot(overrides = {}) {
    return {
        selectedTemplateId: overrides.selectedTemplateId ?? state.selectedTemplateId ?? null,
        templateImage:      overrides.templateImage      ?? state.editor.templateImage,
        generatedImage:     overrides.generatedImage     ?? state.editor.generatedImage,
        overlayText:        overrides.overlayText        ?? state.editor.overlayText,
        overlayFontKey:     overrides.overlayFontKey     ?? state.editor.overlayFontKey,
        overlaySizeMode:    overrides.overlaySizeMode    ?? state.editor.overlaySizeMode,
        overlayFontPx:      overrides.overlayFontPx      ?? state.editor.overlayFontPx,
        overlayTextColor:   overrides.overlayTextColor   ?? state.editor.overlayTextColor,
        overlayOutlineEnabled: overrides.overlayOutlineEnabled ?? state.editor.overlayOutlineEnabled,
        overlayOutlineColor:   overrides.overlayOutlineColor   ?? state.editor.overlayOutlineColor,
        overlayBold:        overrides.overlayBold        ?? state.editor.overlayBold,
        overlayItalic:      overrides.overlayItalic      ?? state.editor.overlayItalic,
        overlayUnderline:   overrides.overlayUnderline   ?? state.editor.overlayUnderline,
        overlayX:           overrides.overlayX           ?? state.editor.overlayX,
        overlayY:           overrides.overlayY           ?? state.editor.overlayY,
        overlayWidthPct:    overrides.overlayWidthPct    ?? state.editor.overlayWidthPct,
        overlayRotation:    overrides.overlayRotation    ?? state.editor.overlayRotation,
        overlayVisible:     overrides.overlayVisible     ?? state.editor.overlayVisible,
        frozenTextItems:    overrides.frozenTextItems    ?? state.editor.frozenTextItems,
    };
}

/**
 * Applies a previously-saved snapshot back onto `state.editor`.
 *
 * @param {object} snapshot - Snapshot created by {@link createEditorSnapshot}
 * @param {object} deps
 * @param {() => string} deps.getTemplateMainImage - Fallback image resolver
 */
export function applyEditorSnapshot(snapshot, { getTemplateMainImage }) {
    if (!snapshot) return;
    state.editor.templateImage      = snapshot.templateImage || getTemplateMainImage();
    state.editor.generatedImage     = snapshot.generatedImage || "";
    state.editor.lastSavedRecentImage = snapshot.lastSavedRecentImage || "";
    state.editor.overlayText        = snapshot.overlayText ?? DEFAULT_MEME_TEXT;
    state.editor.overlayFontKey     = snapshot.overlayFontKey || DEFAULT_MEME_FONT_KEY;
    state.editor.overlaySizeMode    = snapshot.overlaySizeMode || DEFAULT_MEME_FONT_SIZE_MODE;
    state.editor.overlayFontPx      = Number.isFinite(snapshot.overlayFontPx) ? snapshot.overlayFontPx : 22;
    state.editor.overlayTextColor   = snapshot.overlayTextColor || DEFAULT_MEME_TEXT_COLOR;
    state.editor.overlayOutlineEnabled = snapshot.overlayOutlineEnabled ?? DEFAULT_MEME_OUTLINE_ENABLED;
    state.editor.overlayOutlineColor   = snapshot.overlayOutlineColor || DEFAULT_MEME_OUTLINE_COLOR;
    state.editor.overlayBold        = snapshot.overlayBold ?? false;
    state.editor.overlayItalic      = snapshot.overlayItalic ?? false;
    state.editor.overlayUnderline   = snapshot.overlayUnderline ?? false;
    state.editor.overlayX           = Number.isFinite(snapshot.overlayX) ? snapshot.overlayX : 50;
    state.editor.overlayY           = Number.isFinite(snapshot.overlayY) ? snapshot.overlayY : 80;
    state.editor.overlayWidthPct    = Number.isFinite(snapshot.overlayWidthPct) ? snapshot.overlayWidthPct : 48;
    state.editor.overlayRotation    = Number.isFinite(snapshot.overlayRotation) ? snapshot.overlayRotation : 0;
    state.editor.overlayVisible     = snapshot.overlayVisible ?? false;
    state.editor.frozenTextItems    = Array.isArray(snapshot.frozenTextItems) ? snapshot.frozenTextItems : [];
    state.editor.overlayAutoScale   = 1;
}

/**
 * Shallow equality check between two editor snapshots.
 *
 * @param {object} left
 * @param {object} right
 * @returns {boolean}
 */
export function editorSnapshotsEqual(left, right) {
    return Boolean(left && right)
        && left.selectedTemplateId  === right.selectedTemplateId
        && left.templateImage       === right.templateImage
        && left.generatedImage      === right.generatedImage
        && left.overlayText         === right.overlayText
        && left.overlayFontKey      === right.overlayFontKey
        && left.overlaySizeMode     === right.overlaySizeMode
        && left.overlayFontPx       === right.overlayFontPx
        && left.overlayTextColor    === right.overlayTextColor
        && left.overlayOutlineEnabled === right.overlayOutlineEnabled
        && left.overlayOutlineColor === right.overlayOutlineColor
        && left.overlayBold         === right.overlayBold
        && left.overlayItalic       === right.overlayItalic
        && left.overlayUnderline    === right.overlayUnderline
        && left.overlayX            === right.overlayX
        && left.overlayY            === right.overlayY
        && left.overlayWidthPct     === right.overlayWidthPct
        && left.overlayRotation     === right.overlayRotation
        && left.overlayVisible      === right.overlayVisible
        && JSON.stringify(left.frozenTextItems || []) === JSON.stringify(right.frozenTextItems || []);
}

// ── Persistence ──────────────────────────────

export function persistEditorHistory() {
    try {
        idbSetSync(EDITOR_HISTORY_STORAGE_KEY, JSON.stringify({
        selectedTemplateId: state.selectedTemplateId,
        initialSnapshot:    state.editor.initialSnapshot,
        historyStack:       state.editor.historyStack,
        futureStack:        state.editor.futureStack,
        currentSnapshot:    createEditorSnapshot(),
        }));
    } catch {
        // Ignore storage errors to preserve core editing behavior.
    }
    }

    export function clearEditorHistoryPersistence() {
    try {
        idbRemoveSync(EDITOR_HISTORY_STORAGE_KEY);
    } catch {
        // Ignore storage errors to preserve core editing behavior.
    }
}

// ── Initialization ───────────────────────────

export function initializeEditorState({ getTemplateMainImage, getSelectedTemplate }) {
    const template = getSelectedTemplate();
    state.editor.initialSnapshot = createEditorSnapshot({
        selectedTemplateId:    state.selectedTemplateId,
        templateImage:         getTemplateMainImage(template),
        generatedImage:        "",
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
    state.editor.lastSavedRecentImage = "";
    state.editor.historyStack       = [];
    state.editor.futureStack        = [];
    state.showResetConfirmation     = false;
    state.isTextSelected            = false;
    state.isTextLocked              = false;
    state.showTextMore              = false;
    applyEditorSnapshot(state.editor.initialSnapshot, { getTemplateMainImage });
}

// ── History stack ────────────────────────────

function ensureHistorySeed({ getTemplateMainImage, getSelectedTemplate }) {
    if (!state.editor.initialSnapshot) {
        initializeEditorState({ getTemplateMainImage, getSelectedTemplate });
    }
    if (state.editor.historyStack.length === 0) {
        state.editor.historyStack = [cloneSnapshot(state.editor.initialSnapshot)];
    }
}

export function recordEditorSnapshot(deps) {
    const { getTemplateMainImage, getSelectedTemplate } = deps;
    const snapshot = createEditorSnapshot();
    ensureHistorySeed({ getTemplateMainImage, getSelectedTemplate });
    const nextSnapshot = cloneSnapshot(snapshot);
    const lastSnapshot = state.editor.historyStack[state.editor.historyStack.length - 1];
    if (editorSnapshotsEqual(lastSnapshot, nextSnapshot)) return;
    state.editor.historyStack.push(nextSnapshot);
    state.editor.futureStack = [];
    persistEditorHistory();
}

export async function restoreEditorSession({ getTemplateMainImage }) {
    try {
        const raw = await idbGet(EDITOR_HISTORY_STORAGE_KEY);
        if (!raw) return false;
        const parsed = JSON.parse(raw);
        if (parsed?.selectedTemplateId !== state.selectedTemplateId) return false;

        state.editor.initialSnapshot = parsed.initialSnapshot || null;
        state.editor.historyStack = Array.isArray(parsed.historyStack)
        ? parsed.historyStack.filter(Boolean) : [];
        state.editor.futureStack = Array.isArray(parsed.futureStack)
        ? parsed.futureStack.filter(Boolean) : [];

        const snapshot = parsed.currentSnapshot
        || state.editor.historyStack[state.editor.historyStack.length - 1]
        || state.editor.initialSnapshot;
        if (!snapshot) return false;

        applyEditorSnapshot(snapshot, { getTemplateMainImage });
        return true;
    } catch {
        return false;
    }
}

// ── Undo / Redo / Reset ──────────────────────

export function undoEditorSnapshot({ getTemplateMainImage, render }) {
    if (state.editor.historyStack.length <= 1) return;
    const current = state.editor.historyStack.pop();
    if (current) state.editor.futureStack.push(current);
    applyEditorSnapshot(
        state.editor.historyStack[state.editor.historyStack.length - 1],
        { getTemplateMainImage }
    );
    state.showResetConfirmation = false;
    state.isEditingMemeText     = false;
    persistEditorHistory();
    render();
}

export function redoEditorSnapshot({ getTemplateMainImage, render }) {
    if (state.editor.futureStack.length === 0) return;
    const next = state.editor.futureStack.pop();
    if (!next) return;
    state.editor.historyStack.push(cloneSnapshot(next));
    applyEditorSnapshot(next, { getTemplateMainImage });
    state.showResetConfirmation = false;
    state.isEditingMemeText     = false;
    persistEditorHistory();
    render();
}

export function resetEditorToTemplate({ getTemplateMainImage, getSelectedTemplate, render }) {
    initializeEditorState({ getTemplateMainImage, getSelectedTemplate });
    state.isEditingMemeText  = false;
    state.showBackConfirmation = false;
    clearEditorHistoryPersistence();
    render();
}

export function hasUnsavedStudioEdits() {
    if (state.view !== "studio" || !state.selectedTemplateId) return false;
    if (state.editor.generatedImage && state.editor.lastSavedRecentImage !== state.editor.generatedImage) return true;
    if (!state.editor.initialSnapshot) return false;
    return !editorSnapshotsEqual(createEditorSnapshot(), state.editor.initialSnapshot);
}

export function confirmBackAndResetStudio({ getTemplateMainImage, getSelectedTemplate, render, renderTemplates }) {
    initializeEditorState({ getTemplateMainImage, getSelectedTemplate });
    clearEditorHistoryPersistence();
    state.showBackConfirmation  = false;
    state.showResetConfirmation = false;
    state.selectedTemplateId    = null;
    state.view                  = "templates";
    render();
    renderTemplates();
}
