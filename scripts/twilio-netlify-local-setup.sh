#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env.twilio-activate"
EXAMPLE="$ROOT/.env.twilio-activate.example"

KEYS=(
  NETLIFY_AUTH_TOKEN
  TWILIO_ACCOUNT_SID
  TWILIO_API_KEY
  TWILIO_API_SECRET
  TWILIO_MESSAGING_SERVICE_SID
  TWILIO_AUTH_TOKEN
  TWILIO_WORKER_SECRET
)

is_placeholder() {
  local value="$1"
  [[ -z "$value" ]] && return 0
  [[ "$value" == *xxxx* ]] && return 0
  [[ "$value" == *XXXXXXXXXX* ]] && return 0
  return 1
}

set_env_value() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

read_env_value() {
  local key="$1"
  local line
  line="$(grep -m1 "^${key}=" "$ENV_FILE" 2>/dev/null || true)"
  [[ -n "$line" ]] || return 0
  printf '%s' "${line#*=}" | sed 's/^["'\'']//; s/["'\'']$//'
}

cd "$ROOT"

if [[ ! -f "$EXAMPLE" ]]; then
  echo "Missing template: $EXAMPLE" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$EXAMPLE" "$ENV_FILE"
  echo "Created $ENV_FILE"
else
  echo "Using existing $ENV_FILE"
fi

for key in "${KEYS[@]}"; do
  from_env="${!key-}"
  if [[ -n "$from_env" ]] && ! is_placeholder "$from_env"; then
    set_env_value "$key" "$from_env"
    echo "Loaded $key from agent environment"
  fi
done

current_worker="$(read_env_value TWILIO_WORKER_SECRET)"
if is_placeholder "$current_worker"; then
  set_env_value TWILIO_WORKER_SECRET "$(openssl rand -hex 32)"
  echo "Generated TWILIO_WORKER_SECRET"
fi

missing=()
for key in "${KEYS[@]}"; do
  value="$(read_env_value "$key")"
  if is_placeholder "$value"; then
    missing+=("$key")
  fi
done

echo "Env file: $ENV_FILE"
if ((${#missing[@]})); then
  echo "Still missing: ${missing[*]}"
  echo "Add them as Cloud Agent secrets, then rerun:"
  echo "  bash scripts/twilio-netlify-local-setup.sh"
  exit 2
fi

echo "Secrets present. Running Netlify production inspect..."
node "$ROOT/scripts/twilio-netlify-activate.js" --inspect-netlify-env --env-file "$ENV_FILE"
