/**
 * @module upload
 * Upload, camera capture, and manual-fit flow.
 * Handles file selection, drag-and-drop, live camera preview,
 * camera snap/review, and the manual face-positioning mode.
 */

const uploadDeps = {
  dom: null,
  state: null,
  render: null,
  renderOverlay: null,
  getSelectedFaces: null,
  selectSingleFace: null,
  setStatus: null,
  detectFaces: null,
  getRenderedSize: null,
  hasUnsavedStudioEdits: null,
  renderTemplates: null,
  clamp: null,
  normalizeBox: null,
  STATES: null,
};

function getDep(key) {
  const value = uploadDeps[key];
  if (!value) {
    throw new Error(`Upload dependency '${key}' is not configured.`);
  }
  return value;
}

export function configureUpload(deps) {
  Object.assign(uploadDeps, deps);
}

export function clearCameraStream() {
  const state = getDep("state");
  const dom = getDep("dom");
  if (!state.cameraStream) return;
  state.cameraStream.getTracks().forEach((track) => track.stop());
  state.cameraStream = null;
  dom.cameraVideo.srcObject = null;
}

export function clearCameraReview() {
  const state = getDep("state");
  const dom = getDep("dom");
  if (state.cameraReviewUrl) URL.revokeObjectURL(state.cameraReviewUrl);
  state.cameraReviewFile = null;
  state.cameraReviewUrl = "";
  dom.reviewImage.removeAttribute("src");
}

export function clearFaceFitState() {
  const state = getDep("state");
  const dom = getDep("dom");
  state.error = null;
  state.faces = [];
  state.selectedFaceId = null;
  state.selectedFaceIds = [];
  state.imageBitmap = null;
  state.detectorAvailable = true;
  state.usedDetectedFace = false;
  state.manualMode = false;
  state.manualScale = 1;
  state.manualRotation = 0;
  state.manualOffsetX = 0;
  state.manualOffsetY = 0;
  state.gesture = null;
  state.dragPointerId = null;
  state.showResetConfirmation = false;
  dom.manualZoom.value = "1";
  dom.manualRotation.value = "0";
  if (dom.zoomBadge) dom.zoomBadge.textContent = "100%";
  dom.previewImage.style.transform = "";
}

export async function decodeImage(file) {
  const state = getDep("state");
  const url = state.previewUrl || URL.createObjectURL(file);
  const shouldRevokeUrl = !state.previewUrl;

  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.decoding = "async";
      img.src = url;
    });
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;

    if (!width || !height) {
      throw new Error("Decoded image has no dimensions.");
    }

    return { source: image, width, height };
  } catch {
    const err = new Error("Image cannot be decoded.");
    err.code = "CORRUPT_IMAGE";
    throw err;
  } finally {
    if (shouldRevokeUrl) URL.revokeObjectURL(url);
  }
}

export function getManualCircleBox() {
  const dom = getDep("dom");
  const shellRect = dom.overlayShell.getBoundingClientRect();
  const circleRect = dom.manualCircle.getBoundingClientRect();
  return {
    x: circleRect.left - shellRect.left,
    y: circleRect.top - shellRect.top,
    width: circleRect.width,
    height: circleRect.height,
  };
}

export function buildManualFaceBoxNatural() {
  const state = getDep("state");
  const getRenderedSize = getDep("getRenderedSize");
  const clamp = getDep("clamp");
  if (!state.imageBitmap) return null;
  const nw = state.imageBitmap.width;
  const nh = state.imageBitmap.height;
  const rendered = getRenderedSize();
  const base = Math.max(rendered.width / nw, rendered.height / nh);
  const finalScale = base * state.manualScale;
  const displayedW = nw * finalScale;
  const displayedH = nh * finalScale;
  const imageLeft = (rendered.width - displayedW) / 2 + state.manualOffsetX;
  const imageTop = (rendered.height - displayedH) / 2 + state.manualOffsetY;
  const circle = getManualCircleBox();
  return {
    x: clamp((circle.x - imageLeft) / finalScale, 0, nw),
    y: clamp((circle.y - imageTop) / finalScale, 0, nh),
    width: clamp(circle.width / finalScale, 10, nw),
    height: clamp(circle.height / finalScale, 10, nh),
  };
}

export function updateManualFaceSelection() {
  const state = getDep("state");
  const selectSingleFace = getDep("selectSingleFace");
  const normalizeBox = getDep("normalizeBox");
  const getRenderedSize = getDep("getRenderedSize");
  if (!state.manualMode || !state.imageBitmap) return;
  const boxNatural = buildManualFaceBoxNatural();
  if (!boxNatural) return;
  const rendered = getRenderedSize();
  state.faces = [{
    id: "face-manual-0",
    score: 1,
    boxNatural,
    transform: {
      scale: state.manualScale,
      rotation: state.manualRotation,
      offsetX: state.manualOffsetX,
      offsetY: state.manualOffsetY,
    },
    boxRendered: normalizeBox(
      boxNatural,
      { width: state.imageBitmap.width, height: state.imageBitmap.height },
      rendered
    ),
  }];
  selectSingleFace("face-manual-0");
}

