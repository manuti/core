"use strict";

// ── Platform Control Center ─────────────────────────────────────────
//
// Ownership boundary (ticket #144):
//
// PLATFORM (this module + platform-api.js + model-api.js):
//   Runtime switch, memory loading, power calibration, compatibility
//   override, runtime reset, model CRUD (register/download/cancel/
//   activate/delete/purge/upload), download countdown, updates.
//   Feedback: platform-notify.js bar + runtime-ui.js status fields.
//
// APP-SPECIFIC (chat.js + chat-engine.js):
//   Chat send/receive, message rendering, edit modal, session
//   management, image handling, composer activity/status chip.
//   Feedback: appendMessage() into chat stream.
//
// SHARED (settings-ui.js):
//   Model settings save, projector download, YAML.
//   Platform callbacks: setSidebarOpen, pollStatus.
//   Chat callbacks: setComposerActivity, focusPromptInput, etc.
//   Platform settings work without chat callbacks.

import { appState, RUNTIME_RECONNECT_INTERVAL_MS, RUNTIME_RECONNECT_TIMEOUT_MS, RUNTIME_RECONNECT_MAX_ATTEMPTS } from "./state.js";
import { formatBytes } from "./utils.js";
import { t, tReason } from "./i18n.js";
import { isLocalModelConnected, findResumableFailedModel, renderDownloadPrompt } from "./status.js";
import { setModelUploadStatus, setLlamaRuntimeSwitchStatus, setLlamaRuntimeSwitchButtonState, setLlamaMemoryLoadingStatus, setLlamaMemoryLoadingButtonState, setLargeModelOverrideStatus, setLargeModelOverrideButtonState, setPowerCalibrationStatus, setPowerCalibrationButtonsState } from "./runtime-ui.js";
import { setUpdateCheckInFlight, setUpdateStartInFlight, isUpdateExecutionActive, openChangelogModal } from "./update-ui.js";
import { setModelUrlStatus, formatModelUrlStatus, resolveSelectedSettingsModel, selectedModelHasUnsavedChanges, blockModelSelectionChange, renderSettingsWorkspace } from "./settings-ui.js";
import { showPlatformNotice } from "./platform-notify.js";
import * as platformApi from "./platform-api.js";
import * as modelApi from "./model-api.js";

// Composer activity is owned by the active app — no-op if no app loaded
let _setComposerActivity = () => {};
export function registerComposerActivity(fn) { _setComposerActivity = fn; }
export function resetComposerActivity() { _setComposerActivity = () => {}; }
function setComposerActivity(msg) { _setComposerActivity(msg); }

let _shell = {};

export function registerPlatformShell({ pollStatus }) {
  _shell = { pollStatus };
}

// ── Runtime controls ───────────────────────────────────────────────

export async function switchLlamaRuntimeBundle() {
  if (appState.llamaRuntimeSwitchInFlight) return;
  const select = document.getElementById("llamaRuntimeFamilySelect");
  const family = String(select?.value || "").trim();
  if (!family) {
    showPlatformNotice(t("pc.noRuntimeSelected"), { level: "warn" });
    return;
  }
  const selectedLabel = select?.selectedOptions?.[0]?.textContent || family;
  const confirmed = window.confirm(
    t("pc.confirmSwitch", { label: selectedLabel })
  );
  if (!confirmed) return;

  appState.llamaRuntimeSwitchInFlight = true;
  setLlamaRuntimeSwitchButtonState(true);
  setLlamaRuntimeSwitchStatus(t("pc.switchingRuntimeMsg"));
  setComposerActivity(t("pc.switchingLlama"));
  try {
    const result = await platformApi.switchRuntime(family);
    if (!result.ok) {
      showPlatformNotice(t("pc.couldNotSwitch", { error: tReason(result.error) }), { level: "error" });
      return;
    }
    showPlatformNotice(t("pc.switchedTo", { family: result.family }), { level: "success" });
    setComposerActivity(t("pc.switchedReconnecting"));
  } finally {
    appState.llamaRuntimeSwitchInFlight = false;
    setLlamaRuntimeSwitchButtonState(false);
    await _shell.pollStatus();
  }
}

