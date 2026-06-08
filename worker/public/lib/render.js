/**
 * @module render
 * Main render function and overlay renderer.
 * Reads the global `state` object each call and imperatively updates
 * the DOM to match: visibility of screens, error banners, template
 * art, sidebar positioning, and the text-overlay preview.
 */

import { STATES, MEME_TEXT_CHAR_WARN } from "./constants.js";
import { getLoadErrorMessage, RETRYABLE_LOAD_ERROR_CODES, NEW_PHOTO_ERROR_CODES } from "./loadErrors.js";

function positionStudioSidebar({ dom, showingStudio }) {
    const sidebar = dom.studioSidebar;
    const art = dom.studioTemplateArt;
    if (!sidebar || !art) return;

    const isDesktop = window.innerWidth >= 900;
    if (!showingStudio || !isDesktop) {
        sidebar.style.left = "";
        sidebar.style.right = "";
        sidebar.style.width = "";
        return;
    }

    const artRect = art.getBoundingClientRect();
    if (!artRect.width) return;

    const pagePadding = Math.max(18, Math.min(56, window.innerWidth * 0.035));
    const gutterLeft = artRect.right;
    const gutterRight = window.innerWidth - pagePadding;
    const gutterWidth = Math.max(0, gutterRight - gutterLeft);
    const sidebarWidth = Math.min(220, Math.max(116, gutterWidth - 24));
    const centeredInGutter = gutterLeft + gutterWidth / 2;
    const centerX = Math.min(
        gutterRight - sidebarWidth / 2,
        Math.max(gutterLeft + sidebarWidth / 2, centeredInGutter)
    );

    sidebar.style.left = `${Math.round(centerX)}px`;
    sidebar.style.right = "auto";
    sidebar.style.width = `${Math.round(sidebarWidth)}px`;
}

// ── Face overlay ──────────────────────────────

export function renderOverlay({
    dom, state,
    normalizeBox, clamp,
    FACE_BOX_TAP_TARGET,
    toggleDetectedFaceSelection,
    getRenderedSize,
    render,
    }) {
    dom.overlayLayer.innerHTML = "";
    dom.overlayLayer.style.pointerEvents = state.manualMode ? "none" : "";
    if (state.manualMode) return;

    const rendered = getRenderedSize();

    state.faces.forEach((face, index) => {
        const boxRendered = face.boxNatural && state.imageBitmap
        ? normalizeBox(
            face.boxNatural,
            { width: state.imageBitmap.width, height: state.imageBitmap.height },
            rendered
            )
        : face.boxRendered;

        if (!boxRendered) return;

        const hitWidth  = Math.max(boxRendered.width,  FACE_BOX_TAP_TARGET);
        const hitHeight = Math.max(boxRendered.height, FACE_BOX_TAP_TARGET);
        const hitLeft   = clamp(boxRendered.x - (hitWidth  - boxRendered.width)  / 2, 0, Math.max(0, rendered.width  - hitWidth));
        const hitTop    = clamp(boxRendered.y - (hitHeight - boxRendered.height) / 2, 0, Math.max(0, rendered.height - hitHeight));

        const isSelected            = state.selectedFaceIds.includes(face.id);
        const canSelectDetectedFaces = [STATES.FACES_FOUND, STATES.READY].includes(state.status);

        const button = document.createElement("button");
        button.type      = "button";
        button.className = `face-box ${isSelected ? "selected" : ""}`;
        button.style.left   = `${hitLeft}px`;
        button.style.top    = `${hitTop}px`;
        button.style.width  = `${hitWidth}px`;
        button.style.height = `${hitHeight}px`;
        const ovalWidth = boxRendered.width;
        const ovalHeight = Math.max(boxRendered.height, boxRendered.width * 1.3);
        const ovalLeft = boxRendered.x - hitLeft - (ovalWidth - boxRendered.width) / 2;
        const ovalTop = boxRendered.y - hitTop - (ovalHeight - boxRendered.height) / 2;
        button.style.setProperty("--face-ring-left",   `${ovalLeft}px`);
        button.style.setProperty("--face-ring-top",    `${ovalTop}px`);
        button.style.setProperty("--face-ring-width",  `${ovalWidth}px`);
        button.style.setProperty("--face-ring-height", `${ovalHeight}px`);
        button.disabled = !canSelectDetectedFaces;
        button.setAttribute("aria-pressed", String(isSelected));
        button.setAttribute("aria-label", `Select face ${index + 1} of ${state.faces.length}`);

        const ring = document.createElement("span");
        ring.className = "face-box-ring";
        button.appendChild(ring);

        if (state.faces.length > 1) {
            const label = document.createElement("span");
            label.className = "face-box-label";
            label.textContent = String(index + 1);
            button.appendChild(label);
        }

        button.addEventListener("click", () => {
        if (![STATES.FACES_FOUND, STATES.READY].includes(state.status)) return;
        toggleDetectedFaceSelection(face.id);
        state.status = state.selectedFaceIds.length ? STATES.READY : STATES.FACES_FOUND;
        render();
        });

        dom.overlayLayer.appendChild(button);
    });
}

