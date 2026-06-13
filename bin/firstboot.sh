#!/usr/bin/env bash
set -euo pipefail

POTATO_BASE_DIR="${POTATO_BASE_DIR:-/opt/potato}"
POTATO_HOSTNAME="${POTATO_HOSTNAME:-potato}"
POTATO_ENFORCE_HOSTNAME="${POTATO_ENFORCE_HOSTNAME:-1}"
POTATO_HOSTNAME_SUFFIX_FROM_MAC="${POTATO_HOSTNAME_SUFFIX_FROM_MAC:-0}"
STATE_DIR="${POTATO_BASE_DIR}/state"

# Optionally append a short, stable suffix derived from the primary MAC address
# so multiple Potato OS units stop colliding on `potato.local` over mDNS (the
# second unit otherwise becomes unreachable). Off by default to preserve the
# plain `potato.local` hostname for single-unit setups; enable by setting
# POTATO_HOSTNAME_SUFFIX_FROM_MAC=1. Only applied when the hostname is still the
# default ("potato") — an explicit POTATO_HOSTNAME always wins.
if [ "${POTATO_HOSTNAME_SUFFIX_FROM_MAC}" = "1" ] && [ "${POTATO_HOSTNAME}" = "potato" ]; then
  mac_hex=""
  for iface in /sys/class/net/eth0/address /sys/class/net/wlan0/address; do
    if [ -r "${iface}" ]; then
      mac_hex="$(tr -d ':[:space:]' < "${iface}" | tr '[:upper:]' '[:lower:]')"
      [ -n "${mac_hex}" ] && break
    fi
  done
  if [ -n "${mac_hex}" ]; then
    POTATO_HOSTNAME="potato-${mac_hex: -3}"
  fi
fi
MARKER="${STATE_DIR}/firstboot.done"

mkdir -p "${POTATO_BASE_DIR}/bin" "${POTATO_BASE_DIR}/app" "${POTATO_BASE_DIR}/models" "${STATE_DIR}" "${POTATO_BASE_DIR}/config"
# Some image build hosts use a restrictive umask; keep /opt traversable for the potato service user.
if [ -d /opt ]; then
  chmod 0755 /opt || true
fi
chmod 0755 "${POTATO_BASE_DIR}" || true

if [ "${POTATO_ENFORCE_HOSTNAME}" = "1" ]; then
  current_hostname="$(hostnamectl --static 2>/dev/null || hostname)"
  if [ "${current_hostname}" != "${POTATO_HOSTNAME}" ]; then
    hostnamectl set-hostname "${POTATO_HOSTNAME}"
  fi

  hosts_tmp="$(mktemp)"
  cat /etc/hosts | awk -v hostname="${POTATO_HOSTNAME}" '
    BEGIN { printed = 0 }
    /^127\.0\.1\.1[[:space:]]/ {
      if (!printed) {
        print "127.0.1.1 " hostname ".local " hostname
        printed = 1
      }
      next
    }
    { print }
    END {
      if (!printed) {
        print "127.0.1.1 " hostname ".local " hostname
      }
    }
  ' > "${hosts_tmp}"
  mv "${hosts_tmp}" /etc/hosts

  if [ -f /etc/avahi/avahi-daemon.conf ]; then
    if grep -q '^[#[:space:]]*host-name=' /etc/avahi/avahi-daemon.conf; then
      sed -i "s/^[#[:space:]]*host-name=.*/host-name=${POTATO_HOSTNAME}/" /etc/avahi/avahi-daemon.conf
    else
      printf '\nhost-name=%s\n' "${POTATO_HOSTNAME}" >> /etc/avahi/avahi-daemon.conf
    fi
  fi

  systemctl restart avahi-daemon || true
fi

touch "${MARKER}"
