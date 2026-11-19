"use strict";

import { appState } from "./state.js";
import { getLang, t } from "./i18n.js";

function truncateModelName(filename) {
  const name = String(filename || "");
  const base = name.replace(/\.gguf$/i, "");
  return base.length > 32 ? base.slice(0, 29) + "..." : base;
}

function formatModelSizeGb(rawBytes) {
  const bytes = Number(rawBytes);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const gigabyte = 1_000_000_000;
  const language = typeof getLang === "function" ? getLang() : "en";
  const value = (bytes / gigabyte).toLocaleString(language || "en", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${value} GB`;
}

function statusLabel(status) {
  const s = String(status || "").toLowerCase();
  if (s === "ready") return "Ready";
  if (s === "downloading") return "Downloading";
  if (s === "failed" || s === "error") return "Failed";
  if (s === "not_downloaded") return "Not downloaded";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function populateModelSwitcher() {
  const list = document.getElementById("modelSwitcherList");
  if (!list) return;
  const models = Array.isArray(appState.latestStatus?.models) ? appState.latestStatus.models : [];
  list.innerHTML = "";
  if (models.length === 0) {
    const li = document.createElement("li");
    li.className = "model-switcher-item disabled";
    li.textContent = t("ms.noModels");
    list.appendChild(li);
    return;
  }
  for (const model of models) {
    const li = document.createElement("li");
    const isReady = String(model.status || "").toLowerCase() === "ready";
    const isActive = model.is_active === true;
    const health = model.health || {};
    const attempted = health.attempted === true;
    const failed = health.failed === true;
    li.className = "model-switcher-item";
    li.dataset.modelId = String(model.id || "");
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(isActive));
    if (isActive) li.classList.add("active");
    if (!isReady) li.classList.add("disabled");

    const check = document.createElement("span");
    check.className = "model-switcher-check";
    check.textContent = isActive ? "✓" : "";
    check.setAttribute("aria-hidden", "true");

    const name = document.createElement("span");
    name.className = "model-switcher-name";
    const sizeText = formatModelSizeGb(model.storage?.size_bytes);
    const displayName = truncateModelName(model.filename);
    name.textContent = sizeText ? `${displayName} (${sizeText})` : displayName;
    name.title = String(model.filename || "");

    const statusChip = document.createElement("span");
    statusChip.className = "model-switcher-status";
    statusChip.textContent = isActive ? "" : statusLabel(model.status);
    if (failed) {
      // Deploy was attempted and the model never became ready.
      li.classList.add("failed");
      li.title = String(health.last_error || "");
      statusChip.textContent = t("ms.failed");
    } else if (isReady && !attempted) {
      // Downloaded but never loaded, so its state on this device is unknown.
      li.classList.add("untested");
      statusChip.textContent = t("ms.untested");
    }

    li.appendChild(check);
    li.appendChild(name);
    li.appendChild(statusChip);
    list.appendChild(li);
  }
}

export function openModelSwitcher() {
  const el = document.getElementById("modelSwitcher");
  const badge = document.getElementById("statusBadge");
  if (!el) return;
  populateModelSwitcher();
  el.hidden = false;
  requestAnimationFrame(() => {
    el.classList.add("open");
    el.focus();
  });
  if (badge) badge.setAttribute("aria-expanded", "true");
  appState.modelSwitcherOpen = true;
}

export function closeModelSwitcher() {
  const el = document.getElementById("modelSwitcher");
  const badge = document.getElementById("statusBadge");
  if (!el) return;
  el.classList.remove("open");
  el.hidden = true;
  if (badge) badge.setAttribute("aria-expanded", "false");
  appState.modelSwitcherOpen = false;
}

export function toggleModelSwitcher() {
  if (appState.modelSwitcherOpen) {
    closeModelSwitcher();
  } else {
    openModelSwitcher();
  }
}
