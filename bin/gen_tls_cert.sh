#!/usr/bin/env bash
#
# Generate a self-signed TLS certificate for the Potato OS portal.
#
# Used by install_dev.sh when POTATO_TLS=1, but also runnable by hand to
# (re)issue the cert. Idempotent: skips if a cert already exists unless
# POTATO_TLS_FORCE=1.
#
#   gen_tls_cert.sh [CERT_DIR] [PRIMARY_HOSTNAME]
#
# Defaults: CERT_DIR=/opt/potato/state/tls, PRIMARY_HOSTNAME=potato
#
set -euo pipefail

CERT_DIR="${1:-/opt/potato/state/tls}"
PRIMARY_HOST="${2:-${POTATO_HOSTNAME:-potato}}"
FORCE="${POTATO_TLS_FORCE:-0}"

CERT="${CERT_DIR}/cert.pem"
KEY="${CERT_DIR}/key.pem"

if ! command -v openssl >/dev/null 2>&1; then
  printf 'ERROR: openssl not found; cannot generate TLS certificate.\n' >&2
  exit 1
fi

mkdir -p "${CERT_DIR}"

if [ -f "${CERT}" ] && [ -f "${KEY}" ] && [ "${FORCE}" != "1" ]; then
  printf 'TLS certificate already present: %s (set POTATO_TLS_FORCE=1 to regenerate)\n' "${CERT}"
  exit 0
fi

# SANs so the cert validates via potato.local, the hostname, and loopback.
SAN="DNS:potato.local,DNS:${PRIMARY_HOST},DNS:${PRIMARY_HOST}.local,DNS:localhost,IP:127.0.0.1,IP:::1"

openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "${KEY}" -out "${CERT}" \
  -subj "/CN=potato.local/O=Potato OS" \
  -addext "subjectAltName=${SAN}"

chmod 600 "${KEY}"
chmod 644 "${CERT}"

printf 'Generated self-signed TLS certificate:\n  cert: %s\n  key:  %s\n  SAN:  %s\n' \
  "${CERT}" "${KEY}" "${SAN}"