export async function applyLlamaMemoryLoadingMode() {
  if (appState.llamaMemoryLoadingApplyInFlight) return;
  const select = document.getElementById("llamaMemoryLoadingMode");
  const mode = String(select?.value || "auto").trim() || "auto";
  const label = select?.selectedOptions?.[0]?.textContent || mode;
  const confirmed = window.confirm(
    t("pc.confirmApplyMemory", { label })
  );
  if (!confirmed) return;

  appState.llamaMemoryLoadingApplyInFlight = true;
  setLlamaMemoryLoadingButtonState(true);
  setLlamaMemoryLoadingStatus(t("pc.applyingMemory", { label }));
  try {
    const result = await platformApi.setMemoryLoadingMode(mode);
    if (!result.ok) {
      showPlatformNotice(t("pc.couldNotUpdateMemory", { error: tReason(result.error) }), { level: "error" });
      setLlamaMemoryLoadingStatus(t("pc.lastMemoryErr", { error: tReason(result.error) }));
      return;
    }
    showPlatformNotice(
      t("pc.appliedMemory", { label: result.memoryLoading?.label || mode, reason: result.restartReason }),
      { level: "success" },
    );
    await _shell.pollStatus();
  } finally {
    appState.llamaMemoryLoadingApplyInFlight = false;
    setLlamaMemoryLoadingButtonState(false);
  }
}

// ── Compatibility override ─────────────────────────────────────────

export async function applyLargeModelCompatibilityOverride(enabled) {
  if (appState.largeModelOverrideApplyInFlight) return;
  appState.largeModelOverrideApplyInFlight = true;
  setLargeModelOverrideButtonState(true);
  setLargeModelOverrideStatus(
    enabled
      ? t("pc.applyingCompatTry")
      : t("pc.applyingCompatRestore")
  );
  try {
    const result = await platformApi.setLargeModelOverride(enabled);
    if (!result.ok) {
      showPlatformNotice(t("pc.couldNotUpdateCompat", { error: tReason(result.error) }), { level: "error" });
      setLargeModelOverrideStatus(t("pc.lastCompatErr", { error: tReason(result.error) }));
      return;
    }
    showPlatformNotice(
      result.override?.enabled
        ? t("pc.enabledCompat")
        : t("pc.disabledCompat"),
      { level: "success" },
    );
    setLargeModelOverrideStatus(
      result.override?.enabled
        ? t("ru.compatOverrideOn")
        : t("adv.compatStatus")
    );
  } finally {
    appState.largeModelOverrideApplyInFlight = false;
    setLargeModelOverrideButtonState(false);
    await _shell.pollStatus();
  }
}

export async function applyLargeModelOverrideFromSettings() {
  const checkbox = document.getElementById("largeModelOverrideEnabled");
  await applyLargeModelCompatibilityOverride(checkbox?.checked === true);
}

export async function allowUnsupportedLargeModelFromWarning() {
  const confirmed = window.confirm(
    t("pc.confirmTryLarge")
  );
  if (!confirmed) return;
  await applyLargeModelCompatibilityOverride(true);
}

// ── Power calibration ──────────────────────────────────────────────

export async function capturePowerCalibrationSample() {
  if (appState.powerCalibrationActionInFlight) return;
  const input = document.getElementById("powerCalibrationWallWatts");
  const wallWatts = Number(input?.value);
  if (!Number.isFinite(wallWatts) || wallWatts <= 0) {
    showPlatformNotice(t("pc.invalidWallReading"), { level: "warn" });
    setPowerCalibrationStatus(t("pc.calibErrInvalid"));
    return;
  }

  appState.powerCalibrationActionInFlight = true;
  setPowerCalibrationButtonsState(true);
  setPowerCalibrationStatus(t("pc.capturingSample"));
  try {
    const result = await platformApi.captureCalibrationSample(wallWatts);
    if (!result.ok) {
      showPlatformNotice(t("pc.errCapture", { error: tReason(result.error) }), { level: "error" });
      setPowerCalibrationStatus(t("pc.calibErr", { error: tReason(result.error) }));
      return;
    }
    showPlatformNotice(
      t("pc.capturedSample", { wall: Number(wallWatts).toFixed(2), raw: Number(result.sample?.raw_pmic_watts || 0).toFixed(3) }),
      { level: "success" },
    );
  } finally {
    appState.powerCalibrationActionInFlight = false;
    setPowerCalibrationButtonsState(false);
    await _shell.pollStatus();
  }
}

