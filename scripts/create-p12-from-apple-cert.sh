#!/usr/bin/env bash
set -euo pipefail

cer_path=""
signing_dir="${AGENTLAS_SIGNING_DIR:-signing}"
key_path="$signing_dir/agentlas-developer-id.key"
out_path="$signing_dir/agentlas-developer-id.p12"
password="${P12_PASSWORD:-}"
set_github_secrets="0"
repo="agentlas-ai/agentlas-desktop"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cer=*) cer_path="${1#*=}" ;;
    --key=*) key_path="${1#*=}" ;;
    --out=*) out_path="${1#*=}" ;;
    --password=*) password="${1#*=}" ;;
    --set-github-secrets) set_github_secrets="1" ;;
    --repo=*) repo="${1#*=}" ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if [[ -z "$cer_path" || ! -f "$cer_path" ]]; then
  echo "--cer=/path/to/DeveloperIDApplication.cer is required." >&2
  exit 1
fi
if [[ ! -f "$key_path" ]]; then
  echo "Private key not found: $key_path" >&2
  echo "Run npm run release:csr first, or pass --key=/path/to/private.key." >&2
  exit 1
fi
if [[ -z "$password" ]]; then
  password="$(openssl rand -base64 24)"
fi

mkdir -p "$(dirname "$out_path")"
pem_path="${out_path%.p12}.pem"

openssl x509 -inform DER -in "$cer_path" -out "$pem_path" 2>/dev/null || cp "$cer_path" "$pem_path"
openssl pkcs12 \
  -export \
  -legacy \
  -inkey "$key_path" \
  -in "$pem_path" \
  -out "$out_path" \
  -passout "pass:$password"
chmod 600 "$out_path"

cat <<EOF
Created:
  p12: $out_path

Use this password for CSC_KEY_PASSWORD / MAC_DEVELOPER_ID_CERTIFICATE_PASSWORD:
  $password
EOF

if [[ "$set_github_secrets" == "1" ]]; then
  base64 -i "$out_path" | gh secret set MAC_DEVELOPER_ID_CERTIFICATE -R "$repo" -b-
  printf "%s" "$password" | gh secret set MAC_DEVELOPER_ID_CERTIFICATE_PASSWORD -R "$repo" -b-
  echo "Set GitHub secrets on $repo:"
  echo "  MAC_DEVELOPER_ID_CERTIFICATE"
  echo "  MAC_DEVELOPER_ID_CERTIFICATE_PASSWORD"
fi
