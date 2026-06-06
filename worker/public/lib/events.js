// ─────────────────────────────────────────────
// All DOM event listener registrations.
// ─────────────────────────────────────────────

import { configureAiPrompting } from "./ai-prompting.js";

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
        applyManualTransform,
        markFirstVisit,
    } = ctx;

    const loadErrorCodes = new Set(["FEATURE_DISABLED", "QUEUE_FULL", "RATE_LIMITED"]);
    // AI prompting owns its own listeners; events.js only coordinates cross-feature interactions.
    const aiPrompting = configureAiPrompting({ dom, state, render });

    async function submitFaceSwapWithErrorHandling() {
        try {
            state.error = null;
            state.lastRetryableAction = "face_swap";
            if (state.status === STATES.ERROR) state.status = STATES.READY;
            await submitSelectedFace();
            state.lastRetryableAction = null;
        } catch (error) {
            if (error?.name === "AbortError") {
                state.lastRetryableAction = null;
                return;
            }
            if (!loadErrorCodes.has(error?.code)) state.lastRetryableAction = null;
            setError(error.code || "UPLOAD_FAILED", error.message || "Upload failed.");
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
        if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
        state.previewUrl = URL.createObjectURL(file);
        render();
        await detectFaces(file);
    });

    dom.libraryInput.addEventListener("change", async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
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
        markFirstVisit();
        await showTemplateSelection();
    });
    dom.backBtn.addEventListener("click", goBackToUploadChoices);

    dom.saveCta?.addEventListener("click", async () => {
        if (state.view !== "studio") return;
        dom.saveCta.disabled = true;
        try {
            await saveCurrentEditorMeme();
        } catch {
            // Keep save non-blocking for the editor if browser storage fails.
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

    // ── Global keyboard ──────────────────────────
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Backspace") return;
        if (!state.editor.overlayVisible || !state.isTextSelected || state.isEditingMemeText) return;
        if (event.target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
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