export async function fitPowerCalibrationModel() {
  if (appState.powerCalibrationActionInFlight) return;
  appState.powerCalibrationActionInFlight = true;
  setPowerCalibrationButtonsState(true);
  setPowerCalibrationStatus(t("pc.computingCalib"));
  try {
    const result = await platformApi.fitCalibrationModel();
    if (!result.ok) {
      showPlatformNotice(t("pc.errCompute", { error: tReason(result.error) }), { level: "error" });
      setPowerCalibrationStatus(t("pc.calibErr", { error: tReason(result.error) }));
      return;
    }
    const cal = result.calibration || {};
    showPlatformNotice(
      t("pc.calibUpdated", { a: Number(cal?.a || 0).toFixed(4), b: Number(cal?.b || 0).toFixed(4), n: Number(cal?.sample_count || 0) }),
      { level: "success" },
    );
  } finally {
    appState.powerCalibrationActionInFlight = false;
    setPowerCalibrationButtonsState(false);
    await _shell.pollStatus();
  }
}

export async function resetPowerCalibrationModel() {
  if (appState.powerCalibrationActionInFlight) return;
  const confirmed = window.confirm(
    t("pc.confirmResetCalib")
  );
  if (!confirmed) return;

  appState.powerCalibrationActionInFlight = true;
  setPowerCalibrationButtonsState(true);
  setPowerCalibrationStatus(t("pc.resettingCalib"));
  try {
    const result = await platformApi.resetCalibration();
    if (!result.ok) {
      showPlatformNotice(t("pc.errResetCalib", { error: tReason(result.error) }), { level: "error" });
      setPowerCalibrationStatus(t("pc.calibErr", { error: tReason(result.error) }));
      return;
    }
    showPlatformNotice(t("pc.calibReset"), { level: "success" });
  } finally {
    appState.powerCalibrationActionInFlight = false;
    setPowerCalibrationButtonsState(false);
    await _shell.pollStatus();
  }
}

// ── Download control ───────────────────────────────────────────────

export async function updateCountdownPreference(enabled) {
  const result = await platformApi.setDownloadCountdown(enabled);
  if (!result.ok) {
    showPlatformNotice(t("pc.errAutoDownload", { error: tReason(result.error) }), { level: "error" });
  }
  await _shell.pollStatus();
}

// ── Model operations ───────────────────────────────────────────────

function findModelInLatestStatus(modelId) {
  const models = Array.isArray(appState.latestStatus?.models) ? appState.latestStatus.models : [];
  return models.find((item) => String(item?.id || "") === String(modelId || "")) || null;
}

export async function registerModelFromUrl() {
  if (appState.modelActionInFlight) return;
  const input = document.getElementById("modelUrlInput");
  const sourceUrl = String(input?.value || "").trim();
  if (!sourceUrl) {
    setModelUrlStatus(t("pc.enterUrl"));
    return;
  }
  const hfTokenInput = document.getElementById("hfTokenInput");
  const hfToken = String(hfTokenInput?.value || "").trim() || null;
  appState.modelActionInFlight = true;
  setModelUrlStatus(t("pc.addingUrl"));
  try {
    const result = await modelApi.registerModel(sourceUrl, hfToken);
    if (!result.ok) {
      setModelUrlStatus(result.reason
        ? formatModelUrlStatus(result.reason, result.status)
        : t("pc.couldNotAddUrl", { error: tReason(result.error) }));
      return;
    }
    setModelUrlStatus(
      result.reason === "already_exists"
        ? t("pc.urlDup")
        : t("pc.urlAdded")
    );
    if (input) input.value = "";
  } finally {
    appState.modelActionInFlight = false;
    await _shell.pollStatus();
  }
}

export async function startModelDownloadForModel(modelId) {
  if (!modelId) return;
  if (appState.modelActionInFlight) return;
  appState.modelActionInFlight = true;
  try {
    const result = await modelApi.downloadModel(modelId);
    if (!result.ok) {
      showPlatformNotice(t("pc.errStartDownload", { error: tReason(result.error) }), { level: "error" });
      return;
    }
    if (!result.started && result.reason === "insufficient_storage") {
      const freeInfo = result.freeBytes != null ? t("pc.freeInfo", { free: formatBytes(result.freeBytes), needed: formatBytes(result.requiredBytes) }) : "";
      showPlatformNotice(t("pc.notEnoughStorage", { freeInfo }), { level: "warn" });
      setComposerActivity(t("pc.tooLarge"));
    }
  } finally {
    appState.modelActionInFlight = false;
    await _shell.pollStatus();
  }
}

