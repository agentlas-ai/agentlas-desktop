#!/usr/bin/env bash
set -euo pipefail

email="${APPLE_ID:-}"
common_name="Agentlas Developer ID"
out_dir="${AGENTLAS_SIGNING_DIR:-signing}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --email=*) email="${1#*=}" ;;
    --common-name=*) common_name="${1#*=}" ;;
    --out-dir=*) out_dir="${1#*=}" ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if [[ -z "$email" ]]; then
  echo "APPLE_ID or --email is required." >&2
  echo "Example: npm run release:csr -- --email=you@example.com" >&2
  exit 1
fi

mkdir -p "$out_dir"
key_path="$out_dir/agentlas-developer-id.key"
csr_path="$out_dir/agentlas-developer-id.csr"

if [[ -e "$key_path" || -e "$csr_path" ]]; then
  echo "Refusing to overwrite existing signing files in $out_dir." >&2
  echo "Move or delete $key_path and $csr_path first." >&2
  exit 1
fi

openssl req \
  -new \
  -newkey rsa:2048 \
  -nodes \
  -keyout "$key_path" \
  -out "$csr_path" \
  -subj "/emailAddress=$email/CN=$common_name/C=US"

chmod 600 "$key_path"

cat <<EOF
Created:
  private key: $key_path
  CSR:         $csr_path

Next:
  1. Apple Developer > Certificates > + > Developer ID Application
  2. Upload $csr_path
  3. Download the Developer ID Application .cer
  4. Run:
     npm run release:p12 -- --cer=/path/to/developerID_application.cer

Do not commit $out_dir. It contains signing material.
EOF