export function applyManualTransform() {
  const state = getDep("state");
  const dom = getDep("dom");
  if (!state.manualMode) {
    dom.previewImage.style.transform = "";
    return;
  }
  dom.previewImage.style.transform = `translate(${state.manualOffsetX}px, ${state.manualOffsetY}px) rotate(${state.manualRotation}deg) scale(${state.manualScale})`;
  updateManualFaceSelection();
}

export function alignManualViewToFace(face) {
  const state = getDep("state");
  const dom = getDep("dom");
  const clamp = getDep("clamp");
  if (!face?.boxNatural || !state.imageBitmap) return;

  const rendered = getDep("getRenderedSize")();
  const circle = getManualCircleBox();
  const natural = {
    width: state.imageBitmap.width,
    height: state.imageBitmap.height,
  };
  const base = Math.max(rendered.width / natural.width, rendered.height / natural.height);
  const targetScale = Math.min(
    circle.width / (face.boxNatural.width * 1.18),
    circle.height / (face.boxNatural.height * 1.18)
  );
  const manualScale = clamp(targetScale / base, 0.5, 3.0);
  const finalScale = base * manualScale;
  const displayedW = natural.width * finalScale;
  const displayedH = natural.height * finalScale;
  const baseLeft = (rendered.width - displayedW) / 2;
  const baseTop = (rendered.height - displayedH) / 2;
  const faceCenterX = face.boxNatural.x + face.boxNatural.width / 2;
  const faceCenterY = face.boxNatural.y + face.boxNatural.height / 2;
  const circleCenterX = circle.x + circle.width / 2;
  const circleCenterY = circle.y + circle.height / 2;

  state.manualScale = manualScale;
  state.manualRotation = 0;
  state.manualOffsetX = circleCenterX - faceCenterX * finalScale - baseLeft;
  state.manualOffsetY = circleCenterY - faceCenterY * finalScale - baseTop;
  dom.manualZoom.value = String(manualScale);
  dom.manualRotation.value = "0";
  if (dom.zoomBadge) dom.zoomBadge.textContent = `${Math.round(manualScale * 100)}%`;
}

export function enterManualMode(faceToAlign = null) {
  const state = getDep("state");
  const dom = getDep("dom");
  const renderOverlay = getDep("renderOverlay");

  state.manualMode = true;
  state.manualScale = 1;
  state.manualRotation = 0;
  state.manualOffsetX = 0;
  state.manualOffsetY = 0;
  state.gesture = null;
  dom.manualZoom.value = "1";
  dom.manualRotation.value = "0";
  if (dom.zoomBadge) dom.zoomBadge.textContent = "100%";
  requestAnimationFrame(() => {
    alignManualViewToFace(faceToAlign);
    applyManualTransform();
    renderOverlay();
  });
}

export function startManualFitFromSelection() {
  const state = getDep("state");
  const getSelectedFaces = getDep("getSelectedFaces");
  const setStatus = getDep("setStatus");
  const STATES = getDep("STATES");
  const faceToAlign = getSelectedFaces()[0] || state.faces[0] || null;
  state.usedDetectedFace = Boolean(faceToAlign);
  enterManualMode(faceToAlign);
  setStatus(STATES.READY);
}

export async function startCameraCapture() {
  const state = getDep("state");
  const dom = getDep("dom");
  const render = getDep("render");

  clearCameraStream();
  clearCameraReview();
  state.uploadModalOpen = false;
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      dom.cameraInput.click();
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: state.cameraFacingMode },
      audio: false,
    });
    state.cameraStream = stream;
    dom.cameraVideo.srcObject = stream;
    // Explicitly start playback and wait for the first frame to avoid
    // drawImage capturing an uninitialised buffer (causes garbled pixels).
    try { await dom.cameraVideo.play(); } catch { /* autoplay fallback */ }
    render();
  } catch {
    dom.cameraInput.click();
  }
}

export async function snapCameraPhoto() {
  const state = getDep("state");
  const dom = getDep("dom");
  if (!state.cameraStream) return;
  const video = dom.cameraVideo;
  if (!video.videoWidth || !video.videoHeight) return;

  // Ensure the video has at least one decoded frame available before capture.
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    await new Promise((resolve) => {
      video.addEventListener("canplay", resolve, { once: true });
      setTimeout(resolve, 500);
    });
    if (!video.videoWidth || !video.videoHeight) return;
  }

  // Cap dimensions to avoid GPU memory issues on mobile devices.
  const MAX_CAPTURE_EDGE = 2048;
  let captureWidth = video.videoWidth;
  let captureHeight = video.videoHeight;
  if (captureWidth > MAX_CAPTURE_EDGE || captureHeight > MAX_CAPTURE_EDGE) {
    const scale = MAX_CAPTURE_EDGE / Math.max(captureWidth, captureHeight);
    captureWidth = Math.round(captureWidth * scale);
    captureHeight = Math.round(captureHeight * scale);
  }

  const canvas = document.createElement("canvas");
  canvas.width = captureWidth;
  canvas.height = captureHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(video, 0, 0, captureWidth, captureHeight);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  if (!blob || blob.size < 1000) return;
  const file = new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" });

  clearCameraStream();
  clearCameraReview();
  state.cameraReviewFile = file;
  state.cameraReviewUrl = URL.createObjectURL(file);
  dom.reviewImage.src = state.cameraReviewUrl;
  getDep("render")();
}

