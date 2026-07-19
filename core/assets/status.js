"use strict";

import { appState } from "./state.js";
import { formatBytes, formatCountdownSeconds } from "./utils.js";
import { t } from "./i18n.js";

    export function isLocalModelConnected(statusPayload) {
      const backendMode = String(
        statusPayload?.backend?.active
        || statusPayload?.backend?.mode
        || ""
      ).toLowerCase();
      const isReady = String(statusPayload?.state || "").toUpperCase() === "READY";
      const llamaHealthy = statusPayload?.llama_server?.healthy === true;
      return backendMode === "llama" && isReady && llamaHealthy;
    }

    export function updateLlamaIndicator(statusPayload) {
      const badge = document.getElementById("statusBadge");
      const dot = document.getElementById("statusDot");
      const spinner = document.getElementById("statusSpinner");
      const label = document.getElementById("statusLabel");
      if (!badge || !dot || !label) return;
      const backendMode = String(
        statusPayload?.backend?.active
        || statusPayload?.backend?.mode
        || ""
      ).toLowerCase();
      const modelFilename = String(statusPayload?.model?.filename || "").trim();
      const modelSuffix = modelFilename ? `:${modelFilename}` : "";
      const isReady = String(statusPayload?.state || "").toUpperCase() === "READY";
      const statusState = String(statusPayload?.state || "").toUpperCase();
      const hasModel = statusPayload?.model_present === true;
      const llamaHealthy = statusPayload?.llama_server?.healthy === true;
      const isHealthy = isLocalModelConnected(statusPayload) || (backendMode === "fake" && isReady);
      const isLoading = backendMode === "llama" && hasModel && !llamaHealthy && statusState === "BOOTING";
      const isFailed = backendMode === "llama" && statusState === "ERROR";
      const runtimeFamily = statusPayload?.llama_runtime?.current?.family;
      const runtimeLabel = runtimeFamily === "llama_cpp" ? "llama.cpp" : (runtimeFamily || "llama.cpp");
      badge.classList.remove("online", "loading", "failed", "offline");
      dot.classList.remove("online", "loading", "failed", "offline");
      dot.hidden = false;
      if (spinner) {
        spinner.hidden = true;
        spinner.classList.remove("has-progress");
        spinner.style.removeProperty("--load-pct");
      }
      if (backendMode === "fake" && isReady) {
        badge.classList.add("online");
        dot.classList.add("online");
        label.textContent = `${t("badge.connected")}:Fake Backend`;
      } else if (isHealthy) {
        badge.classList.add("online");
        dot.classList.add("online");
        label.textContent = `${t("badge.connected")}:${runtimeLabel}${modelSuffix}`;
      } else if (isLoading) {
        badge.classList.add("loading");
        dot.classList.add("loading");
        dot.hidden = true;
        if (spinner) spinner.hidden = false;
        const loadPct = statusPayload?.model_loading?.progress_percent;
        if (spinner && typeof loadPct === "number") {
          spinner.classList.add("has-progress");
          spinner.style.setProperty("--load-pct", loadPct);
        }
        const pctSuffix = typeof loadPct === "number" ? `:${loadPct}%` : modelSuffix;
        label.textContent = `${t("badge.loading")}:${runtimeLabel}${pctSuffix}`;
      } else if (isFailed) {
        badge.classList.add("failed");
        dot.classList.add("failed");
        label.textContent = `${t("badge.failed")}:${runtimeLabel}${modelSuffix}`;
      } else {
        badge.classList.add("offline");
        dot.classList.add("offline");
        label.textContent = `${t("badge.disconnected")}:${runtimeLabel}`;
      }
    }

    export function findResumableFailedModel(statusPayload) {
      const models = Array.isArray(statusPayload?.models) ? statusPayload.models : [];
      return models.find((item) => (
        String(item?.source_type || "") === "url"
        && String(item?.status || "").toLowerCase() === "failed"
      )) || null;
    }

    export function renderDownloadPrompt(statusPayload) {
      const prompt = document.getElementById("downloadPrompt");
      const hint = document.getElementById("downloadPromptHint");
      const startBtn = document.getElementById("startDownloadBtn");
      if (!prompt || !hint || !startBtn) return;

      const state = String(statusPayload?.state || "");
      const hasModel = statusPayload?.model_present === true;
      const downloadActive = statusPayload?.download?.active === true || state === "DOWNLOADING";
      if (hasModel || downloadActive || state === "READY") {
        prompt.hidden = true;
        startBtn.textContent = t("download.startNow");
        startBtn.disabled = false;
        return;
      }

      prompt.hidden = false;
      const defaultModelFilename = String(statusPayload?.download?.default_model_filename || "").replace(/\.gguf$/i, "");
      const titleEl = prompt.querySelector(".download-prompt-title");
      if (titleEl) {
        titleEl.textContent = defaultModelFilename
          ? t("dl.requiredNamed", { name: defaultModelFilename })
          : t("download.required");
      }
      const countdownEnabled = statusPayload?.download?.countdown_enabled !== false;
      const autoStartRemaining = Number(statusPayload.download.auto_start_remaining_seconds);
      const freeBytes = Number(statusPayload?.system?.storage_free_bytes);
      const downloadError = String(statusPayload?.download?.error || "");
      const resumableFailedModel = findResumableFailedModel(statusPayload);
      if (
        downloadError === "insufficient_storage"
        || (Number.isFinite(freeBytes) && freeBytes < 512 * 1024 * 1024)
      ) {
        const free = formatBytes(statusPayload?.system?.storage_free_bytes);
        hint.textContent = t("dl.insufficientStorage", { free });
      } else if (downloadError === "download_failed" && resumableFailedModel) {
        hint.textContent = t("dl.lastFailed", { done: formatBytes(resumableFailedModel?.bytes_downloaded), total: formatBytes(resumableFailedModel?.bytes_total) });
      } else if (!countdownEnabled) {
        hint.textContent = t("dl.autoPaused");
      } else if (Number.isFinite(autoStartRemaining) && autoStartRemaining > 0) {
        hint.textContent = t("dl.autoCountdown", { time: formatCountdownSeconds(autoStartRemaining) });
      } else {
        hint.textContent = t("dl.autoSoon");
      }

      // Vision models pull a second file (the vision encoder / projector) right
      // after the main weights, so warn up front to avoid the "why is it
      // downloading again?" surprise.  Only relevant before/while the main
      // model is being fetched — not on storage/failure messages above.
      const isVisionModel = statusPayload?.model?.capabilities?.vision === true;
      const isStorageOrFailure =
        downloadError === "insufficient_storage"
        || (Number.isFinite(freeBytes) && freeBytes < 512 * 1024 * 1024)
        || (downloadError === "download_failed" && resumableFailedModel);
      if (isVisionModel && !isStorageOrFailure) {
        hint.textContent += t("dl.visionEncoderNote");
      }

      if (appState.downloadStartInFlight) {
        startBtn.textContent = resumableFailedModel ? t("dl.resuming") : t("dl.starting");
        startBtn.disabled = true;
      } else {
        startBtn.textContent = resumableFailedModel ? t("bar.resumeDownload") : t("download.startNow");
        startBtn.disabled = false;
      }
    }

    export function renderStatusActions(statusPayload) {
      const actions = document.getElementById("statusActions");
      const resumeBtn = document.getElementById("statusResumeDownloadBtn");
      if (!actions || !resumeBtn) return;
      const hasModel = statusPayload?.model_present === true;
      const state = String(statusPayload?.state || "").toUpperCase();
      const downloadError = String(statusPayload?.download?.error || "");
      const resumableFailedModel = findResumableFailedModel(statusPayload);
      const showResume = hasModel && state === "READY" && downloadError === "download_failed" && !!resumableFailedModel;
      actions.hidden = !showResume;
      resumeBtn.disabled = appState.downloadStartInFlight;
      resumeBtn.textContent = appState.downloadStartInFlight ? t("dl.resuming") : t("status.resume");
    }

    export function renderCompatibilityWarnings(statusPayload) {
      const el = document.getElementById("compatibilityWarnings");
      const textEl = document.getElementById("compatibilityWarningsText");
      const overrideBtn = document.getElementById("compatibilityOverrideBtn");
      if (!el) return;
      const warnings = Array.isArray(statusPayload?.compatibility?.warnings)
        ? statusPayload.compatibility.warnings
        : [];
      const overrideEnabled = statusPayload?.compatibility?.override_enabled === true;
      if (!warnings.length) {
        el.hidden = true;
        if (textEl) textEl.textContent = "";
        else el.textContent = "";
        if (overrideBtn) {
          overrideBtn.hidden = true;
          overrideBtn.disabled = false;
          overrideBtn.textContent = t("runtime.tryAnyway");
        }
        return;
      }
      const text = warnings
        .map((item) => String(item?.message || t("compat.warning")))
        .filter((item) => item.length > 0)
        .join(" | ");
      if (textEl) textEl.textContent = text || t("compat.warning");
      else el.textContent = text || t("compat.warning");
      if (overrideBtn) {
        overrideBtn.hidden = overrideEnabled;
      }
      el.hidden = false;
    }

    export function formatSidebarStatusDetail(statusPayload) {
      const download = statusPayload?.download || {};
      const downloaded = formatBytes(download.bytes_downloaded);
      const total = formatBytes(download.bytes_total);
      const state = String(statusPayload?.state || "").toUpperCase();
      const downloadActive = download.active === true || state === "DOWNLOADING";
      const downloadError = String(download.error || "");
      const resumableFailedModel = findResumableFailedModel(statusPayload);
      if (downloadActive) {
        return t("sd.downloadPct", { pct: download.percent, done: downloaded, total });
      }
      const projDl = statusPayload?.projector_download;
      if (projDl && projDl.active === true) {
        return t("sd.downloadingEncoder", { bytes: formatBytes(projDl.bytes_downloaded || 0) });
      }
      if (downloadError === "download_failed" && resumableFailedModel) {
        return t("sd.downloadFailed", { done: downloaded, total });
      }
      if (download.auto_download_paused === true) {
        return t("sd.autoPaused");
      }
      return t("sd.noActive");
    }

    export function formatModelStatusLabel(rawStatus) {
      const normalized = String(rawStatus || "unknown").trim().toLowerCase();
      if (!normalized) return t("mstatus.unknown");
      // Known statuses are translated; anything unexpected falls back to a
      // title-cased version of the raw value.
      const key = `mstatus.${normalized}`;
      const translated = t(key);
      if (translated !== key) return translated;
      return normalized
        .replaceAll("_", " ")
        .split(" ")
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
    }
