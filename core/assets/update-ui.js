"use strict";

import { appState, CHANGELOG_SEEN_KEY } from "./state.js";
import { t } from "./i18n.js";
import { flushPendingNoticeDismissal } from "./platform-notify.js";

const ACTIVE_STATES = new Set(["downloading", "staging", "applying", "restart_pending"]);

let _onRestartPending = null;

export function registerUpdateCallbacks({ onRestartPending }) {
  _onRestartPending = onRestartPending || null;
}
export function resetUpdateCallbacks() { _onRestartPending = null; }

export function renderUpdateCard(updatePayload) {
  const card = document.getElementById("updateCard");
  const title = document.getElementById("updateCardTitle");
  const hint = document.getElementById("updateCardHint");
  const progressWrap = document.getElementById("updateCardProgress");
  const progressBar = document.getElementById("updateCardProgressBar");
  const startBtn = document.getElementById("updateStartBtn");
  const notesBtn = document.getElementById("updateNotesBtn");
  const retryBtn = document.getElementById("updateRetryBtn");
  if (!card || !title || !hint) return;

  const state = String(updatePayload?.state || "idle");
  const available = updatePayload?.available === true;
  const deferred = updatePayload?.deferred === true;
  const latest = String(updatePayload?.latest_version || "");
  const current = String(updatePayload?.current_version || "");
  const phase = String(updatePayload?.progress?.phase || "");
  const percent = Number(updatePayload?.progress?.percent || 0);
  const error = String(updatePayload?.progress?.error || "");
  const hasNotes = Boolean(updatePayload?.release_notes);
  const isActive = ACTIVE_STATES.has(state);

  // Post-update auto-open — must run before early returns that hide the card
  const justUpdatedTo = String(updatePayload?.just_updated_to || "");
  if (justUpdatedTo) {
    maybeAutoOpenChangelog(updatePayload);
  }

  // Default: hide everything
  if (startBtn) startBtn.hidden = true;
  if (notesBtn) notesBtn.hidden = true;
  if (retryBtn) retryBtn.hidden = true;
  if (progressWrap) progressWrap.hidden = true;

  // Block check button during active execution to prevent update.json overwrite
  const checkBtn = document.getElementById("updateCheckBtn");
  if (checkBtn) {
    checkBtn.disabled = appState.updateCheckInFlight || isActive;
  }

  // No update, idle — hide card unless there's a check error to surface
  if (state === "idle" && !available) {
    if (error) {
      // Check failed (rate_limited, network_error, etc.) — show feedback
      card.hidden = false;
      const errorLabels = {
        rate_limited: t("up.errRateLimited"),
        network_error: t("up.errNetwork"),
        parse_error: t("up.errParse"),
        unknown_error: t("up.errUnknown"),
      };
      title.textContent = t("up.checkFailed");
      hint.textContent = errorLabels[error] || t("up.checkFailedGeneric", { error });
      return;
    }
    card.hidden = true;
    return;
  }

  card.hidden = false;

  if (state === "failed") {
    title.textContent = t("up.updateFailed");
    hint.textContent = error || t("up.updateUnknownErr");
    if (retryBtn) {
      retryBtn.hidden = false;
      retryBtn.disabled = appState.updateStartInFlight;
      retryBtn.textContent = appState.updateStartInFlight ? t("up.retrying") : t("update.retry");
    }
    return;
  }

  if (state === "restart_pending") {
    title.textContent = t("up.restarting");
    hint.textContent = t("up.restartHint");
    if (_onRestartPending && !appState.updateReconnectActive) {
      _onRestartPending();
    }
    return;
  }

  if (state === "applying") {
    title.textContent = t("up.installing");
    hint.textContent = latest
      ? t("up.applyingVer", { v: latest })
      : t("up.applying");
    _showProgress(progressWrap, progressBar, percent);
    return;
  }

  if (state === "staging") {
    title.textContent = t("up.preparing");
    hint.textContent = latest
      ? t("up.extractingVer", { v: latest })
      : t("up.extracting");
    _showProgress(progressWrap, progressBar, percent);
    return;
  }

  if (state === "downloading") {
    title.textContent = t("up.downloading");
    hint.textContent = latest
      ? t("up.downloadingVer", { v: latest, pct: percent })
      : t("up.downloadingPct", { pct: percent });
    _showProgress(progressWrap, progressBar, percent);
    return;
  }

  // idle + available
  title.textContent = latest ? t("up.availableVer", { v: latest }) : t("update.available");
  hint.textContent = deferred
    ? t("up.modelDownloadInProgress")
    : (current ? t("up.currentReady", { v: current }) : t("up.newReady"));

  if (startBtn && !deferred) {
    startBtn.hidden = false;
    startBtn.disabled = appState.updateStartInFlight || isActive;
    startBtn.textContent = appState.updateStartInFlight ? t("up.starting") : t("update.install");
  }
  if (notesBtn && hasNotes) {
    notesBtn.hidden = false;
  }
}