export async function useReviewedPhoto() {
  const state = getDep("state");
  const render = getDep("render");
  const dom = getDep("dom");
  const detectFaces = getDep("detectFaces");
  if (!state.cameraReviewFile) return;
  const file = state.cameraReviewFile;
  clearCameraStream();
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = URL.createObjectURL(file);
  clearCameraReview();

  // Pre-decode the image to guarantee the browser has pixel data ready before
  // the overlay-shell becomes visible. This prevents corrupted/garbled frames
  // caused by the browser attempting to render an img whose decode hasn't
  // completed (particularly on mobile/GPU-composited surfaces).
  dom.previewImage.src = state.previewUrl;
  try { await dom.previewImage.decode(); } catch { /* non-fatal */ }

  render();
  await detectFaces(file);
}

export async function flipCamera() {
  const state = getDep("state");
  state.cameraFacingMode = state.cameraFacingMode === "user" ? "environment" : "user";
  await startCameraCapture();
}

export function goBackToUploadChoices() {
  const state = getDep("state");
  const dom = getDep("dom");
  const render = getDep("render");
  const hasUnsavedStudioEdits = getDep("hasUnsavedStudioEdits");
  const renderTemplates = getDep("renderTemplates");

  if (state.view === "templates") {
    state.view = "home";
    render();
    return;
  }

  if (state.uploadModalOpen) {
    state.uploadModalOpen = false;
    render();
    return;
  }

  if (state.showResetConfirmation) {
    state.showResetConfirmation = false;
    render();
    return;
  }

  if (state.showBackConfirmation) {
    state.showBackConfirmation = false;
    render();
    return;
  }

  if (state.view === "studio" && hasUnsavedStudioEdits()) {
    state.showBackConfirmation = true;
    state.showResetConfirmation = false;
    state.isEditingMemeText = false;
    render();
    return;
  }

  if (state.view === "studio" && state.status === getDep("STATES").IDLE && state.selectedTemplateId) {
    state.selectedTemplateId = null;
    state.view = "templates";
    render();
    renderTemplates();
    return;
  }

  if (state.cameraStream) {
    clearCameraStream();
    render();
    return;
  }

  if (state.cameraReviewUrl || state.previewUrl || state.status !== getDep("STATES").IDLE) {
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    clearCameraStream();
    clearCameraReview();
    state.status = getDep("STATES").IDLE;
    state.faces = [];
    state.selectedFaceId = null;
    state.selectedFaceIds = [];
    state.error = null;
    state.lastRetryableAction = null;
    state.imageBitmap = null;
    state.previewUrl = "";
    state.file = null;
    state.sequence += 1;
    state.detectorAvailable = true;
    state.usedDetectedFace = false;
    state.manualMode = false;
    state.manualScale = 1;
    state.manualRotation = 0;
    state.manualOffsetX = 0;
    state.manualOffsetY = 0;
    state.gesture = null;
    state.dragPointerId = null;
    dom.cameraInput.value = "";
    dom.libraryInput.value = "";
    dom.manualZoom.value = "1";
    dom.manualRotation.value = "0";
    if (dom.zoomBadge) dom.zoomBadge.textContent = "100%";
    dom.previewImage.style.transform = "";
    dom.previewImage.removeAttribute("src");
    state.view = "studio";
    render();
  }
}

export function startManualDrag(event) {
  const state = getDep("state");
  const dom = getDep("dom");
  if (!state.manualMode) return;
  event.preventDefault();
  state.dragPointerId = event.pointerId;
  state.dragStartX = event.clientX;
  state.dragStartY = event.clientY;
  state.dragOriginOffsetX = state.manualOffsetX;
  state.dragOriginOffsetY = state.manualOffsetY;
  dom.previewImage.classList.add("dragging");
  dom.overlayShell.setPointerCapture(event.pointerId);
}

export function moveManualDrag(event) {
  const state = getDep("state");
  const renderOverlay = getDep("renderOverlay");
  if (!state.manualMode || state.dragPointerId !== event.pointerId) return;
  event.preventDefault();
  state.manualOffsetX = state.dragOriginOffsetX + (event.clientX - state.dragStartX);
  state.manualOffsetY = state.dragOriginOffsetY + (event.clientY - state.dragStartY);
  applyManualTransform();
  renderOverlay();
}
