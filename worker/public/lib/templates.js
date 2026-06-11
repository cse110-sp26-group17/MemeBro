/**
 * @module templates
 * Template catalog, rendering, and navigation.
 * Handles fetching the meme template list, rendering template cards into
 * the sidebar, tracking recently-used templates, and tab/search filtering.
 */

import { RECENTS_STORAGE_KEY } from "./constants.js";
import { state } from "./state.js";
import { recentMemeStorage } from "../js/recents.js";

let recentThumbnailUrls = [];
let templateRenderSequence = 0;
let lastRenderedTemplateTab = state.activeTemplateTab;

function clearRecentThumbnailUrls() {
    recentThumbnailUrls.forEach((url) => URL.revokeObjectURL(url));
    recentThumbnailUrls = [];
}

// ── Image source helpers ─────────────────────

export function getTemplatePreviewImage(template) {
    return template?.previewImage
        || template?.images?.preview
        || template?.images?.thumbnail
        || template?.images?.main
        || "/assets/memes/placeholder-preview.svg";
}

export function getTemplateMainImage(template) {
    return template?.templateImage
        || template?.images?.main
        || getTemplatePreviewImage(template)
        || "/assets/memes/placeholder.svg";
}

export function getTemplateImageDimensions(template) {
    return {
        width:  Math.max(1, Number(template?.images?.width)  || 1),
        height: Math.max(1, Number(template?.images?.height) || 1),
    };
}

export function getTemplateImageSources(primarySource, fallbacks = []) {
    return [primarySource, ...fallbacks]
        .filter(Boolean)
        .filter((source, index, list) => list.indexOf(source) === index);
}

export function updateImageWithFallback(image, sources) {
    if (!image) return;
    const serializedSources = JSON.stringify(sources);
    const nextSource = sources[0] || "";
    if (
        image.dataset.fallbackSources === serializedSources
        && image.dataset.fallbackIndex === "0"
        && image.getAttribute("src") === nextSource
    ) return;
    image.dataset.fallbackSources = serializedSources;
    image.dataset.fallbackIndex   = "0";
    image.src = nextSource;
}

// ── Template sizing ──────────────────────────