export async function cancelActiveModelDownload(modelId = null) {
  if (appState.modelActionInFlight) return;
  const targetModel = findModelInLatestStatus(modelId) || findModelInLatestStatus(appState.latestStatus?.download?.current_model_id);
  const targetName = String(targetModel?.filename || "this model");
  const confirmed = window.confirm(t("pc.confirmStopDownload", { name: targetName }));
  if (!confirmed) return;
  appState.modelActionInFlight = true;
  try {
    const result = await modelApi.cancelDownload();
    if (!result.ok) {
      showPlatformNotice(t("pc.errCancelDownload", { error: tReason(result.error) }), { level: "error" });
    }
  } finally {
    appState.modelActionInFlight = false;
    await _shell.pollStatus();
  }
}

export async function activateSelectedModel(modelId) {
  if (!modelId) return;
  if (appState.modelActionInFlight) return;
  appState.modelActionInFlight = true;
  try {
    const result = await modelApi.activateModel(modelId);
    if (!result.ok) {
      showPlatformNotice(t("pc.errActivate", { error: tReason(result.error) }), { level: "error" });
      return;
    }
    setComposerActivity(t("pc.switchingActive"));
  } finally {
    appState.modelActionInFlight = false;
    await _shell.pollStatus();
  }
}

export async function deleteSelectedModel(modelId) {
  if (!modelId) return;
  if (appState.modelActionInFlight) return;
  const targetModel = findModelInLatestStatus(modelId);
  const targetName = String(targetModel?.filename || "this model");
  const isDownloading = targetModel?.status === "downloading";
  const confirmMessage = isDownloading
    ? t("pc.confirmCancelDelete", { name: targetName })
    : t("pc.confirmDelete", { name: targetName });
  const confirmed = window.confirm(confirmMessage);
  if (!confirmed) return;
  appState.modelActionInFlight = true;
  try {
    const result = await modelApi.deleteModel(modelId);
    if (!result.ok) {
      showPlatformNotice(t("pc.errDelete", { error: tReason(result.error) }), { level: "error" });
      return;
    }
  } finally {
    appState.modelActionInFlight = false;
    await _shell.pollStatus();
  }
}

export async function purgeAllModels() {
  if (appState.modelActionInFlight) return;
  const confirmed = window.confirm(
    t("pc.confirmDeleteAll")
  );
  if (!confirmed) return;
  appState.modelActionInFlight = true;
  try {
    const result = await modelApi.purgeModels();
    if (!result.ok) {
      showPlatformNotice(t("pc.errPurge", { error: tReason(result.error) }), { level: "error" });
      return;
    }
    setComposerActivity(t("pc.allCleared"));
  } finally {
    appState.modelActionInFlight = false;
    await _shell.pollStatus();
  }
}