// ── Main render ───────────────────────────────

export function render(ctx) {
    const {
        dom, state,
        getSelectedTemplate, getSelectedFaces, getSelectableFaceLimit,
        renderStudioTemplate, renderFrozenTextItems, syncMemeTextAppearance,
        applyManualTransform, renderOverlay: _renderOverlay,
        renderAiPromptHistory: _renderAiPromptHistory,
        renderAiPromptLoadMode: _renderAiPromptLoadMode,
        syncOutlineSwatchState, getMemeTextColor,
    } = ctx;

    const cameraActive          = Boolean(state.cameraStream);
    const reviewingCameraPhoto  = Boolean(state.cameraReviewUrl);
    const editingPhoto          = Boolean(state.previewUrl) && [STATES.FACES_FOUND, STATES.READY].includes(state.status);
    const showingHome           = state.view === "home";
    const showingTemplates      = state.view === "templates";
    const showingStudio         = state.view === "studio";
    const aiPromptPanelOpen     = state.aiPrompt?.panelState === "open" || state.isAiPromptPanelOpen;
    const selectedTemplate      = getSelectedTemplate();
    const selectedFaceCount     = getSelectedFaces().length;
    const selectableFaceLimit   = getSelectableFaceLimit();

    // ── Page-level classes ──
    dom.uploadPage.classList.toggle("home-mode",   showingHome);
    dom.uploadPage.classList.toggle("camera-mode", cameraActive || reviewingCameraPhoto);

    // ── Show/hide sections ──
    dom.titleScreen?.classList.toggle("hidden", !showingHome);
    dom.topbar?.classList.toggle("hidden", showingHome);
    dom.backBtn?.classList.toggle("hidden", showingHome);
    dom.saveCta?.classList.toggle("hidden", !showingStudio);
    dom.shareCta?.classList.toggle("hidden", !showingStudio);
    dom.projectMenuCta?.classList.toggle("hidden", !showingStudio);
    dom.projectMenu?.classList.toggle("hidden", !showingStudio || !state.projectMenuOpen);
    dom.projectMenuCta?.setAttribute("aria-expanded", String(showingStudio && state.projectMenuOpen));
    dom.cameraShell.classList.toggle("hidden", !cameraActive);
    dom.reviewShell.classList.toggle("hidden", !reviewingCameraPhoto);
    dom.templateScreen.classList.toggle("hidden", !showingTemplates);
    dom.studioScreen.classList.toggle("hidden", !showingStudio);
    dom.uploadModal.classList.toggle("hidden", !state.uploadModalOpen);
    dom.aiPromptPanel?.classList.toggle("hidden", !showingStudio || !aiPromptPanelOpen);
    dom.vibeContainer?.classList.toggle("hidden", showingStudio && aiPromptPanelOpen);
    dom.resetConfirmation.classList.toggle("hidden", !showingStudio || !state.showResetConfirmation);
    dom.backConfirmation.classList.toggle("hidden",  !showingStudio || !state.showBackConfirmation);
    dom.overlayShell.classList.toggle("hidden", !editingPhoto || showingTemplates || showingStudio);

    // ── Upload / camera CTAs ──
    dom.cameraCancelCta.classList.toggle("hidden", !cameraActive);
    dom.ctaRow.classList.toggle("hidden", !state.uploadModalOpen || cameraActive || reviewingCameraPhoto || editingPhoto);
    dom.cameraCta.classList.toggle("hidden", cameraActive || reviewingCameraPhoto || editingPhoto);
    dom.libraryCta.classList.toggle("hidden", cameraActive || reviewingCameraPhoto || editingPhoto);
    dom.manualFitCta.classList.toggle("hidden",
        !editingPhoto || showingTemplates || showingStudio || state.manualMode || !state.imageBitmap
    );

    // ── Overlay shell state ──
    dom.overlayShell.classList.toggle("manual-active", state.manualMode);
    dom.overlayShell.classList.toggle("dragging", state.dragPointerId !== null);

    // ── Studio ──
    dom.selectedTemplateLabel.textContent = selectedTemplate ? `Template: ${selectedTemplate.name}` : "";
    if (showingStudio && selectedTemplate) {
        renderStudioTemplate(selectedTemplate);
    } else if (showingStudio && !selectedTemplate && state.editor.templateImage) {
        // "Drop a meme" flow — no template selected, render the dropped image directly.
        const src = state.editor.generatedImage || state.editor.templateImage;
        if (dom.studioTemplateImage.src !== src) {
            dom.studioTemplateImage.src = src;
            dom.studioTemplateImage.alt = "Dropped meme";
        }
        dom.studioTemplateArt.style.width  = "";
        dom.studioTemplateArt.style.height = "";
        dom.studioTemplateInitials.textContent = "";
        dom.studioTemplateRegions.innerHTML = "";
    }
    positionStudioSidebar({ dom, showingStudio });

    // ── Meme text ──
    if (!state.isEditingMemeText) dom.memeTextPreview.textContent = state.editor.overlayText;
    dom.studioTemplateArt.classList.toggle("editing-text",  state.isEditingMemeText);
    dom.studioTemplateArt.classList.toggle("text-selected", state.isTextSelected);
    dom.memeTextPreview.setAttribute("contenteditable", state.isEditingMemeText ? "true" : "false");
    dom.memeTextPreview.classList.toggle("hidden", !state.editor.overlayVisible);
    const isPlaceholder = (state.editor.overlayText || "").trim().toUpperCase() === "TAP TO EDIT TEXT";
    dom.memeTextPreview.classList.toggle("is-placeholder", isPlaceholder && !state.isEditingMemeText);
    dom.memeTextHint?.classList.toggle("hidden",
        showingStudio && (state.editor.overlayVisible || state.editor.frozenTextItems.length > 0)
    );

    // ── Text controls enabled state ──
    const noTextSelection  = !showingStudio || !state.editor.overlayVisible || !state.isTextSelected;
    const transformDisabled = noTextSelection || state.isTextLocked;
    dom.memeTextDelete.disabled     = noTextSelection;
    dom.memeTextRotateHandle.disabled = transformDisabled;
    dom.memeTextResizeHandles?.forEach((handle) => {
        handle.classList.toggle("hidden", transformDisabled);
        handle.disabled = transformDisabled;
    });

    dom.textToolbar.classList.toggle("hidden", !showingStudio);
    dom.textLocalControls.classList.toggle("hidden",
        !showingStudio || !state.editor.overlayVisible || !state.isTextSelected
    );

    const showTextPopups = showingStudio && state.editor.overlayVisible && state.isTextSelected;
    dom.textMoreMenu.classList.toggle("hidden", !showTextPopups || !state.showTextMore);

    // ── Border toggle ──
    if (dom.textBorderToggleCta) {
        const outlineOn = !!state.editor.overlayOutlineEnabled;
        dom.textBorderToggleCta.textContent = `border: ${outlineOn ? "on" : "off"}`;
        dom.textBorderToggleCta.classList.toggle("active", outlineOn);
        dom.textBorderToggleCta.disabled = noTextSelection;
        dom.textBorderToggleCta.setAttribute("aria-pressed", String(outlineOn));
    }
    if (dom.textMoreCta) {
        dom.textMoreCta.disabled = noTextSelection;
        dom.textMoreCta.classList.toggle("active", state.showTextMore);
        dom.textMoreCta.setAttribute("aria-expanded", String(showTextPopups && state.showTextMore));
    }

    // ── Toolbar values ──
    dom.textLockCta.textContent      = state.isTextLocked ? "🔒" : "🔓";
    dom.textLockCta.setAttribute("aria-label", state.isTextLocked ? "Unlock text position" : "Lock text position");
    dom.textLockCta.setAttribute("aria-pressed", String(state.isTextLocked));
    dom.memeFontSelect.value         = state.editor.overlayFontKey;
    dom.memeFontSizeInput.value      = String(Math.round(state.editor.overlayFontPx || 22));
    dom.memeTextColorInput.value     = getMemeTextColor(state.editor.overlayTextColor);
    dom.memeOutlineColorInput.value  = state.editor.overlayOutlineColor || "#ffffff";
    syncOutlineSwatchState();
    dom.textStyleBoldCta.classList.toggle("active",      state.editor.overlayBold);
    dom.textStyleItalicCta.classList.toggle("active",    state.editor.overlayItalic);
    dom.textStyleUnderlineCta.classList.toggle("active", state.editor.overlayUnderline);
    dom.textStyleBoldCta.setAttribute("aria-pressed",      String(state.editor.overlayBold));
    dom.textStyleItalicCta.setAttribute("aria-pressed",    String(state.editor.overlayItalic));
    dom.textStyleUnderlineCta.setAttribute("aria-pressed", String(state.editor.overlayUnderline));

    // ── Color swatches active state ──
    const currentColor = getMemeTextColor(state.editor.overlayTextColor);
    dom.colorSwatches?.forEach((swatch) => {
        const COLORS = { black: "#000000", white: "#ffffff", red: "#d62828", blue: "#2563eb", yellow: "#ffd60a" };
        const swatchHex = COLORS[swatch.dataset.colorKey];
        swatch.classList.toggle("active", swatchHex === currentColor);
    });

    // ── Character limit warning ──
    const charLen = (state.editor.overlayText || "").length;
    if (dom.memeTextCharWarn) {
        const showWarn = showingStudio && state.editor.overlayVisible && charLen >= MEME_TEXT_CHAR_WARN;
        dom.memeTextCharWarn.classList.toggle("hidden", !showWarn);
        if (showWarn) dom.memeTextCharWarn.textContent = `${charLen} / ${MEME_TEXT_CHAR_WARN} characters`;
    }

    // ── Face swap loader ──
    dom.faceSwapLoader.classList.toggle("hidden",      !state.isSubmittingFaceSwap);
    dom.faceSwapLoaderOptimizing.classList.toggle("hidden", !state.isOptimizingImage);
    dom.faceSwapLoaderDelay.classList.toggle("hidden", !state.showSlowFaceSwapMessage);

    // ── AI prompt load mode ──
    // Prompt-specific DOM details live in ai-prompting.js; render.js just composes sub-renders.
    _renderAiPromptLoadMode();

    // ── History buttons ──
    dom.undoCta.disabled  = state.editor.historyStack.length <= 1;
    dom.redoCta.disabled  = state.editor.futureStack.length === 0;
    dom.resetCta.disabled = !selectedTemplate;

    // ── Save status indicator ──
    if (dom.saveStatusEl) {
        const status = state.saveStatus || "idle";
        const isActive = showingStudio && status !== "idle";
        const label = status === "saving" ? "Saving..." : status === "saved" ? "Saved" : status === "failed" ? "Failed" : "";
        dom.saveStatusEl.textContent = label;
        dom.saveStatusEl.className = "save-status-indicator " + status + (isActive ? " visible" : "");
    }

    // ── Progress ──
    dom.progressWrap.classList.toggle("hidden",
        !(state.status === STATES.LOADING_IMAGE || state.status === STATES.DETECTING)
    );
    if (state.status === STATES.LOADING_IMAGE) { dom.progressBar.value = 40;  dom.progressLabel.textContent = "Loading image..."; }
    if (state.status === STATES.DETECTING)     { dom.progressBar.value = 80;  dom.progressLabel.textContent = "Detecting faces..."; }

    // ── Error ──
    const errorCode = state.error?.code || "";
    const errorMessage = getLoadErrorMessage(state.error);
    dom.errorState.classList.toggle("hidden", !state.error && state.status !== STATES.ERROR);
    dom.errorMessage.textContent = errorMessage;
    const showRetry = Boolean(state.error) && (RETRYABLE_LOAD_ERROR_CODES.has(errorCode) || state.lastRetryableAction === "face_swap");
    dom.errorRetryCta?.classList.toggle("hidden", !showRetry);
    dom.errorNewPhotoCta?.classList.toggle("hidden", !NEW_PHOTO_ERROR_CODES.has(errorCode));

    // ── Preview image ──
    if (state.previewUrl && dom.previewImage.src !== state.previewUrl) {
        dom.previewImage.src = state.previewUrl;
    }

    // ── Status text ──
    if (state.status === STATES.FACES_FOUND) {
        dom.statusText.textContent = selectableFaceLimit > 1
        ? `${state.faces.length} faces found. Select up to ${selectableFaceLimit} faces for this template.`
        : `${state.faces.length} faces found. Tap or click one face to continue.`;
    } else if (state.status === STATES.READY) {
        if      (state.manualMode && state.error?.code === "NO_FACE_DETECTED")    dom.statusText.textContent = "No face detected. Use the oval to choose the face manually.";
        else if (state.manualMode && state.error?.code === "DETECTOR_UNAVAILABLE") dom.statusText.textContent = "Face detection could not load. Use the oval to choose the face manually.";
        else if (state.manualMode && state.error)                                  dom.statusText.textContent = "Face detection had trouble. Use the oval to choose the face manually.";
        else if (state.manualMode && state.usedDetectedFace)                       dom.statusText.textContent = "Face detected. Drag to fine tune the fit inside the oval.";
        else if (state.manualMode)                                                 dom.statusText.textContent = "Drag the photo until the face sits inside the oval.";
        else if (selectableFaceLimit > 1 && selectedFaceCount === 0)               dom.statusText.textContent = "Select a face to continue.";
        else if (selectableFaceLimit > 1 && selectedFaceCount > 1)                 dom.statusText.textContent = `${selectedFaceCount} faces selected and ready.`;
        else if (selectableFaceLimit > 1)                                          dom.statusText.textContent = `${selectedFaceCount || 1} face selected. Select another face or continue.`;
        else if (state.faces.length > 1 && selectedFaceCount === 1) {
            const selectedIdx = state.faces.findIndex((f) => state.selectedFaceIds.includes(f.id));
            dom.statusText.textContent = `Face ${selectedIdx + 1} of ${state.faces.length} selected`;
        }
        else                                                                       dom.statusText.textContent = "Face selected and ready.";
    } else {
        dom.statusText.textContent = "";
    }

    // ── Continue / manual controls ──
    dom.continueBtn.disabled = state.status !== STATES.READY || (!state.manualMode && selectedFaceCount === 0);
    dom.continueBtn.classList.toggle("hidden", !editingPhoto || showingTemplates);
    dom.manualOverlay.classList.toggle("hidden",  !state.manualMode);
    dom.manualControls.classList.toggle("hidden", !state.manualMode);

    // ── Sub-renders ──
    applyManualTransform();
    _renderOverlay();
    renderFrozenTextItems();
    syncMemeTextAppearance();
    _renderAiPromptHistory();
}
