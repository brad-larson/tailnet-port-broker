#!/usr/bin/env bash
# Proves .gitleaks.toml still catches what it is for and still lets through
# what is public by design. The fakes are assembled here at runtime so that no
# commit ever carries one — a committed fixture would trip the scan it tests.
#
#   bash test/secret-scan-selftest.sh      (needs gitleaks on PATH)
set -euo pipefail

CONFIG="$(cd "$(dirname "$0")/.." && pwd)/.gitleaks.toml"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

rand() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$1" || true; }
b64url() { printf '%s' "$1" | base64 | tr -d '=\n' | tr '/+' '_-'; }
jwt() { echo "$(b64url '{"alg":"HS256","typ":"JWT"}').$(b64url "$1").$(rand 43)"; }

failures=0
check() { # check <must-flag|must-pass> <name> <line>
  local want="$1" name="$2" dir="$WORK/$2"
  mkdir -p "$dir"
  printf '%s\n' "$3" > "$dir/sample.ts"
  local got=pass
  gitleaks dir "$dir" --config "$CONFIG" --no-banner --redact --log-level error >/dev/null 2>&1 || got=flag
  if [ "$want" = "must-$got" ]; then
    echo "  ok    $want  $name"
  else
    echo "  FAIL  $want  $name (got: $got)"
    failures=$((failures + 1))
  fi
}

echo "secret scan self-test ($CONFIG)"
check must-flag  pooler-url-password  "psql \"postgresql://postgres.$(rand 20 | tr 'A-Z' 'a-z'):$(rand 20)@aws-0-us-west-1.pooler.supabase.com:5432/postgres\""
check must-flag  supabase-service-role "const KEY = '$(jwt '{"iss":"supabase","ref":"abcdefghijklmnopqrst","role":"service_role","iat":1700000000,"exp":2000000000}')';"
check must-flag  openai-key           "OPENAI_API_KEY: sk-svcacct-$(rand 74)T3BlbkFJ$(rand 74)"
check must-flag  notion-token         "NOTION_TOKEN=ntn_$(rand 11 | tr 'A-Za-z' '0-9')$(rand 35)"
check must-pass  local-db-url         'DATABASE_URL=postgres://postgres:postgres@localhost:5433/fiveseasons'
check must-pass  doc-template-url     'psql "postgresql://postgres:[PASSWORD]@[HOST]:6543/postgres"'
check must-pass  env-reference        'psql "${SUPABASE_DB_URL:?Set SUPABASE_DB_URL}"'
check must-pass  supabase-demo-jwt    "LOCAL_KEY=\"$(jwt '{"iss":"supabase-demo","role":"anon","exp":1983812996}')\""
check must-pass  stripe-publishable   "STRIPE_PUBLISHABLE_KEY = 'pk_live_$(rand 99)'"
check must-pass  doc-placeholder      'curl -H "Authorization: Bearer YOUR_API_KEY" http://localhost:8080/acquire'
check must-flag  real-bearer          "curl -H \"Authorization: Bearer $(rand 40)\" https://api.example.com/v1"

if [ "$failures" -gt 0 ]; then
  echo "$failures self-test case(s) failed"
  exit 1
fi
echo "all self-test cases passed"
