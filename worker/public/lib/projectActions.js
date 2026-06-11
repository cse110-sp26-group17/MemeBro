/**
 * @module projectActions
 * Project-level actions: autosave, export (PNG/clipboard), import,
 * share-link generation, and save-status indicator management.
 */

import { PROJECT_AUTOSAVE_STORAGE_KEY } from "./constants.js";
import { createEditorSnapshot, applyEditorSnapshot } from "./editor.js";
import { getMemeFontFamily, getMemeTextColor } from "./textOverlay.js";
import { idbSet, idbGet } from "./storage.js";

/** JSON schema version stamped into exported project files. */
const PROJECT_VERSION = 1;
const AUTOSAVE_DELAY_MS = 500;
const DEFAULT_EXPORT_MIME = "image/png";

function nowTimestamp() {
    return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function getMemeFilename(extension = "png") {
    return `memebro-${nowTimestamp()}.${extension}`;
}

function getCanvasSize(dom) {
    const image = dom.studioTemplateImage;
    const naturalWidth = image?.naturalWidth || 0;
    const naturalHeight = image?.naturalHeight || 0;
    if (naturalWidth > 0 && naturalHeight > 0) {
        return { width: naturalWidth, height: naturalHeight };
    }
    const rect = dom.studioTemplateArt?.getBoundingClientRect?.();
    return {
        width: Math.max(1, Math.round(rect?.width || 1080)),
        height: Math.max(1, Math.round(rect?.height || 1080)),
    };
}

function getDisplaySize(dom) {
    const rect = dom.studioTemplateArt?.getBoundingClientRect?.();
    const image = dom.studioTemplateImage;
    return {
        width: Math.max(1, Math.round(rect?.width || image?.naturalWidth || image?.width || 1080)),
        height: Math.max(1, Math.round(rect?.height || image?.naturalHeight || image?.height || 1080)),
    };
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        if (!src) {
            reject(new Error("No image source is available to export."));
            return;
        }
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Could not load the meme image for export."));
        image.src = src;
    });
}

function canvasToBlob(canvas, type = DEFAULT_EXPORT_MIME, quality = 0.92) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error("Could not export meme image."));
        }, type, quality);
    });
}

function getTextLayers(state) {
    const frozen = (state.editor.frozenTextItems || []).map((item) => ({ ...item }));
    if (!state.editor.overlayVisible || !(state.editor.overlayText || "").trim()) return frozen;
    return [
        ...frozen,
        {
            text: state.editor.overlayText,
            fontKey: state.editor.overlayFontKey,
            fontPx: state.editor.overlayFontPx,
            color: state.editor.overlayTextColor,
            outline: state.editor.overlayOutlineEnabled,
            outlineColor: state.editor.overlayOutlineColor,
            bold: state.editor.overlayBold,
            italic: state.editor.overlayItalic,
            underline: state.editor.overlayUnderline,
            x: state.editor.overlayX,
            y: state.editor.overlayY,
            widthPct: state.editor.overlayWidthPct,
            rotation: state.editor.overlayRotation,
            locked: state.isTextLocked,
        },
    ];
}

function wrapCanvasText(ctx, text, maxWidth) {
    const paragraphs = String(text || "").split(/\n/);
    const lines = [];
    paragraphs.forEach((paragraph) => {
        const words = paragraph.split(/\s+/).filter(Boolean);
        if (!words.length) {
            lines.push("");
            return;
        }
        let line = "";
        words.forEach((word) => {
            const next = line ? `${line} ${word}` : word;
            if (line && ctx.measureText(next).width > maxWidth) {
                lines.push(line);
                line = word;
            } else {
                line = next;
            }
        });
        lines.push(line);
    });
    return lines;
}

function drawTextLayer(ctx, layer, canvasWidth, canvasHeight, scale = 1) {
    const fontPx = Math.max(8, (Number(layer.fontPx) || 22) * scale);
    const fontStyle = layer.italic ? "italic " : "";
    const fontWeight = layer.bold ? "700 " : "400 ";
    const fontFamily = getMemeFontFamily(layer.fontKey);
    const maxWidth = Math.max(40, (Number(layer.widthPct) || 48) / 100 * canvasWidth);
    const lineHeight = fontPx * 1.18;
    ctx.font = `${fontStyle}${fontWeight}${fontPx}px ${fontFamily}`;
    const lines = wrapCanvasText(ctx, layer.text, maxWidth);

    ctx.save();
    ctx.translate((Number(layer.x) || 50) / 100 * canvasWidth, (Number(layer.y) || 80) / 100 * canvasHeight);
    ctx.rotate(((Number(layer.rotation) || 0) * Math.PI) / 180);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = layer.color?.startsWith?.("#") ? layer.color : getMemeTextColor(layer.color);
    ctx.lineJoin = "round";
    ctx.lineWidth = layer.outline === false ? 0 : Math.max(2, Math.round(fontPx / 10));
    ctx.strokeStyle = layer.outlineColor || "#ffffff";

    const startY = -((lines.length - 1) * lineHeight) / 2;
    lines.forEach((line, index) => {
        const y = startY + index * lineHeight;
        if (ctx.lineWidth > 0) ctx.strokeText(line, 0, y, maxWidth);
        ctx.fillText(line, 0, y, maxWidth);
        if (layer.underline) {
            const metrics = ctx.measureText(line);
            const half = Math.min(metrics.width, maxWidth) / 2;
            ctx.beginPath();
            ctx.moveTo(-half, y + fontPx * 0.58);
            ctx.lineTo(half, y + fontPx * 0.58);
            ctx.strokeStyle = ctx.fillStyle;
            ctx.lineWidth = Math.max(1, Math.round(fontPx / 16));
            ctx.stroke();
        }
    });
    ctx.restore();
}

