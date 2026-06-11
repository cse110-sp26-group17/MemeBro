/**
 * @module faceSwap
 * Face swap submission and loading state.
 * Orchestrates the face-swap API call, manages the abort controller
 * for cancellation, and toggles the slow-request UX message.
 */

import { state } from "./state.js";
import { compressForUpload } from "./compressImage.js";
import { DEFAULT_MEME_TEXT } from "./constants.js";
import { createEditorSnapshot } from "./editor.js";

export function startFaceSwapLoadingState({ render }) {
    state.isSubmittingFaceSwap   = true;
    state.showSlowFaceSwapMessage = false;
    if (state.faceSwapSlowTimer) clearTimeout(state.faceSwapSlowTimer);
    state.faceSwapSlowTimer = setTimeout(() => {
        state.showSlowFaceSwapMessage = true;
        render();
    }, 45000);
    render();
}

export function stopFaceSwapLoadingState({ render }) {
    state.isSubmittingFaceSwap    = false;
    state.showSlowFaceSwapMessage = false;
    state.isOptimizingImage       = false;
    state.faceSwapAbortController = null;
    if (state.faceSwapSlowTimer) clearTimeout(state.faceSwapSlowTimer);
    state.faceSwapSlowTimer = null;
    render();
}

export function getSelectedFaceIndex(state) {
    if (!state.faces.length || !state.selectedFaceIds.length) return -1;
    return state.faces.findIndex((f) => f.id === state.selectedFaceIds[0]);
}

export function getSelectedFaceSummary(state) {
    const index = getSelectedFaceIndex(state);
    if (index === -1) return null;
    return {
        index,
        faceNumber: index + 1,
        totalFaces: state.faces.length,
        faceId: state.selectedFaceIds[0],
    };
}

export async function submitSelectedFace({
    state: _state,
    getSelectedFaces,
    getSelectedTemplate,
    getFaceCropMimeType,
    extractFaceCrop,
    extractGeneratedImageUrl,
    requestFaceSwap,
    recordEditorSnapshot,
    startFaceSwapLoading,
    stopFaceSwapLoading,
    render,
    STATES,
    }) {
    if (_state.status !== STATES.READY) return;
    const selectedFaces  = getSelectedFaces();
    const selectedFace   = selectedFaces[0];
    if (!selectedFace) return;

    _state.faceSwapAbortController = new AbortController();
    const faceSwapSignal = _state.faceSwapAbortController.signal;
    startFaceSwapLoading();
    let payload;
    let optimizingTimer = null;

    try {
        const cropType = getFaceCropMimeType(_state.file);
        const faceCrop = await extractFaceCrop(_state.file, selectedFace, {
        decodedImage: _state.imageBitmap,
        type: cropType,
        });

        // Compress the face crop before uploading (resize to max 1024px,
        // re-encode JPEG q0.85, strip metadata). Show "Optimizing..." if
        // compression takes longer than 500ms.
        optimizingTimer = setTimeout(() => {
            _state.isOptimizingImage = true;
            render();
        }, 500);

        const compressedBlob = await compressForUpload(faceCrop.blob);
        clearTimeout(optimizingTimer);
        _state.isOptimizingImage = false;
        render();

        const compressedFaceCrop = {
            ...faceCrop,
            blob: compressedBlob,
            type: compressedBlob.type || "image/jpeg",
        };

        payload = await requestFaceSwap({
        file:       _state.file,
        faceCrop:   compressedFaceCrop,
        templateId: _state.selectedTemplateId,
        selectedFaces,
        memeText:   (_state.editor.overlayText || "").trim().toUpperCase() === DEFAULT_MEME_TEXT.toUpperCase()
                        ? ""
                        : (_state.editor.overlayText || ""),
        textStyle: {
            fontKey:        _state.editor.overlayFontKey,
            fontPx:         _state.editor.overlayFontPx,
            textColor:      _state.editor.overlayTextColor,
            outlineEnabled: _state.editor.overlayOutlineEnabled,
            outlineColor:   _state.editor.overlayOutlineColor,
        },
        signal: faceSwapSignal,
        });
    } finally {
        clearTimeout(optimizingTimer);
        _state.isOptimizingImage = false;
        stopFaceSwapLoading();
    }

    const generatedImage = extractGeneratedImageUrl(payload);
    if (!generatedImage) {
        const error = new Error("Face swap completed, but no composited image URL was returned.");
        error.code = "MISSING_GENERATED_IMAGE";
        throw error;
    }

    _state.editor.generatedImage = generatedImage;
    _state.editor.lastSavedRecentImage = "";
    _state.view = "studio";
    _state.showResetConfirmation  = false;
    recordEditorSnapshot();
    _state.editor.initialSnapshot = createEditorSnapshot();
    render();
    return payload;
}
