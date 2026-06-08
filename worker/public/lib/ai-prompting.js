/**
 * @module ai-prompting
 * AI prompt panel logic: character counting, form submission, history
 * rendering, and load-state transitions for the AI variant generator.
 */

import { getLoadErrorMessage } from "./loadErrors.js";
import { createEditorSnapshot } from "./editor.js";

/** Maximum characters allowed in the AI prompt input. */
const AI_PROMPT_CHARACTER_LIMIT = 500;
const AI_PROMPT_COUNTER_WARNING_AT = AI_PROMPT_CHARACTER_LIMIT - 50;
const AI_PROMPT_PLACEHOLDER_RESPONSE = "Got it. AI variant generation will use this prompt once connected.";

// Give the browser a paint before resolving the placeholder response so load mode is visible.
function waitForAiPromptFrame() {
    return new Promise((resolve) => {
        if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(() => resolve());
            return;
        }
        setTimeout(resolve, 0);
    });
}

export async function requestAiPromptVariant(prompt, templateImageSrc) {
    // Test override: allows unit tests to stub the network call.
    if (typeof globalThis.__MEMEBRO_AI_PROMPT_REQUEST__ === "function") {
        return globalThis.__MEMEBRO_AI_PROMPT_REQUEST__(prompt);
    }

    const payload = { mode: "ai_prompt", prompt };

    // Include the current template/generated image so OpenAI edits it
    // instead of generating a brand-new image.
    if (templateImageSrc) {
        const b64 = templateImageSrc.startsWith("data:")
            ? templateImageSrc.replace(/^data:[^,]+,/, "")
            : await fetchImageAsBase64(templateImageSrc);
        if (b64) {
            payload.referenceB64 = b64;
            payload.referenceMime = "image/png";
        }
    }

    const response = await fetch("/api/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const error = new Error(body?.message || `Request failed with HTTP ${response.status}.`);
        error.code = body?.code || "AI_PROMPT_FAILED";
        throw error;
    }

    const data = await response.json();
    return { text: data?.text || "AI variant generated.", imageUrl: data?.b64 ? `data:image/png;base64,${data.b64}` : data?.url || null };
}

async function fetchImageAsBase64(url) {
    try {
        const res = await fetch(url);
        const blob = await res.blob();
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result?.replace(/^data:[^,]+,/, "") || null);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
        });
    } catch {
        return null;
    }
}

function getAiPromptCharacters(value) {
    return [...value];
}

export function renderAiPromptHistory({ dom, state }) {
    if (!dom.aiPromptHistory) return;
    const messages = state.aiPromptHistory.length
        ? state.aiPromptHistory
        : [{ role: "system", text: "Tell me what to change — caption, mood, style, or face-swap direction." }];

    dom.aiPromptHistory.innerHTML = "";
    messages.forEach((message) => {
        const node = document.createElement("article");
        node.className = `ai-prompt-message ai-prompt-message--${message.role}`;
        node.textContent = message.text;
        dom.aiPromptHistory.appendChild(node);
    });
    dom.aiPromptHistory.scrollTop = dom.aiPromptHistory.scrollHeight;
}

export function renderAiPromptLoadMode({ dom, state }) {
    const isBusy = state.aiPrompt?.requestState === "submitting";
    const errorCode = state.aiPrompt?.error?.code || "";
    const hasLoadState = isBusy || Boolean(errorCode);

    dom.aiPromptLoadMode?.classList.toggle("hidden", !hasLoadState);
    dom.aiPromptRetryCta?.classList.toggle("hidden", isBusy || !errorCode);

    if (!dom.aiPromptLoadMessage) return;
    dom.aiPromptLoadMessage.textContent = isBusy
        ? "Generating your meme variant…"
        : getLoadErrorMessage(state.aiPrompt?.error) || "Something went sideways. Retry when you are ready.";
}