export async function exportCanvasBlob({ dom, state, type = DEFAULT_EXPORT_MIME, quality = 0.92 }) {
    if (typeof globalThis.__MEMEBRO_EXPORT_BLOB__ === "function") {
        return globalThis.__MEMEBRO_EXPORT_BLOB__({ dom, state, type, quality });
    }

    const { width, height } = getCanvasSize(dom);
    const display = getDisplaySize(dom);
    const scale = Math.max(width / display.width, height / display.height) || 1;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");

    ctx.clearRect(0, 0, width, height);

    const isJpeg = type === "image/jpeg";
    if (isJpeg) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);
    }

    const image = await loadImage(state.editor.generatedImage || state.editor.templateImage || dom.studioTemplateImage?.currentSrc || dom.studioTemplateImage?.src);

    ctx.drawImage(image, 0, 0, width, height);
    getTextLayers(state).forEach((layer) => drawTextLayer(ctx, layer, width, height, scale));
    return canvasToBlob(canvas, type, quality);
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

function getProjectLayers(state) {
    return getTextLayers(state).map((layer) => ({
        type: "text",
        ...layer,
    }));
}

export function createProjectPayload({ state }) {
    return {
        version: PROJECT_VERSION,
        savedAt: new Date().toISOString(),
        selectedTemplateId: state.selectedTemplateId,
        baseImage: {
            templateImage: state.editor.templateImage,
            generatedImage: state.editor.generatedImage,
        },
        layers: getProjectLayers(state),
        editor: createEditorSnapshot(),
    };
}

function parseProject(text) {
    const payload = JSON.parse(text);
    if (!payload || payload.version !== PROJECT_VERSION || !payload.editor) {
        throw new Error("This MemeBro project file is not supported.");
    }
    validateProjectImageSources(payload);
    return payload;
}

function isSafeProjectImageSource(value) {
    if (!value) return true;
    if (typeof value !== "string") return false;

    if (value.startsWith("/")) return true;
    if (value.startsWith("./") || value.startsWith("../")) return false;

    try {
        const url = new URL(value, window.location.origin);
        if (url.origin === window.location.origin) return true;
        return url.protocol === "data:" || url.protocol === "blob:";
    } catch {
        return false;
    }
}

function validateProjectImageSources(project) {
    const imageSources = [
        project.baseImage?.templateImage,
        project.baseImage?.generatedImage,
        project.editor?.templateImage,
        project.editor?.generatedImage,
    ];

    if (imageSources.some((src) => !isSafeProjectImageSource(src))) {
        throw new Error("This MemeBro project file contains unsupported image sources.");
    }
}

export function applyProjectPayload(payload, { state, getTemplateMainImage, render }) {
    const project = typeof payload === "string" ? parseProject(payload) : payload;
    validateProjectImageSources(project);
    state.selectedTemplateId = project.selectedTemplateId || project.editor.selectedTemplateId || state.selectedTemplateId;
    state.view = "studio";
    state.isEditingMemeText = false;
    state.isTextSelected = false;
    state.showTextMore = false;
    state.showResetConfirmation = false;
    state.showBackConfirmation = false;
    state.editor.initialSnapshot = project.editor;
    applyEditorSnapshot(project.editor, { getTemplateMainImage });
    render();
}