export async function uploadLocalModel() {
  if (appState.uploadRequest) return;
  const input = document.getElementById("modelUploadInput");
  const file = input?.files?.[0];
  if (!file) {
    showPlatformNotice(t("pc.pickGguf"), { level: "warn" });
    return;
  }
  if (!String(file.name || "").toLowerCase().endsWith(".gguf")) {
    showPlatformNotice(t("pc.onlyGguf"), { level: "warn" });
    return;
  }

  const xhr = new XMLHttpRequest();
  appState.uploadRequest = xhr;
  const cancelBtn = document.getElementById("cancelUploadBtn");
  if (cancelBtn) cancelBtn.hidden = false;
  setModelUploadStatus(t("pc.uploading0"));

  xhr.open("POST", "/internal/models/upload");
  xhr.setRequestHeader("x-potato-filename", file.name);
  xhr.upload.onprogress = (event) => {
    if (event.lengthComputable && event.total > 0) {
      const percent = Math.round((event.loaded * 100) / event.total);
      setModelUploadStatus(t("pc.uploadingPct", { pct: percent, done: formatBytes(event.loaded), total: formatBytes(event.total) }));
    } else {
      setModelUploadStatus(t("pc.uploadingModel"));
    }
  };
  xhr.onerror = async () => {
    appState.uploadRequest = null;
    if (cancelBtn) cancelBtn.hidden = true;
    setModelUploadStatus(t("pc.uploadFailed"));
    await _shell.pollStatus();
  };
  xhr.onabort = async () => {
    appState.uploadRequest = null;
    if (cancelBtn) cancelBtn.hidden = true;
    setModelUploadStatus(t("pc.uploadCancelled"));
    await modelApi.cancelUpload();
    await _shell.pollStatus();
  };
  xhr.onload = async () => {
    appState.uploadRequest = null;
    if (cancelBtn) cancelBtn.hidden = true;
    const body = (() => {
      try {
        return JSON.parse(xhr.responseText || "{}");
      } catch (_err) {
        return {};
      }
    })();
    if (xhr.status < 200 || xhr.status >= 300) {
      if (body?.reason === "upload_too_large" && body?.max_upload_bytes) {
        setModelUploadStatus(t("pc.uploadTooLarge", { limit: formatBytes(body.max_upload_bytes) }));
      } else {
        setModelUploadStatus(t("pc.uploadFailedReason", { reason: tReason(body?.reason) || xhr.status }));
      }
    } else if (body?.uploaded) {
      if (input) input.value = "";
      setModelUploadStatus(t("pc.uploadCompleted"));
    } else {
      setModelUploadStatus(t("pc.uploadIncomplete", { reason: tReason(body?.reason) || t("ru.unknown") }));
    }
    await _shell.pollStatus();
  };
  xhr.send(file);
}

export function cancelLocalModelUpload() {
  if (!appState.uploadRequest) return;
  appState.uploadRequest.abort();
}

export async function startModelDownload() {
  if (appState.downloadStartInFlight) return;
  appState.downloadStartInFlight = true;
  renderDownloadPrompt(appState.latestStatus || { download: { auto_start_remaining_seconds: 0 } });
  try {
    const resumableFailedModel = findResumableFailedModel(appState.latestStatus);
    const failedDownload = String(appState.latestStatus?.download?.error || "") === "download_failed";
    let result;
    if (resumableFailedModel && failedDownload) {
      result = await modelApi.downloadModel(resumableFailedModel.id);
    } else {
      result = await platformApi.startDefaultModelDownload();
    }
    if (!result.ok) {
      showPlatformNotice(
        t("pc.downloadErr", { which: resumableFailedModel && failedDownload ? t("pc.couldNotResume") : t("pc.couldNotStart"), error: result.error }),
        { level: "error" },
      );
      return;
    }
    if (!result.started && result.reason === "already_running") {
      setComposerActivity(t("pc.downloadRunning"));
    } else if (!result.started && result.reason === "model_present") {
      setComposerActivity(t("pc.modelPresent"));
    } else if (!result.started && result.reason === "insufficient_storage") {
      const freeInfo = result.freeBytes != null ? t("pc.freeInfo", { free: formatBytes(result.freeBytes), needed: formatBytes(result.requiredBytes) }) : "";
      showPlatformNotice(t("pc.notEnoughStorage", { freeInfo }), { level: "warn" });
      setComposerActivity(t("pc.tooLarge"));
    } else if (result.started) {
      setComposerActivity(resumableFailedModel && failedDownload ? t("pc.downloadResumed") : t("pc.downloadStarted"));
    }
  } finally {
    appState.downloadStartInFlight = false;
    await _shell.pollStatus();
  }
}

// ── Runtime reset ──────────────────────────────────────────────────

function setRuntimeResetButtonState(inFlight) {
  const btn = document.getElementById("resetRuntimeBtn");
  if (!btn) return;
  btn.disabled = Boolean(inFlight);
  btn.textContent = inFlight
    ? t("pc.restartingRuntime")
    : t("adv.resetRuntime");
}

export function stopRuntimeReconnectWatch() {
  if (appState.runtimeReconnectWatchTimer) {
    window.clearTimeout(appState.runtimeReconnectWatchTimer);
    appState.runtimeReconnectWatchTimer = null;
  }
  appState.runtimeReconnectWatchActive = false;
  appState.runtimeReconnectAttempts = 0;
}