export function configureAiPrompting({ dom, state, render, recordEditorSnapshot }) {
    function enforceAiPromptCharacterLimit() {
        if (!dom.aiPromptInput) return 0;
        const characters = getAiPromptCharacters(dom.aiPromptInput.value);
        if (characters.length > AI_PROMPT_CHARACTER_LIMIT) {
            dom.aiPromptInput.value = characters.slice(0, AI_PROMPT_CHARACTER_LIMIT).join("");
            return AI_PROMPT_CHARACTER_LIMIT;
        }
        return characters.length;
    }

    function updateAiPromptCharacterCount(characterCount) {
        if (!dom.aiPromptWordCount) return;
        dom.aiPromptWordCount.textContent = `${characterCount} / ${AI_PROMPT_CHARACTER_LIMIT}`;
        // Keep the counter quiet until the user is close to the limit.
        dom.aiPromptWordCount.classList.toggle("hidden", characterCount < AI_PROMPT_COUNTER_WARNING_AT);
        dom.aiPromptWordCount.classList.toggle("is-at-limit", characterCount >= AI_PROMPT_CHARACTER_LIMIT);
    }

    function appendAiPromptMessage(role, text) {
        state.aiPromptHistory.push({ role, text });
    }

    function setPanelOpen(isOpen) {
        state.isAiPromptPanelOpen = isOpen;
        if (state.aiPrompt) state.aiPrompt.panelState = isOpen ? "open" : "closed";
        if (!isOpen) dom.uploadPage?.style.setProperty("--ai-prompt-keyboard-offset", "0px");
    }

    function syncKeyboardOffset() {
        if (!(state.aiPrompt?.panelState === "open" || state.isAiPromptPanelOpen)) return;
        // visualViewport reflects the on-screen keyboard on mobile browsers.
        const viewport = window.visualViewport;
        const keyboardOffset = viewport
            ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
            : 0;
        dom.uploadPage?.style.setProperty("--ai-prompt-keyboard-offset", `${Math.round(keyboardOffset)}px`);
    }

    function resizeInput() {
        if (!dom.aiPromptInput) return;
        dom.aiPromptInput.style.height = "auto";
        dom.aiPromptInput.style.height = `${dom.aiPromptInput.scrollHeight}px`;
    }

    function syncInputState() {
        const characterCount = enforceAiPromptCharacterLimit();
        updateAiPromptCharacterCount(characterCount);
        resizeInput();
    }

    function openPanel() {
        setPanelOpen(true);
        render();
        syncKeyboardOffset();
        syncInputState();
        dom.aiPromptInput?.focus();
    }

    function closePanel() {
        setPanelOpen(false);
        render();
    }

    function closePanelSilently() {
        // Used by callers that are already about to render their own state change.
        setPanelOpen(false);
    }

    function startRequest(prompt) {
        if (!state.aiPrompt) return;
        state.aiPrompt.requestState = "submitting";
        state.aiPrompt.lastPrompt = prompt;
        state.aiPrompt.error = null;
    }

    function finishRequest() {
        if (!state.aiPrompt) return;
        state.aiPrompt.requestState = "idle";
        state.aiPrompt.error = null;
    }

    function failRequest(error) {
        if (!state.aiPrompt) return;
        state.aiPrompt.requestState = "idle";
        state.aiPrompt.error = {
            code: error?.code || "AI_PROMPT_FAILED",
            message: error?.message || "AI generation had trouble. Retry when you are ready.",
        };
    }

    async function submitPrompt(event) {
        event.preventDefault();
        const prompt = dom.aiPromptInput?.value.trim();

        if (!prompt) {
            dom.aiPromptInput?.classList.add("ai-prompt-input--shake");
            setTimeout(() => dom.aiPromptInput?.classList.remove("ai-prompt-input--shake"), 400);
            appendAiPromptMessage("system", "Enter a prompt.");
            render();
            return;
        }

        startRequest(prompt);
        appendAiPromptMessage("user", prompt);
        render();

        try {
            const templateSrc = state.editor.generatedImage || state.editor.templateImage || null;
            const result = await requestAiPromptVariant(prompt, templateSrc);
            appendAiPromptMessage("assistant", result?.text || AI_PROMPT_PLACEHOLDER_RESPONSE);
            if (result?.imageUrl) {
                state.editor.generatedImage = result.imageUrl;
                if (typeof recordEditorSnapshot === "function") recordEditorSnapshot();
                state.editor.initialSnapshot = createEditorSnapshot();
            }
            finishRequest();
            if (dom.aiPromptInput) dom.aiPromptInput.value = "";
        } catch (error) {
            appendAiPromptMessage("system", error?.message || "Something went wrong. Try again.");
            failRequest(error);
        }

        syncInputState();
        render();
    }

    function retryPrompt() {
        if (!state.aiPrompt?.lastPrompt) return;
        state.aiPrompt.error = null;
        state.aiPrompt.requestState = "idle";
        if (dom.aiPromptInput) dom.aiPromptInput.value = state.aiPrompt.lastPrompt;
        syncInputState();
        render();
        dom.aiPromptForm?.requestSubmit();
    }

    function submitOnEnter(event) {
        if (event.key !== "Enter" || event.shiftKey) return;
        event.preventDefault();
        dom.aiPromptForm?.requestSubmit();
    }

    window.visualViewport?.addEventListener("resize", syncKeyboardOffset);
    window.visualViewport?.addEventListener("scroll", syncKeyboardOffset);

    dom.aiPromptCta?.addEventListener("click", openPanel);
    dom.aiPromptCloseCta?.addEventListener("click", closePanel);
    dom.aiPromptInput?.addEventListener("focus", syncKeyboardOffset);
    dom.aiPromptInput?.addEventListener("blur", syncKeyboardOffset);
    dom.aiPromptInput?.addEventListener("input", syncInputState);
    dom.aiPromptInput?.addEventListener("keydown", submitOnEnter);
    dom.aiPromptForm?.addEventListener("submit", submitPrompt);
    dom.aiPromptRetryCta?.addEventListener("click", retryPrompt);

    return {
        closePanel,
        closePanelSilently,
        syncInputState,
        syncKeyboardOffset,
    };
}