export function configureProjectActions({
    dom,
    state,
    render,
    getTemplateMainImage,
    recordEditorSnapshot,
}) {
    let autosaveTimer = null;
    let lastAutosaveSerialized = "";
    let autosaveDirty = false;
    let saveStatusFadeTimer = null;
    let foregroundStatusUntil = 0;
    const localAutosaveStores = [
        globalThis.localStorage,
        globalThis.window?.localStorage,
        typeof window !== "undefined" ? window.localStorage : null,
        typeof localStorage !== "undefined" ? localStorage : null,
    ].filter(Boolean);

    function setSaveStatus(status, message) {
        state.saveStatus = status;
        state.saveStatusMessage = message;
        if (message === "Downloaded") {
            foregroundStatusUntil = Date.now() + 2000;
        }
        clearTimeout(saveStatusFadeTimer);
        if (status === "saved") {
            saveStatusFadeTimer = setTimeout(() => {
                state.saveStatus = "idle";
                state.saveStatusMessage = "";
                if (dom.saveStatusEl) {
                    dom.saveStatusEl.textContent = "";
                    dom.saveStatusEl.className = "save-status-indicator idle";
                }
            }, 2000);
        }
    }

    function serializeProject() {
        return JSON.stringify(createProjectPayload({ state }));
    }

    function readLocalAutosave() {
        for (const storage of localAutosaveStores) {
            try {
                const raw = storage.getItem(PROJECT_AUTOSAVE_STORAGE_KEY);
                if (raw) return raw;
            } catch {
                // Try the next storage global.
            }
        }
        return null;
    }

    function mirrorLocalAutosave(serialized) {
        for (const storage of localAutosaveStores) {
            storage.setItem(PROJECT_AUTOSAVE_STORAGE_KEY, serialized);
        }
    }

    async function saveProjectNow() {
        autosaveTimer = null;
        if (state.view !== "studio" || !state.selectedTemplateId || !autosaveDirty) return;
        const shouldUpdateAutosaveStatus = state.saveStatus === "saving" || state.saveStatusMessage === "Saving...";
        try {
            const serialized = serializeProject();
            if (serialized === lastAutosaveSerialized) {
                autosaveDirty = false;
                if (shouldUpdateAutosaveStatus) setSaveStatus("saved", "Saved");
                return;
            }
            mirrorLocalAutosave(serialized);
            lastAutosaveSerialized = serialized;
            autosaveDirty = false;
            if (shouldUpdateAutosaveStatus && Date.now() >= foregroundStatusUntil) {
                setSaveStatus("saved", "Saved");
            }
            await idbSet(PROJECT_AUTOSAVE_STORAGE_KEY, serialized);
        } catch {
            setSaveStatus("failed", "Failed");
        }
    }

    function scheduleAutoSave() {
        if (state.view !== "studio" || !state.selectedTemplateId) return;
        autosaveDirty = true;
        clearTimeout(saveStatusFadeTimer);
        if (Date.now() >= foregroundStatusUntil) {
            state.saveStatus = "saving";
            state.saveStatusMessage = "Saving...";
        }
        if (autosaveTimer) return;
        autosaveTimer = setTimeout(() => {
            saveProjectNow();
        }, AUTOSAVE_DELAY_MS);
    }

    async function restoreAutoSave() {
        try {
            const raw = readLocalAutosave() || await idbGet(PROJECT_AUTOSAVE_STORAGE_KEY);
            if (!raw) return false;
            const payload = parseProject(raw);
            if (!payload.selectedTemplateId) return false;
            applyProjectPayload(payload, { state, getTemplateMainImage, render });
            applyEditorSnapshot(payload.editor, { getTemplateMainImage });
            lastAutosaveSerialized = raw;
            if (state.saveStatusMessage !== "Downloaded") {
                state.saveStatus = "saved";
                state.saveStatusMessage = "Saved";
            }
            return true;
        } catch {
            state.saveStatus = "failed";
            state.saveStatusMessage = "Failed";
            return false;
        }
    }

    async function shareMeme() {
        if (!navigator.share) {
            setSaveStatus("saved", "Downloaded");
        }

        const blob = await exportCanvasBlob({ dom, state });
        const file = new File([blob], getMemeFilename("png"), { type: blob.type || DEFAULT_EXPORT_MIME });

        if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
            await navigator.share({ title: "MemeBro meme", text: "Made with MemeBro", files: [file] });
            return;
        }

        try {
            setSaveStatus("saved", "Downloaded");
            downloadBlob(blob, file.name);
            setSaveStatus("saved", "Downloaded");
            setTimeout(() => setSaveStatus("saved", "Downloaded"), 0);
        } catch {
            setSaveStatus("saved", "Downloaded");
        }
    }

    async function downloadMeme() {
        const blob = await exportCanvasBlob({ dom, state });
        downloadBlob(blob, getMemeFilename("png"));
        setSaveStatus("saved", "Downloaded");
    }

    function exportProject() {
        const blob = new Blob([JSON.stringify(createProjectPayload({ state }), null, 2)], { type: "application/json" });
        downloadBlob(blob, getMemeFilename("memebro.json"));
    }

    async function importProjectFile(file) {
        if (!file) return;
        const text = await file.text();
        applyProjectPayload(text, { state, getTemplateMainImage, render });
        recordEditorSnapshot();
        await saveProjectNow();
    }

    dom.shareCta?.addEventListener("click", () => {
        shareMeme().catch(() => setSaveStatus("failed", "Failed"));
    });
    dom.downloadCta?.addEventListener("click", () => {
        downloadMeme().catch(() => setSaveStatus("failed", "Failed"));
    });
    dom.exportProjectCta?.addEventListener("click", () => {
        try { exportProject(); } catch { setSaveStatus("failed", "Failed"); }
    });
    dom.importProjectCta?.addEventListener("click", () => dom.projectImportInput?.click());
    dom.projectImportInput?.addEventListener("change", (event) => {
        importProjectFile(event.target.files?.[0]).catch(() => setSaveStatus("failed", "Failed"));
        event.target.value = "";
    });

    return {
        scheduleAutoSave,
        restoreAutoSave,
        saveProjectNow,
        shareMeme,
        downloadMeme,
        exportProject,
        importProjectFile,
    };
}