function _showProgress(wrap, bar, percent) {
  if (!wrap || !bar) return;
  wrap.hidden = false;
  bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

export function isUpdateExecutionActive() {
  const state = String(appState.latestStatus?.update?.state || "idle");
  return ACTIVE_STATES.has(state);
}

export function setUpdateCheckInFlight(inFlight) {
  const btn = document.getElementById("updateCheckBtn");
  if (!btn) return;
  const blocked = Boolean(inFlight) || isUpdateExecutionActive();
  btn.disabled = blocked;
  btn.textContent = inFlight ? t("up.checking") : t("sidebar.checkUpdates");
}

export function setUpdateStartInFlight(inFlight) {
  appState.updateStartInFlight = Boolean(inFlight);
  const startBtn = document.getElementById("updateStartBtn");
  const retryBtn = document.getElementById("updateRetryBtn");
  if (startBtn) {
    startBtn.disabled = Boolean(inFlight);
    startBtn.textContent = inFlight ? t("up.starting") : t("update.install");
  }
  if (retryBtn) {
    retryBtn.disabled = Boolean(inFlight);
    retryBtn.textContent = inFlight ? t("up.retrying") : t("update.retry");
  }
}

// ── Changelog modal ───────────────────────────────────────────────────

let _markdownConfigured = false;

function _renderMarkdown(source) {
  if (!_markdownConfigured && window.marked) {
    window.marked.setOptions({ gfm: true, breaks: true });
    _markdownConfigured = true;
  }
  const html = window.marked?.parse(source) || "";
  return window.DOMPurify?.sanitize(html, {
    ALLOWED_TAGS: ["a", "blockquote", "br", "code", "em", "h1", "h2", "h3", "h4", "li", "ol", "p", "pre", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul"],
    ALLOWED_ATTR: ["href", "title"],
  }) || "";
}

export function openChangelogModal({ version, notes, subtitle } = {}) {
  appState.changelogModalOpen = true;
  document.body.classList.add("changelog-modal-open");
  const backdrop = document.getElementById("changelogBackdrop");
  const modal = document.getElementById("changelogModal");
  if (backdrop) backdrop.hidden = false;
  if (modal) modal.hidden = false;

  const titleEl = document.getElementById("changelogModalTitle");
  const subtitleEl = document.getElementById("changelogModalSubtitle");
  const contentEl = document.getElementById("changelogContent");

  if (titleEl) titleEl.textContent = version ? t("up.whatsNewVer", { v: version }) : t("changelog.title");
  if (subtitleEl) subtitleEl.textContent = subtitle || "";
  if (contentEl) {
    contentEl.innerHTML = notes
      ? _renderMarkdown(notes)
      : t("up.noReleaseNotes");
  }
}

export function closeChangelogModal() {
  appState.changelogModalOpen = false;
  document.body.classList.remove("changelog-modal-open");
  const backdrop = document.getElementById("changelogBackdrop");
  const modal = document.getElementById("changelogModal");
  if (backdrop) backdrop.hidden = true;
  if (modal) modal.hidden = true;
  flushPendingNoticeDismissal();
}

export function bindChangelogModal() {
  const closeBtn = document.getElementById("changelogCloseBtn");
  const backdrop = document.getElementById("changelogBackdrop");
  if (closeBtn) closeBtn.addEventListener("click", closeChangelogModal);
  if (backdrop) backdrop.addEventListener("click", closeChangelogModal);
}

function maybeAutoOpenChangelog(updatePayload) {
  const version = String(updatePayload?.just_updated_to || "");
  if (!version) return;
  const seen = localStorage.getItem(CHANGELOG_SEEN_KEY);
  if (seen === version) return;
  localStorage.setItem(CHANGELOG_SEEN_KEY, version);
  openChangelogModal({
    version,
    notes: updatePayload?.just_updated_release_notes || updatePayload?.release_notes || null,
    subtitle: t("up.justUpdated"),
  });
}