async function stepRuntimeReconnectWatch() {
  if (!appState.runtimeReconnectWatchActive) return;
  appState.runtimeReconnectAttempts += 1;
  const statusPayload = await _shell.pollStatus({ timeoutMs: RUNTIME_RECONNECT_TIMEOUT_MS });
  if (isLocalModelConnected(statusPayload)) {
    stopRuntimeReconnectWatch();
    setComposerActivity(t("pc.runtimeReconnected"));
    window.setTimeout(() => {
      if (!appState.runtimeReconnectWatchActive && !appState.requestInFlight) {
        setComposerActivity("");
      }
    }, 1500);
    return;
  }
  if (appState.runtimeReconnectAttempts >= RUNTIME_RECONNECT_MAX_ATTEMPTS) {
    stopRuntimeReconnectWatch();
    setComposerActivity("");
    showPlatformNotice(
      t("pc.resetTakingLong"),
      { level: "warn" },
    );
    return;
  }
  appState.runtimeReconnectWatchTimer = window.setTimeout(stepRuntimeReconnectWatch, RUNTIME_RECONNECT_INTERVAL_MS);
}

export function startRuntimeReconnectWatch() {
  stopRuntimeReconnectWatch();
  appState.runtimeReconnectWatchActive = true;
  appState.runtimeReconnectAttempts = 0;
  setComposerActivity(t("pc.resetReconnecting"));
  stepRuntimeReconnectWatch();
}

export async function resetRuntimeHeavy() {
  if (appState.runtimeResetInFlight) return;
  const confirmed = window.confirm(
    t("pc.confirmResetRuntime")
  );
  if (!confirmed) return;

  appState.runtimeResetInFlight = true;
  let shouldTrackReconnect = false;
  setRuntimeResetButtonState(true);
  setComposerActivity(t("pc.schedulingReset"));
  try {
    const result = await platformApi.resetRuntime();
    if (!result.ok) {
      showPlatformNotice(t("pc.errStartReset", { error: tReason(result.error) }), { level: "error" });
      return;
    }
    if (result.started) {
      shouldTrackReconnect = true;
      showPlatformNotice(
        t("pc.resetStarted"),
        { level: "info" },
      );
    } else {
      showPlatformNotice(t("pc.resetDidNotStart", { reason: tReason(result.reason) || t("ru.unknown") }), { level: "warn" });
    }
  } finally {
    appState.runtimeResetInFlight = false;
    setRuntimeResetButtonState(false);
    if (shouldTrackReconnect) {
      startRuntimeReconnectWatch();
    } else {
      setComposerActivity("");
      window.setTimeout(() => {
        _shell.pollStatus();
      }, 1000);
    }
  }
}

// ── Update operations ──────────────────────────────────────────────

export async function checkForUpdate() {
  if (appState.updateCheckInFlight) return;
  if (isUpdateExecutionActive()) return;
  appState.updateCheckInFlight = true;
  setUpdateCheckInFlight(true);
  try {
    const result = await platformApi.checkForUpdate();
    if (!result.ok) {
      showPlatformNotice(t("pc.errCheckUpdates", { error: tReason(result.error) }), { level: "error" });
      return;
    }
    await _shell.pollStatus();
  } finally {
    appState.updateCheckInFlight = false;
    setUpdateCheckInFlight(false);
  }
}

export async function startUpdate() {
  if (appState.updateStartInFlight) return;
  appState.updateStartInFlight = true;
  setUpdateStartInFlight(true);
  try {
    const result = await platformApi.startUpdate();
    if (!result.ok) {
      const reasons = {
        orchestrator_disabled: t("pc.updErrOrchestrator"),
        no_update_available: t("pc.updErrNoUpdate"),
        no_tarball_url: t("pc.updErrNoTarball"),
        download_active: t("pc.updErrDownloadActive"),
        update_in_progress: t("pc.updErrInProgress"),
      };
      showPlatformNotice(reasons[result.reason] || `Could not start update (${result.reason || result.error || "unknown"}).`, { level: "error" });
      return;
    }
    await _shell.pollStatus();
  } finally {
    appState.updateStartInFlight = false;
    setUpdateStartInFlight(false);
  }
}

