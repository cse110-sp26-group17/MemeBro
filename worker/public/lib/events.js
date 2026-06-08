/**
 * @module events
 * All DOM event listener registrations.
 * Binds click, pointer, keyboard, and change handlers to the cached
 * DOM nodes so UI interactions flow through the shared state/render loop.
 */

import { configureAiPrompting } from "./ai-prompting.js";
import { ALLOWED_TYPES, MAX_MEME_TEXT_ITEMS } from "./constants.js";

/**
 * Registers every event listener the MemeBro app needs.
 *
 * @param {object} ctx - Dependency bag containing `dom`, `state`, render
 *   helpers, face/template modules, and editor actions
 */
export function registerEvents(ctx) {
    const {
        dom, state, STATES, clamp,
        // Camera / upload
        startCameraCapture, snapCameraPhoto, flipCamera,
        clearCameraStream, clearCameraReview,
        useReviewedPhoto, goBackToUploadChoices,
        startManualFitFromSelection, startManualDrag, moveManualDrag,
        configureUpload, detectFaces,
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
        saveCurrentEditorMeme,
        // Face swap
        submitSelectedFace,
        startFaceSwapLoadingState, stopFaceSwapLoadingState,
        // Render
        render, renderOverlay,
        // Misc
        getSelectedFaces, selectSingleFace, getRenderedSize,
        hasUnsavedStudioEdits, normalizeBox, setStatus, setError,
        applyManualTransform, showToast,
    } = ctx;

    const loadErrorCodes = new Set(["FEATURE_DISABLED", "QUEUE_FULL", "RATE_LIMITED"]);
    // AI prompting owns its own listeners; events.js only coordinates cross-feature interactions.
    const aiPrompting = configureAiPrompting({ dom, state, render, recordEditorSnapshot });

    async function submitFaceSwapWithErrorHandling() {
        try {
            state.error = null;
            state.lastRetryableAction = "face_swap";
            // Clear any stale loading flags from a previous swap so this
            // attempt can proceed cleanly even if the last one errored mid-flight.
            state.isSubmittingFaceSwap = false;
            state.isOptimizingImage = false;
            if (state.faceSwapAbortController) {
                state.faceSwapAbortController.abort();
                state.faceSwapAbortController = null;
            }
            if (state.status === STATES.ERROR) state.status = STATES.READY;
            await submitSelectedFace();
            state.lastRetryableAction = null;
        } catch (error) {
            if (error?.name === "AbortError") {
                state.lastRetryableAction = null;
                return;
            }
            // Show error inline without destroying user's work — keep status as READY
            // so the uploaded image, face selection, and template choice remain visible.
            if (!loadErrorCodes.has(error?.code)) state.lastRetryableAction = null;
            state.error = {
                code: error.code || "UPLOAD_FAILED",
                message: error.message || "Face swap failed. Please try again.",
            };
            state.status = STATES.READY;
            render();
        }
    }

    // ── Camera ────────────────────────────────────
    dom.cameraCta.addEventListener("click", () => startCameraCapture());
    dom.cameraSnapCta.addEventListener("click", () => snapCameraPhoto());
    dom.cameraFlipCta.addEventListener("click", () => flipCamera());
    dom.cameraCloseCta.addEventListener("click", () => { clearCameraStream(); render(); });
    dom.cameraCancelCta.addEventListener("click", () => { clearCameraStream(); render(); });

    // ── Review ───────────────────────────────────
    dom.reviewCloseCta.addEventListener("click", () => { clearCameraReview(); render(); });
    dom.retakeCta.addEventListener("click", () => { clearCameraReview(); startCameraCapture(); });
    dom.usePhotoCta.addEventListener("click", () => useReviewedPhoto());

    // ── File inputs ──────────────────────────────
    dom.cameraInput.addEventListener("change", async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        if (!ALLOWED_TYPES.has(file.type)) {
            const msg = "Please upload an image file (JPEG, PNG, or WebP)";
            state.error = { code: "INVALID_FILE_TYPE", message: msg };
            event.target.value = "";
            if (showToast) showToast(msg);
            render();
            return;
        }
        if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
        state.previewUrl = URL.createObjectURL(file);
        render();
        await detectFaces(file);
    });

    dom.libraryInput.addEventListener("change", async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        if (!ALLOWED_TYPES.has(file.type)) {
            const msg = "Please upload an image file (JPEG, PNG, or WebP)";
            state.error = { code: "INVALID_FILE_TYPE", message: msg };
            event.target.value = "";
            if (showToast) showToast(msg);
            render();
            return;
        }
        if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
        state.previewUrl = URL.createObjectURL(file);
        render();
        await detectFaces(file);
    });

    // ── Upload modal ─────────────────────────────
    dom.openUploadModalCta.addEventListener("click", () => {
        state.uploadModalOpen = true;
        aiPrompting.closePanelSilently();
        render();
    });
    dom.uploadModalBackdrop.addEventListener("click", () => { state.uploadModalOpen = false; render(); });
    dom.uploadModalClose.addEventListener("click",    () => { state.uploadModalOpen = false; render(); });
    dom.libraryCta.addEventListener("click", () => {
        state.uploadModalOpen = false;
        render();
        dom.libraryInput.click();
    });
    dom.projectMenuCta?.addEventListener("click", (event) => {
        event.stopPropagation();
        state.projectMenuOpen = !state.projectMenuOpen;
        render();
    });
    dom.exportProjectCta?.addEventListener("click", () => {
        state.projectMenuOpen = false;
        render();
    });
    dom.importProjectCta?.addEventListener("click", () => {
        state.projectMenuOpen = false;
        render();
    });

    // ── Navigation ───────────────────────────────
    dom.titleStartCta?.addEventListener("click", async () => {
        try { localStorage.setItem("memebro-onboarding-complete", "1"); } catch (_) { /* quota / private */ }
        await showTemplateSelection();
    });
    dom.backBtn.addEventListener("click", goBackToUploadChoices);

    dom.saveCta?.addEventListener("click", async () => {
        if (state.view !== "studio") return;
        dom.saveCta.disabled = true;
        try {
            await saveCurrentEditorMeme();
        } catch (error) {
            setError(error?.code || "SAVE_RECENT_FAILED", error?.message || "Could not save this meme.");
        } finally {
            dom.saveCta.disabled = false;
        }
    });

    // ── Upload configuration ─────────────────────
    configureUpload({
        dom, state, render, renderOverlay,
        getSelectedFaces, selectSingleFace, setStatus, detectFaces,
        getRenderedSize, hasUnsavedStudioEdits, renderTemplates,
        clamp, normalizeBox, STATES,
    });

    // ── Manual fit controls ──────────────────────
    dom.manualFitCta.addEventListener("click", () => startManualFitFromSelection());

    dom.manualZoom.addEventListener("input", () => {
        state.manualScale = Number(dom.manualZoom.value || 1);
        applyManualTransform();
        renderOverlay();
        syncGestureHud();
    });

    dom.manualRotation.addEventListener("input", () => {
        state.manualRotation = Number(dom.manualRotation.value || 0);
        applyManualTransform();
        renderOverlay();
    });

    dom.overlayShell.addEventListener("pointerdown", startManualDrag);
    dom.overlayShell.addEventListener("pointermove", moveManualDrag);
    dom.overlayShell.addEventListener("pointerup",   (e) => {
        if (state.dragPointerId !== e.pointerId) return;
        e.preventDefault();
        state.dragPointerId = null;
        dom.previewImage.classList.remove("dragging");
    });
    dom.overlayShell.addEventListener("pointercancel", (e) => {
        if (state.dragPointerId !== e.pointerId) return;
        e.preventDefault();
        state.dragPointerId = null;
        dom.previewImage.classList.remove("dragging");
    });

    // ── Scroll-to-zoom ────────────────────────────
    dom.overlayShell.addEventListener("wheel", (e) => {
        if (!state.manualMode) return;
        e.preventDefault();
        const delta = e.deltaY * -0.005;
        state.manualScale = clamp(state.manualScale + delta, 0.5, 3.0);
        dom.manualZoom.value = String(state.manualScale);
        applyManualTransform();
        renderOverlay();
        syncGestureHud();
    }, { passive: false });

    // ── Multi-touch pinch/rotate ──────────────────
    dom.overlayShell.addEventListener("touchstart", (e) => {
        if (!state.manualMode || e.touches.length < 2) return;
        e.preventDefault();
        const [a, b] = [e.touches[0], e.touches[1]];
        state.gesture = {
            startDist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
            startAngle: Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX) * (180 / Math.PI),
            startScale: state.manualScale,
            startRotation: state.manualRotation,
        };
    }, { passive: false });

    dom.overlayShell.addEventListener("touchmove", (e) => {
        if (!state.manualMode || e.touches.length < 2 || !state.gesture) return;
        e.preventDefault();
        const [a, b] = [e.touches[0], e.touches[1]];
        const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
        const angle = Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX) * (180 / Math.PI);
        const scaleFactor = dist / state.gesture.startDist;
        state.manualScale = clamp(state.gesture.startScale * scaleFactor, 0.5, 3.0);
        state.manualRotation = clamp(
            state.gesture.startRotation + (angle - state.gesture.startAngle),
            -180, 180
        );
        dom.manualZoom.value = String(state.manualScale);
        dom.manualRotation.value = String(Math.round(state.manualRotation));
        applyManualTransform();
        renderOverlay();
        syncGestureHud();
    }, { passive: false });

    dom.overlayShell.addEventListener("touchend", (e) => {
        if (e.touches.length < 2) state.gesture = null;
    });

    function syncGestureHud() {
        if (dom.zoomBadge) dom.zoomBadge.textContent = `${Math.round(state.manualScale * 100)}%`;
    }

    // ── Template search / tabs ───────────────────
    dom.templateSearch.addEventListener("input", (event) => {
        state.templateSearchQuery = event.target.value;
        renderTemplates();
    });

    dom.templateTabs.addEventListener("click", (event) => {
        const tab = event.target.closest("[data-tab]");
        if (!tab) return;
        state.activeTemplateTab = tab.dataset.tab;
        [...dom.templateTabs.querySelectorAll("[data-tab]")].forEach((button) => {
        const active = button.dataset.tab === state.activeTemplateTab;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
        });
        renderTemplates();
    });

    // ── Add text ─────────────────────────────────
    dom.addTextCta?.addEventListener("click", () => {
        const rect = dom.studioTemplateArt.getBoundingClientRect();
        createOrSelectTextAtPointer({ clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
    });

    // ── Meme text preview interactions ──────────
    dom.memeTextPreview.addEventListener("click",   selectTextObject);
    dom.memeTextPreview.addEventListener("dblclick", beginInlineTextEdit);
    dom.memeTextPreview.addEventListener("blur",     finishInlineTextEdit);
    dom.memeTextPreview.addEventListener("input", () => {
        state.editor.overlayText    = getEditableTextValue(dom.memeTextPreview);
        state.editor.overlayVisible = true;
        state.showResetConfirmation  = false;
        syncMemeTextAppearance();
        // Do NOT call render() while actively editing
    });

    dom.memeTextPreview.addEventListener("pointerdown", (event) => {
        if (state.isEditingMemeText) return;
        startTextDrag(event);
    });
    dom.memeTextPreview.addEventListener("pointermove",  moveTextDrag);
    dom.memeTextPreview.addEventListener("pointerup",    endTextDrag);
    dom.memeTextPreview.addEventListener("pointercancel", endTextDrag);

    // ── Studio art: click / dblclick / touch ────
    dom.studioTemplateArt.addEventListener("click", (event) => {
        if (event.target.closest(".text-toolbar, .text-local-controls, .text-menu")) return;
        if (event.target === dom.memeTextDelete || event.target === dom.memeTextRotateHandle) return;
        const frozenTextNode = event.target.closest(".frozen-text-item");
        if (frozenTextNode) {
        const index = Number(frozenTextNode.dataset.textIndex);
        if (Number.isFinite(index)) { selectFrozenTextItem(index); return; }
        }
        // Single-click on blank: no-op
    });

    dom.studioTemplateArt.addEventListener("dblclick", (event) => {
        if (event.target.closest(".text-toolbar, .text-local-controls, .text-menu")) return;
        if (event.target === dom.memeTextDelete || event.target === dom.memeTextRotateHandle) return;
        if (event.target.closest(".frozen-text-item")) return;
        if (state.textDidDrag) return;
        if (
        event.target === dom.studioTemplateArt
        || event.target === dom.studioTemplateInitials
        || event.target === dom.studioTemplateRegions
        ) {
        createOrSelectTextAtPointer(event);
        }
    });

    let lastBlankTapTime = 0;
    dom.studioTemplateArt.addEventListener("pointerup", (event) => {
        if (event.pointerType !== "touch") return;
        if (event.target.closest(".text-toolbar, .text-local-controls, .text-menu, .frozen-text-item")) return;
        if (!(
        event.target === dom.studioTemplateArt
        || event.target === dom.studioTemplateInitials
        || event.target === dom.studioTemplateRegions
        )) return;
        const now = Date.now();
        if (now - lastBlankTapTime <= 360) { createOrSelectTextAtPointer(event); lastBlankTapTime = 0; return; }
        lastBlankTapTime = now;
    });

    // ── Text delete ──────────────────────────────
    dom.memeTextDelete.addEventListener("click", deleteMemeText);

    // ── Text duplicate ───────────────────────────
    dom.textDuplicateCta.addEventListener("click", () => {
        if (!state.editor.overlayVisible) return;
        const totalItems = state.editor.frozenTextItems.length + 1;
        if (totalItems >= MAX_MEME_TEXT_ITEMS) return;
        const text = (state.editor.overlayText || "").trim();
        if (!text) return;

        const src = {
        text,
        fontKey:      state.editor.overlayFontKey,
        fontPx:       state.editor.overlayFontPx,
        color:        state.editor.overlayTextColor,
        outline:      state.editor.overlayOutlineEnabled,
        outlineColor: state.editor.overlayOutlineColor,
        bold:         state.editor.overlayBold,
        italic:       state.editor.overlayItalic,
        underline:    state.editor.overlayUnderline,
        x:            state.editor.overlayX,
        y:            state.editor.overlayY,
        widthPct:     state.editor.overlayWidthPct,
        rotation:     state.editor.overlayRotation,
        locked:       state.isTextLocked,
        };

        freezeCurrentTextItem();

        const offset = clamp(Math.max(10, src.widthPct * 0.22), 10, 18);
        const dx = src.x + offset > 95 ? -offset : offset;
        const dy = src.y + offset > 95 ? -offset : offset;

        Object.assign(state.editor, {
        overlayText:           src.text,
        overlayFontKey:        src.fontKey,
        overlayFontPx:         src.fontPx,
        overlayTextColor:      src.color,
        overlayOutlineEnabled: src.outline,
        overlayOutlineColor:   src.outlineColor,
        overlayBold:           src.bold,
        overlayItalic:         src.italic,
        overlayUnderline:      src.underline,
        overlayX:              clamp(src.x + dx, 5, 95),
        overlayY:              clamp(src.y + dy, 5, 95),
        overlayWidthPct:       src.widthPct,
        overlayRotation:       src.rotation,
        overlayVisible:        true,
        });
        state.isTextLocked      = src.locked;
        state.isEditingMemeText = false;
        state.isTextSelected    = true;
        state.showTextMore      = false;
        recordEditorSnapshot();
        render();
    });

    // ── Text lock ────────────────────────────────
    dom.textLockCta.addEventListener("click", () => {
        state.isTextLocked      = !state.isTextLocked;
        state.isEditingMemeText = false;
        render();
    });

    // ── Text more menu ───────────────────────────
    dom.textMoreCta?.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!state.editor.overlayVisible || !state.isTextSelected) return;
        state.showTextMore = !state.showTextMore;
        state.isEditingMemeText = false;
        render();
    });

    // ── Text border toggle ───────────────────────
    dom.textBorderToggleCta?.addEventListener("click", () => {
        updateEditorTextSetting("overlayOutlineEnabled", !state.editor.overlayOutlineEnabled);
    });

    // ── Font size ────────────────────────────────
    dom.textSizeDecCta.addEventListener("click", () => {
        updateEditorTextSetting("overlayFontPx", clamp(Math.round((state.editor.overlayFontPx || 22) - 2), 8, 120));
    });
    dom.textSizeIncCta.addEventListener("click", () => {
        updateEditorTextSetting("overlayFontPx", clamp(Math.round((state.editor.overlayFontPx || 22) + 2), 8, 120));
    });
    dom.memeFontSizeInput.addEventListener("change", () => {
        updateEditorTextSetting("overlayFontPx", clamp(Number(dom.memeFontSizeInput.value) || 22, 8, 120));
    });

    // ── Font family ──────────────────────────────
    dom.memeFontSelect.addEventListener("change", () => {
        updateEditorTextSetting("overlayFontKey", dom.memeFontSelect.value);
    });

    // ── Text style toggles ───────────────────────
    dom.textStyleBoldCta.addEventListener("click",      () => updateEditorTextSetting("overlayBold",      !state.editor.overlayBold));
    dom.textStyleItalicCta.addEventListener("click",    () => updateEditorTextSetting("overlayItalic",    !state.editor.overlayItalic));
    dom.textStyleUnderlineCta.addEventListener("click", () => updateEditorTextSetting("overlayUnderline", !state.editor.overlayUnderline));

    // ── Text color ───────────────────────────────
    let textColorFocusStart      = state.editor.overlayTextColor;
    let textColorCommittedInFocus = false;

    dom.memeTextColorInput.addEventListener("focus", () => {
        textColorFocusStart       = state.editor.overlayTextColor;
        textColorCommittedInFocus = false;
    });
    dom.memeTextColorInput.addEventListener("input", () => {
        state.editor.overlayTextColor = dom.memeTextColorInput.value;
        state.showResetConfirmation   = false;
        syncMemeTextAppearance();
    });
    dom.memeTextColorInput.addEventListener("change", () => {
        textColorCommittedInFocus = true;
        updateEditorTextSetting("overlayTextColor", dom.memeTextColorInput.value);
    });
    dom.memeTextColorInput.addEventListener("blur", () => {
        if (textColorCommittedInFocus) return;
        if (state.editor.overlayTextColor !== textColorFocusStart) {
        updateEditorTextSetting("overlayTextColor", state.editor.overlayTextColor);
        }
    });

    // ── Quick color swatches ─────────────────────
    dom.colorSwatches?.forEach((swatch) => {
        swatch.addEventListener("click", () => {
            const key = swatch.dataset.colorKey;
            if (!key) return;
            const MEME_TEXT_COLORS = { black: "#000000", white: "#ffffff", red: "#d62828", blue: "#2563eb", yellow: "#ffd60a" };
            const hex = MEME_TEXT_COLORS[key];
            if (!hex) return;
            updateEditorTextSetting("overlayTextColor", hex);
        });
    });

    // ── Outline color ────────────────────────────
    let outlineColorFocusStart      = state.editor.overlayOutlineColor;
    let outlineColorCommittedInFocus = false;

    dom.memeOutlineColorInput.addEventListener("focus", () => {
        outlineColorFocusStart       = state.editor.overlayOutlineColor;
        outlineColorCommittedInFocus = false;
    });
    dom.memeOutlineColorInput.addEventListener("input", () => {
        state.editor.overlayOutlineEnabled = true;
        state.editor.overlayOutlineColor   = dom.memeOutlineColorInput.value;
        state.showResetConfirmation        = false;
        syncMemeTextAppearance();
        syncOutlineSwatchState();
    });
    dom.memeOutlineColorInput.addEventListener("change", () => {
        outlineColorCommittedInFocus       = true;
        state.editor.overlayOutlineEnabled = true;
        updateEditorTextSetting("overlayOutlineColor", dom.memeOutlineColorInput.value);
    });
    dom.memeOutlineColorInput.addEventListener("blur", () => {
        if (outlineColorCommittedInFocus) return;
        if (state.editor.overlayOutlineColor !== outlineColorFocusStart) {
        state.editor.overlayOutlineEnabled = true;
        updateEditorTextSetting("overlayOutlineColor", state.editor.overlayOutlineColor);
        }
    });

    // ── Outline remove ───────────────────────────
    dom.memeOutlineRemoveCta?.addEventListener("click", () => {
        updateEditorTextSetting("overlayOutlineEnabled", false);
    });

    // ── Rotate / resize handles ──────────────────
    dom.memeTextRotateHandle.addEventListener("click", rotateTextOneStep);

    dom.memeTextResizeHandles?.forEach((handle) => {
        handle.addEventListener("pointerdown",   startTextResize);
        handle.addEventListener("pointermove",   moveTextResize);
        handle.addEventListener("pointerup",     endTextResize);
        handle.addEventListener("pointercancel", endTextResize);
    });

    // ── Clipboard ────────────────────────────────
    dom.textCopyCta.addEventListener("click", async () => {
        state.clipboardText = state.editor.overlayText;
        try { await navigator.clipboard?.writeText(state.editor.overlayText); } catch {}
        state.showTextMore = false;
        render();
    });
    dom.textPasteCta.addEventListener("click", async () => {
        let text = state.clipboardText;
        try { text = (await navigator.clipboard?.readText()) || text; } catch {}
        if (!text) return;
        state.editor.overlayText    = text;
        state.editor.overlayVisible = true;
        recordEditorSnapshot();
        state.showTextMore = false;
        render();
    });
    dom.textLinkCta.addEventListener("click", () => {
        const link = window.prompt("Add a link for this text", state.textLink || "https://");
        if (link !== null) state.textLink = link.trim();
        state.showTextMore = false;
        render();
    });

    // ── Editor history ───────────────────────────
    dom.undoCta.addEventListener("click", () => undoEditorSnapshot());
    dom.redoCta.addEventListener("click", () => redoEditorSnapshot());

    dom.resetCta.addEventListener("click", () => {
        state.showResetConfirmation = !state.showResetConfirmation;
        state.isEditingMemeText     = false;
        render();
    });
    dom.resetConfirmationBackdrop?.addEventListener("click", () => { state.showResetConfirmation = false; render(); });
    dom.resetCancelCta.addEventListener("click",            () => { state.showResetConfirmation = false; render(); });
    dom.resetConfirmCta.addEventListener("click",           () => resetEditorToTemplate());

    dom.backConfirmationBackdrop?.addEventListener("click", () => { state.showBackConfirmation = false; render(); });
    dom.backCancelCta?.addEventListener("click",            () => { state.showBackConfirmation = false; render(); });
    dom.backConfirmCta?.addEventListener("click",           () => confirmBackAndResetStudio());

    // ── Face swap loader ─────────────────────────
    dom.faceSwapLoaderCancel.addEventListener("click", () => {
        if (state.faceSwapAbortController) state.faceSwapAbortController.abort();
        stopFaceSwapLoadingState();
    });

    // ── Continue ─────────────────────────────────
    dom.continueBtn.addEventListener("click", submitFaceSwapWithErrorHandling);
    dom.errorRetryCta?.addEventListener("click", async () => {
        if (state.lastRetryableAction !== "face_swap") return;
        await submitFaceSwapWithErrorHandling();
    });
    dom.errorNewPhotoCta?.addEventListener("click", () => {
        state.error = null;
        state.lastRetryableAction = null;
        render();
        dom.libraryInput.click();
    });

    // ── Studio template image fallback ───────────
    dom.studioTemplateImage.addEventListener("load", () => {
        dom.studioTemplateArt.classList.add("image-ready");
        dom.studioTemplateArt.classList.remove("image-error");
        dom.studioTemplateImage.classList.add("is-loaded");
    });
    dom.studioTemplateImage.addEventListener("error", () => {
        const sources   = JSON.parse(dom.studioTemplateImage.dataset.fallbackSources || "[]");
        const nextIndex = Number(dom.studioTemplateImage.dataset.fallbackIndex || "0") + 1;
        if (nextIndex < sources.length) {
        dom.studioTemplateImage.dataset.fallbackIndex = String(nextIndex);
        dom.studioTemplateImage.src = sources[nextIndex];
        return;
        }
        dom.studioTemplateArt.classList.add("image-error");
    });

    // ── Resize ───────────────────────────────────
    window.addEventListener("resize", () => {
        if (state.view === "studio") {
        // renderStudioTemplate is called inside render()
        render();
        }
    });

    // ── Debounced text-input snapshot + autosave ─
    let _textInputDebounceTimer = null;
    dom.memeTextPreview.addEventListener("input", () => {
        clearTimeout(_textInputDebounceTimer);
        _textInputDebounceTimer = setTimeout(() => {
            _textInputDebounceTimer = null;
            recordEditorSnapshot();
            render();
        }, 1500);
    });
    dom.memeTextPreview.addEventListener("blur", () => {
        // Flush any pending debounced snapshot immediately on blur
        if (_textInputDebounceTimer) {
            clearTimeout(_textInputDebounceTimer);
            _textInputDebounceTimer = null;
            recordEditorSnapshot();
        }
    });

    // ── Global keyboard ──────────────────────────
    document.addEventListener("keydown", (event) => {
        const inInput = event.target?.closest?.("input, textarea, select, [contenteditable='true']");

        // Escape — dismiss open panels / modals / selections
        if (event.key === "Escape") {
            if (state.showResetConfirmation) {
                state.showResetConfirmation = false; render(); return;
            }
            if (state.showBackConfirmation) {
                state.showBackConfirmation = false; render(); return;
            }
            if (state.uploadModalOpen) {
                state.uploadModalOpen = false; render(); return;
            }
            if (state.projectMenuOpen) {
                state.projectMenuOpen = false; render(); return;
            }
            if (state.showTextMore) {
                state.showTextMore = false; render(); return;
            }
            if (state.isEditingMemeText) {
                finishInlineTextEdit(); return;
            }
            if (state.isTextSelected) {
                state.isTextSelected = false; render(); return;
            }
            if (state.aiPrompt?.panelState === "open" || state.isAiPromptPanelOpen) {
                if (state.aiPrompt) state.aiPrompt.panelState = "closed";
                state.isAiPromptPanelOpen = false;
                render(); return;
            }
        }

        // Ctrl+Z / Ctrl+Y — undo / redo (case-insensitive for CapsLock)
        if ((event.ctrlKey || event.metaKey) && !inInput) {
            if (event.key.toLowerCase() === "z" && !event.shiftKey) {
                // Flush debounced text snapshot before undoing
                if (_textInputDebounceTimer) {
                    clearTimeout(_textInputDebounceTimer);
                    _textInputDebounceTimer = null;
                    recordEditorSnapshot();
                }
                if (state.isEditingMemeText) finishInlineTextEdit();
                event.preventDefault();
                undoEditorSnapshot();
                return;
            }
            if (event.key.toLowerCase() === "z" && event.shiftKey || event.key.toLowerCase() === "y") {
                event.preventDefault();
                redoEditorSnapshot();
                return;
            }
        }

        // Backspace / Delete — delete selected text
        if (event.key !== "Backspace" && event.key !== "Delete") return;
        if (!state.editor.overlayVisible || !state.isTextSelected || state.isEditingMemeText) return;
        if (inInput) return;
        event.preventDefault();
        deleteMemeText();
    });

    // ── Global pointer: deselect text on outside click ──
    document.addEventListener("pointerdown", (event) => {
        const clickedInsideEditor = event.target.closest(
        "#meme-text-preview, .frozen-text-item, .text-toolbar, .text-local-controls, .text-menu, .meme-text-resize-handle"
        );
        if (clickedInsideEditor) return;
        if (state.isEditingMemeText) finishInlineTextEdit();
        if (event.target.closest("#studio-template-art")) {
        state.isTextSelected = false;
        state.showTextMore   = false;
        state.projectMenuOpen = false;
        render();
        return;
        }
        if (state.isTextSelected || state.showTextMore) {
        state.isTextSelected = false;
        state.showTextMore   = false;
        state.projectMenuOpen = false;
        render();
        return;
        }
        if (state.projectMenuOpen && !event.target.closest(".project-menu")) {
        state.projectMenuOpen = false;
        render();
        }
    });
}