export function getStudioTemplateBox(template) {
    const { width, height } = getTemplateImageDimensions(template);
    const viewportWidth  = typeof window !== "undefined" ? window.innerWidth  : 1280;
    const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 900;
    const isCompact = viewportWidth <= 899;
    const reservedHeight = isCompact ? 285 : 255;
    const sideReserve = isCompact ? 0 : Math.min(420, viewportWidth * 0.30);
    const maxWidth = Math.max(220, isCompact
        ? viewportWidth - sideReserve
        : Math.min(viewportWidth - sideReserve - 48, viewportWidth * 0.62, 760));
    const maxHeight = Math.max(220, isCompact
        ? viewportHeight - reservedHeight
        : Math.min(viewportHeight - reservedHeight, viewportHeight * 0.76, 780));
    const scale = Math.min(maxWidth / width, maxHeight / height);
    return {
        width:  Math.max(1, Math.round(width  * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
}

// ── Catalog lookups ──────────────────────────

export function getSelectedTemplate() {
    return state.templateCatalog.find((t) => t.id === state.selectedTemplateId);
}

export function getTemplateFaceCapacity() {
    const template = getSelectedTemplate();
    return Math.max(1, template?.faceRegions?.length || 1);
}

export function extractGeneratedImageUrl(payload) {
    return payload?.generatedImageUrl
        || payload?.imageUrl
        || payload?.compositedImageUrl
        || payload?.compositedImage
        || payload?.outputUrl
        || payload?.url
        || (payload?.b64 ? `data:${payload.mimeType || "image/png"};base64,${payload.b64}` : "")
        || "";
}

// ── Recents ──────────────────────────────────

export function getRecentTemplateIds() {
    try {
        const parsed = JSON.parse(localStorage.getItem(RECENTS_STORAGE_KEY) || "{}");
        return Object.entries(parsed)
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => id);
    } catch {
        return [];
    }
}

export function recordTemplateUsage(templateId) {
    let usageMap = {};
    try {
        usageMap = JSON.parse(localStorage.getItem(RECENTS_STORAGE_KEY) || "{}") || {};
    } catch {
        usageMap = {};
    }
    usageMap[templateId] = Date.now();
    localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(usageMap));
}

export function getVisibleTemplates() {
    const query  = state.templateSearchQuery.trim().toLowerCase();
    const sorted = [...state.templateCatalog].sort((a, b) => b.popularityScore - a.popularityScore);
    const tabTemplates = state.activeTemplateTab === "recents"
        ? getRecentTemplateIds()
            .map((id) => state.templateCatalog.find((t) => t.id === id))
            .filter(Boolean)
        : sorted;
    if (!query) return tabTemplates;
    return tabTemplates.filter((template) => {
        const fields = [template.name, ...(template.tags || [])];
        return fields.some((field) => field.toLowerCase().includes(query));
    });
}

// ── Catalog loading ──────────────────────────

export function syncTemplateTabs({ dom }) {
    [...dom.templateTabs.querySelectorAll("[data-tab]")].forEach((button) => {
        const active = button.dataset.tab === state.activeTemplateTab;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
    });
}

function getRecentMemeTitle(metadata) {
    const text = String(metadata?.textContent || "").trim();
    if (text) return text;
    const mode = String(metadata?.mode || "text").replace(/_/g, " ");
    return `${mode} meme`;
}

function getRecentMemeAlt(metadata) {
    return `Recent meme saved ${new Date(metadata.savedAt).toLocaleString()}`;
}

function matchesRecentMemeQuery(metadata, query) {
    if (!query) return true;
    const fields = [
        metadata.id,
        metadata.mode,
        metadata.textContent,
        new Date(metadata.savedAt).toLocaleString(),
    ];
    return fields.some((field) => String(field || "").toLowerCase().includes(query));
}

function renderRecentsEmptyState({ dom, renderTemplates }) {
    dom.templateEmpty.classList.remove("hidden");
    dom.templateEmpty.innerHTML = "";

    const title = document.createElement("span");
    title.className = "template-empty-title";
    title.textContent = "No Recent Memes Yet.";

    const copy = document.createElement("span");
    copy.className = "template-empty-copy";
    copy.textContent = "Create your first meme from the Trending Tab";

    const cta = document.createElement("button");
    cta.type = "button";
    cta.className = "template-empty-cta";
    cta.textContent = "Trending";
    cta.addEventListener("click", () => {
        state.activeTemplateTab = "trending";
        syncTemplateTabs({ dom });
        renderTemplates();
    });

    dom.templateEmpty.append(title, copy, cta);
}

function renderNoMatchingRecents({ dom }) {
    dom.templateEmpty.classList.remove("hidden");
    dom.templateEmpty.textContent = "No matching recent memes.";
}

async function createRecentMemeCard(metadata, index, { openStudioForRecentMeme }) {
    const thumbnail = await recentMemeStorage.getThumbnail(metadata.id);
    const card = document.createElement("button");
    card.type = "button";
    card.className = "template-card recent-meme-card";
    card.dataset.recentMemeId = metadata.id;
    card.style.setProperty("--template-hue", String((index * 37) % 360));

    const art = document.createElement("span");
    art.className = "template-art";
    art.style.aspectRatio = `${thumbnail?.width || metadata.thumbnail?.width || 1} / ${thumbnail?.height || metadata.thumbnail?.height || 1}`;

    const previewImage = document.createElement("img");
    previewImage.className = "template-art-image";
    previewImage.alt = getRecentMemeAlt(metadata);
    previewImage.loading = "eager";
    previewImage.decoding = "async";
    previewImage.width = thumbnail?.width || metadata.thumbnail?.width || 256;
    previewImage.height = thumbnail?.height || metadata.thumbnail?.height || 256;
    previewImage.addEventListener("load", () => {
        art.classList.add("image-ready");
        previewImage.classList.add("is-loaded");
    });
    previewImage.addEventListener("error", () => {
        art.classList.add("image-error");
    });

    if (thumbnail?.blob) {
        const objectUrl = URL.createObjectURL(thumbnail.blob);
        recentThumbnailUrls.push(objectUrl);
        previewImage.src = objectUrl;
    } else {
        previewImage.src = "/assets/memes/placeholder-preview.svg";
    }

    const initials = document.createElement("span");
    initials.className = "template-initials";
    initials.textContent = "R";

    const name = document.createElement("span");
    name.className = "template-name";
    name.textContent = getRecentMemeTitle(metadata);

    art.append(previewImage, initials);
    card.append(art, name);
    card.addEventListener("click", () => openStudioForRecentMeme(metadata.id));
    return card;
}

async function renderRecentMemes({ dom, openStudioForRecentMeme, renderTemplates, sequence }) {
    const query = state.templateSearchQuery.trim().toLowerCase();
    const metadata = recentMemeStorage.list();
    const recents = metadata.filter((item) => matchesRecentMemeQuery(item, query));
    dom.templateGrid.innerHTML = "";

    if (metadata.length === 0) {
        renderRecentsEmptyState({ dom, renderTemplates });
        return;
    }

    if (recents.length === 0) {
        renderNoMatchingRecents({ dom });
        return;
    }

    dom.templateEmpty.classList.add("hidden");
    const cards = await Promise.all(
        recents.map((item, index) => createRecentMemeCard(item, index, { openStudioForRecentMeme }))
    );
    if (sequence !== templateRenderSequence || state.activeTemplateTab !== "recents") return;
    dom.templateGrid.innerHTML = "";
    cards.forEach((card) => dom.templateGrid.appendChild(card));
}

export async function loadTemplateCatalog({ loadTemplates }) {
    if (state.templateCatalog.length) return;
    try {
        const catalog = await loadTemplates();
        state.templateCatalog = Array.isArray(catalog.templates) ? catalog.templates : [];
    } catch {
        state.templateCatalog = [];
    }
}

// ── DOM rendering ────────────────────────────

export async function renderTemplates({ dom, clamp, openStudioForTemplate, openStudioForRecentMeme }) {
    const sequence = ++templateRenderSequence;
    const previousTemplateTab = lastRenderedTemplateTab;
    lastRenderedTemplateTab = state.activeTemplateTab;
    if (previousTemplateTab === "recents" && state.activeTemplateTab !== "recents") {
        clearRecentThumbnailUrls();
    }

    if (state.activeTemplateTab === "recents") {
        await renderRecentMemes({
            dom,
            openStudioForRecentMeme,
            renderTemplates: () => renderTemplates({ dom, clamp, openStudioForTemplate, openStudioForRecentMeme }),
            sequence,
        });
        return;
    }

    const templates = getVisibleTemplates();
    dom.templateGrid.innerHTML = "";
    dom.templateEmpty.classList.toggle("hidden", templates.length > 0);

    templates.forEach((template, index) => {
        const { width, height } = getTemplateImageDimensions(template);
        const card = document.createElement("button");
        card.type = "button";
        card.className = "template-card";
        card.dataset.templateId = template.id;
        card.style.setProperty("--template-hue", String((index * 37) % 360));

        const art = document.createElement("span");
        art.className = "template-art";
        art.style.aspectRatio = `${width} / ${height}`;

        const previewImage = document.createElement("img");
        previewImage.className  = "template-art-image";
        previewImage.alt        = template.name;
        previewImage.loading    = "lazy";
        previewImage.decoding   = "async";
        previewImage.width      = width;
        previewImage.height     = height;
        previewImage.addEventListener("load", () => {
        art.classList.add("image-ready");
        previewImage.classList.add("is-loaded");
        });
        previewImage.addEventListener("error", () => {
        const sources   = JSON.parse(previewImage.dataset.fallbackSources || "[]");
        const nextIndex = Number(previewImage.dataset.fallbackIndex || "0") + 1;
        if (nextIndex < sources.length) {
            previewImage.dataset.fallbackIndex = String(nextIndex);
            previewImage.src = sources[nextIndex];
            return;
        }
        art.classList.add("image-error");
        });
        updateImageWithFallback(previewImage, getTemplateImageSources(
        getTemplatePreviewImage(template),
        [template.images?.thumbnail, getTemplateMainImage(template), "/assets/memes/placeholder-preview.svg"]
        ));

        const initials = document.createElement("span");
        initials.className   = "template-initials";
        initials.textContent = template.name.split(/\s+/).slice(0, 2).map((w) => w[0]).join("");

        const regions = document.createElement("span");
        regions.className = "template-regions";
        (template.faceRegions || []).slice(0, 4).forEach((region) => {
        const marker = document.createElement("span");
        marker.className    = "template-region";
        marker.style.left   = `${(region.x / width) * 100}%`;
        marker.style.top    = `${(region.y / height) * 100}%`;
        marker.style.width  = `${Math.max(12, (region.width  / width)  * 100)}%`;
        marker.style.height = `${Math.max(12, (region.height / height) * 100)}%`;
        regions.appendChild(marker);
        });

        const name = document.createElement("span");
        name.className   = "template-name";
        name.textContent = template.name;

        art.append(previewImage, initials, regions);
        card.append(art, name);
        card.addEventListener("click", () => openStudioForTemplate(template.id));
        if (state.selectedTemplateId === template.id) card.classList.add("selected");
        dom.templateGrid.appendChild(card);
    });
}

export function renderStudioTemplate(template, { dom, state: _state }) {
    if (!template) return;
    const { width, height } = getTemplateImageDimensions(template);
    const box = getStudioTemplateBox(template);
    const studioImageSources = getTemplateImageSources(
        _state.editor.generatedImage || _state.editor.templateImage || getTemplateMainImage(template),
        [getTemplateMainImage(template), getTemplatePreviewImage(template), "/assets/memes/placeholder.svg"]
    );
    const serialized = JSON.stringify(studioImageSources);
    const shouldReset = dom.studioTemplateImage.dataset.fallbackSources !== serialized;

    dom.studioTemplateArt.style.setProperty(
        "--template-hue",
        String(Math.abs(template.id.split("").reduce((sum, ch) => sum + ch.charCodeAt(0), 0)) % 360)
    );
    dom.studioTemplateArt.style.width  = `${box.width}px`;
    dom.studioTemplateArt.style.height = `${box.height}px`;
    dom.studioTemplateInitials.textContent = template.name.split(/\s+/).slice(0, 2).map((w) => w[0]).join("");
    dom.studioTemplateRegions.innerHTML = "";

    if (shouldReset) {
        dom.studioTemplateArt.classList.remove("image-ready", "image-error");
        dom.studioTemplateImage.classList.remove("is-loaded");
    }
    dom.studioTemplateImage.alt = template.name;
    updateImageWithFallback(dom.studioTemplateImage, studioImageSources);

    if (!_state.editor.generatedImage) {
        (template.faceRegions || []).slice(0, 4).forEach((region) => {
            const marker = document.createElement("span");
            marker.className    = "studio-template-region";
            marker.style.left   = `${(region.x / width)  * 100}%`;
            marker.style.top    = `${(region.y / height) * 100}%`;
            marker.style.width  = `${Math.max(10, (region.width  / width)  * 100)}%`;
            marker.style.height = `${Math.max(10, (region.height / height) * 100)}%`;
            dom.studioTemplateRegions.appendChild(marker);
        });
    }
}

// ── Navigation ───────────────────────────────

export async function openStudioForTemplate(templateId, { recordTemplateUsage: recordUsage, initializeEditorState, restoreEditorSession, persistEditorHistory, render, STATES: S }) {
    const hadEdits = state.selectedTemplateId
        && state.selectedTemplateId !== templateId
        && state.editor.historyStack.length > 1;
    if (hadEdits) {
        const ok = window.confirm("Switching templates will reset your edits. Continue?");
        if (!ok) return;
    }
    state.selectedTemplateId   = templateId;
    state.status               = S.IDLE;
    state.view                 = "studio";
    state.uploadModalOpen      = false;
    state.isEditingMemeText    = false;
    state.showResetConfirmation = false;
    state.showBackConfirmation  = false;
    initializeEditorState();
    if (!(await restoreEditorSession())) persistEditorHistory();
    render();
}

export async function showTemplateSelection({ loadTemplates: _loadTemplates, dom, render, renderTemplates: _renderTemplates }) {
    await loadTemplateCatalog({ loadTemplates: _loadTemplates });
    state.view                 = "templates";
    state.activeTemplateTab    = "trending";
    state.templateSearchQuery  = "";
    dom.templateSearch.value   = "";
    syncTemplateTabs({ dom });
    render();
    _renderTemplates();
}