export function showUpdateReleaseNotes() {
  const update = appState.latestStatus?.update;
  const notes = update?.release_notes;
  const latest = String(update?.latest_version || "");
  const current = String(update?.current_version || "");
  const subtitle = (current && latest) ? `v${current} \u2192 v${latest}` : "";
  openChangelogModal({ version: latest, notes: notes || null, subtitle });
}

function stopUpdateReconnectWatch() {
  if (appState.updateReconnectTimer) {
    window.clearTimeout(appState.updateReconnectTimer);
    appState.updateReconnectTimer = null;
  }
  appState.updateReconnectActive = false;
  appState.updateReconnectAttempts = 0;
}

async function stepUpdateReconnectWatch() {
  if (!appState.updateReconnectActive) return;
  appState.updateReconnectAttempts += 1;
  const statusPayload = await _shell.pollStatus({ timeoutMs: RUNTIME_RECONNECT_TIMEOUT_MS });
  const updateState = String(statusPayload?.update?.state || "idle");
  if (updateState === "idle") {
    stopUpdateReconnectWatch();
    const version = String(statusPayload?.update?.current_version || "");
    setComposerActivity(version ? t("pc.updCompleteVer", { v: version }) : t("pc.updComplete"));
    window.setTimeout(() => {
      const hasInput = document.querySelector("#userPrompt")?.value?.trim();
      if (!appState.requestInFlight && !hasInput) window.location.reload();
    }, 2000);
    return;
  }
  if (updateState === "failed") {
    stopUpdateReconnectWatch();
    setComposerActivity("");
    showPlatformNotice(t("pc.updateMaybeNotApplied"), { level: "warn" });
    return;
  }
  if (appState.updateReconnectAttempts >= RUNTIME_RECONNECT_MAX_ATTEMPTS) {
    stopUpdateReconnectWatch();
    setComposerActivity("");
    showPlatformNotice(t("pc.reconnectSlow"), { level: "warn" });
    return;
  }
  appState.updateReconnectTimer = window.setTimeout(stepUpdateReconnectWatch, RUNTIME_RECONNECT_INTERVAL_MS);
}

export function startUpdateReconnectWatch() {
  stopUpdateReconnectWatch();
  appState.updateReconnectActive = true;
  appState.updateReconnectAttempts = 0;
  setComposerActivity(t("pc.restartingAfterUpdate"));
  stepUpdateReconnectWatch();
}

// ── Model list event handling ──────────────────────────────────────

export function handleModelsListClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const action = target.dataset?.action;
  const row = target.closest(".model-row");
  const selectedModel = resolveSelectedSettingsModel(appState.latestStatus);
  const selectedModelId = String(selectedModel?.id || "");
  // Bar action buttons aren't inside a .model-row — they target the currently
  // selected model.
  const modelId = row?.dataset?.modelId || selectedModelId;
  const targetDiffers = Boolean(row?.dataset?.modelId) && String(modelId) !== selectedModelId;
  if (targetDiffers && selectedModelHasUnsavedChanges()) {
    blockModelSelectionChange();
    return;
  }
  if (!action) {
    if (row?.dataset?.modelId) {
      appState.selectedSettingsModelId = String(row.dataset.modelId);
      renderSettingsWorkspace(appState.latestStatus);
    }
    return;
  }
  if (action === "download") {
    startModelDownloadForModel(modelId);
  } else if (action === "cancel-download") {
    cancelActiveModelDownload(modelId);
  } else if (action === "activate") {
    activateSelectedModel(modelId);
  } else if (action === "delete") {
    deleteSelectedModel(modelId);
  }
}

// The model dropdown selects which model the editor targets. Mirrors the old
// row-click selection, including the unsaved-changes guard.
export function handleModelsSelectChange(event) {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement) || target.id !== "modelsSelect") return;
  const modelId = String(target.value || "");
  const selectedModel = resolveSelectedSettingsModel(appState.latestStatus);
  const selectedModelId = String(selectedModel?.id || "");
  if (!modelId || modelId === selectedModelId) return;
  if (selectedModelHasUnsavedChanges()) {
    blockModelSelectionChange();
    target.value = selectedModelId; // revert the dropdown
    return;
  }
  appState.selectedSettingsModelId = modelId;
  renderSettingsWorkspace(appState.latestStatus);
}
