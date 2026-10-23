#!/usr/bin/env bash
# SQL contract checks for the n8n scoring and posting pipeline, run against a
# throwaway Postgres 16 container.
#
# Each check drives the real files: scripts/init.sql (schema and migration) and
# n8n/sql/*.sql (the statements). The n8n Postgres node binds $1..$n
# positionally, so every statement file is PREPAREd and EXECUTEd the same way.
# Every check prints PASS or FAIL; the script exits 1 if any check fails.
#
# Usage: bash tests/sql.test.sh   (needs docker)
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
INIT_SQL="$REPO/scripts/init.sql"
INSERT_SQL="$REPO/n8n/sql/insert-candidates.sql"
CLAIM_UNSCORED_SQL="$REPO/n8n/sql/claim-unscored.sql"
SAVE_SCORES_SQL="$REPO/n8n/sql/save-scores.sql"
CLAIM_TOP_SQL="$REPO/n8n/sql/claim-top-articles.sql"

CONT="veille-sqltest-$$"
WORK=$(mktemp -d)
FAILS=0
ALL_CHANNELS="ARRAY['Tech News','Company Blogs','Reddit Communities','Other']"

cleanup() {
  docker rm -f "$CONT" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

docker run -d --rm --name "$CONT" -e POSTGRES_PASSWORD=test postgres:16-alpine >/dev/null
for _ in $(seq 1 120); do
  if docker exec "$CONT" pg_isready -q -h 127.0.0.1 -U postgres 2>/dev/null; then
    break
  fi
  sleep 0.5
done
docker exec "$CONT" pg_isready -q -h 127.0.0.1 -U postgres || {
  echo "FAIL postgres container never became ready"
  exit 1
}

# expect NAME EXPECTED ACTUAL
expect() {
  if [ "$2" = "$3" ]; then
    echo "PASS $1"
  else
    echo "FAIL $1: expected [$2], got [$3]"
    FAILS=$((FAILS + 1))
  fi
}

# sql DB: runs the SQL read from stdin and prints unaligned rows ('|' separated).
# A SQL error prints "SQL_ERROR: ..." instead, so the check fails with the message.
sql() {
  if docker exec -i "$CONT" psql -X -q -v ON_ERROR_STOP=1 -At -F '|' -U postgres -d "$1" \
    >"$WORK/out" 2>"$WORK/err"; then
    cat "$WORK/out"
  else
    echo "SQL_ERROR: $(sed '/^NOTICE:/d' "$WORK/err" | tr '\n' ' ')"
  fi
}

# q DB SQL: runs one statement.
q() { printf '%s\n' "$2" | sql "$1"; }

# init DB: applies scripts/init.sql the way a deploy does; prints "ok" or the error.
init() {
  if docker exec -i "$CONT" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$1" \
    <"$INIT_SQL" >/dev/null 2>"$WORK/init.err"; then
    echo ok
  else
    echo "INIT_ERROR: $(sed '/^NOTICE:/d' "$WORK/init.err" | tr '\n' ' ')"
  fi
}

# new_db DB: creates an empty database and applies scripts/init.sql to it.
new_db() {
  q postgres "CREATE DATABASE $1;"
  init "$1"
}

# prep NAME FILE: a PREPARE line for the statement in FILE (the file ends with ';').
prep() { printf 'PREPARE %s AS %s\n' "$1" "$(cat "$2")"; }

# run_stmt DB FILE ARGS: EXECUTEs the statement in FILE with ARGS and prints the rows.
run_stmt() {
  if [ ! -f "$2" ]; then
    echo "MISSING ${2#"$REPO"/}"
    return 0
  fi
  {
    prep stmt "$2"
    printf 'EXECUTE stmt(%s);\n' "$3"
  } | sql "$1"
}

# count_rows OUT: number of rows in OUT, or the error text when the statement failed.
count_rows() {
  case "$1" in
    SQL_ERROR* | MISSING*) printf '%s' "$1" ;;
    *) awk 'NF { n++ } END { print n + 0 }' <<<"$1" ;;
  esac
}

# prelude: PREPAREs the two pipeline statements that ingest and score a candidate.
prelude() {
  prep ins "$INSERT_SQL"
  prep sc "$SAVE_SCORES_SQL"
}

# ingest URL TITLE SOURCE_TYPE PRIO CONFIDENCE SCORE: EXECUTEs insert-candidates and
# save-scores for one candidate (run after prelude in the same session).
ingest() {
  printf "EXECUTE ins('%s', '%s', 'desc', 'Src', '%s', %s, now() - interval '1 hour');\n" "$1" "$2" "$3" "$4"
  printf '%s\n' "SELECT id AS scored_id FROM rss_articles WHERE url = '$1' \gset"
  printf "EXECUTE sc(:scored_id, %s, %s, 'LLM', 'tag', 'sum', 'take');\n" "$5" "$6"
}

# column N OUT: column N of every row of OUT, space separated.
column() {
  awk -F'|' -v n="$1" 'NF { out = out (out == "" ? "" : " ") $n } END { print out }' <<<"$2"
}

# wait_for DB SQL: polls until SQL returns 't' (about 10 s at most).
wait_for() {
  local _
  for _ in $(seq 1 100); do
    if [ "$(q "$1" "$2")" = "t" ]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

# a. Legacy upgrade. Catches: no backfill (the legacy row stays unsent and becomes
#    scorable); no DROP FUNCTION (the dead dedup functions survive on a live DB).
check_legacy_upgrade() {
  q postgres "CREATE DATABASE sc_legacy;"
  sql sc_legacy <<'SQL'
CREATE TABLE rss_articles (
    id SERIAL PRIMARY KEY,
    url VARCHAR(2048) UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    content TEXT,
    source VARCHAR(255) NOT NULL,
    source_type VARCHAR(100),
    category VARCHAR(100),
    published_at TIMESTAMP WITH TIME ZONE,
    sent_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
INSERT INTO rss_articles (url, title, source, source_type, published_at)
VALUES ('https://legacy.example/a', 'Legacy story', 'Legacy', 'news', now() - interval '1 hour');
CREATE FUNCTION filter_new_urls(urls_to_check TEXT[]) RETURNS TABLE(url TEXT)
    LANGUAGE sql AS 'SELECT NULL::TEXT WHERE false';
CREATE FUNCTION check_url_duplicates(urls_to_check TEXT[]) RETURNS TABLE(
    url TEXT, is_new BOOLEAN, existing_id INTEGER,
    existing_created_at TIMESTAMP WITH TIME ZONE, existing_sent_at TIMESTAMP WITH TIME ZONE)
    LANGUAGE sql AS 'SELECT NULL::TEXT, NULL::BOOLEAN, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ WHERE false';
CREATE FUNCTION process_rss_batch(articles_json JSONB) RETURNS TABLE(
    url TEXT, is_new BOOLEAN, should_process BOOLEAN, article_data JSONB)
    LANGUAGE sql AS 'SELECT NULL::TEXT, NULL::BOOLEAN, NULL::BOOLEAN, NULL::JSONB WHERE false';
SQL
  expect "a: init.sql applies to a live pre-migration table" ok "$(init sc_legacy)"
  expect "a: legacy row is marked sent and out of the scoring budget" "t|3" \
    "$(q sc_legacy "SELECT sent_at IS NOT NULL, score_attempts FROM rss_articles WHERE url = 'https://legacy.example/a';")"
  expect "a: claim-unscored never returns a legacy row" "" \
    "$(run_stmt sc_legacy "$CLAIM_UNSCORED_SQL" 10)"
  expect "a: dead dedup functions dropped, kept ones remain" "0|2" \
    "$(q sc_legacy "SELECT (SELECT count(*) FROM pg_proc WHERE proname IN ('filter_new_urls', 'check_url_duplicates', 'process_rss_batch')), (SELECT count(*) FROM pg_proc WHERE proname IN ('purge_old_articles', 'get_source_stats'));")"
}

# b. Re-running init.sql after the migration. Catches: an unguarded backfill (every
#    re-run would mark fresh candidates as sent and exhausted).
check_rerun_keeps_fresh_rows() {
  q sc_legacy "INSERT INTO rss_articles (url, title, source, source_type, published_at)
VALUES ('https://fresh.example/b', 'Fresh story', 'Fresh', 'news', now() - interval '1 hour');"
  expect "b: init.sql re-runs cleanly" ok "$(init sc_legacy)"
  expect "b: fresh candidate stays unscored" "t|0" \
    "$(q sc_legacy "SELECT sent_at IS NULL, score_attempts FROM rss_articles WHERE url = 'https://fresh.example/b';")"
}

# c. insert-candidates.sql is idempotent per URL. Catches: no ON CONFLICT (the second
#    insert of a known URL errors out instead of being a no-op, or duplicates the row).
check_insert_is_idempotent() {
  expect "c: fresh database" ok "$(new_db sc_insert)"
  local out
  out=$({
    prep ins "$INSERT_SQL"
    printf "EXECUTE ins('https://dup.example/c', 'Dup story', 'desc', 'Src', 'news', 0, now());\n"
    printf "EXECUTE ins('https://dup.example/c', 'Dup story again', 'desc', 'Src', 'news', 0, now());\n"
  } | sql sc_insert)
  expect "c: inserting the same url twice is a silent no-op" "" "$out"
  expect "c: one row for the url" "1" \
    "$(q sc_insert "SELECT count(*) FROM rss_articles WHERE url = 'https://dup.example/c';")"
}

# h. A story already sent under another url (legacy raw url, or another source) is not
#    ingested again. Catches: plain INSERT (it would be re-scored by Gemini).
check_insert_skips_already_sent_title() {
  expect "h: fresh database" ok "$(new_db sc_h)"
  q sc_h "INSERT INTO rss_articles (url, title, source, sent_at) VALUES ('https://h.example/x/', 'Story H', 'Src', now());" >/dev/null
  run_stmt sc_h "$INSERT_SQL" "'https://h.example/x', 'story h', 'desc', 'Src', 'Tech News', 0, now()" >/dev/null
  expect "h: the already-sent story is not inserted again" "1" "$(q sc_h "SELECT count(*) FROM rss_articles;")"
  run_stmt sc_h "$INSERT_SQL" "'https://h.example/y', 'Story Y', 'desc', 'Src', 'Tech News', 0, now()" >/dev/null
  expect "h: a new story is inserted" "2" "$(q sc_h "SELECT count(*) FROM rss_articles;")"
}

# i. Only channels with a configured webhook are claimed. Catches: claiming rows whose
#    webhook is unset (marked sent, then dropped by Format Embeds: lost for good).
check_claim_skips_channels_without_webhook() {
  expect "i: fresh database" ok "$(new_db sc_i)"
  {
    prelude
    ingest 'https://i.example/t' 'Story T' 'Tech News' 0 90 70
    ingest 'https://i.example/o' 'Story O' news 0 90 80
  } | sql sc_i
  expect "i: only the Tech News row is claimed" "Story T" "$(column 3 "$(run_stmt sc_i "$CLAIM_TOP_SQL" "60, 5, ARRAY['Tech News']")")"
  expect "i: the unknown source_type row (Other) stays unsent" "1" "$(q sc_i "SELECT count(*) FROM rss_articles WHERE sent_at IS NULL;")"
}

# d. Attempt cap. Catches: no score_attempts limit (a candidate that Gemini keeps
#    failing on would be claimed for scoring forever).
check_attempt_cap() {
  expect "d: fresh database" ok "$(new_db sc_attempts)"
  q sc_attempts "INSERT INTO rss_articles (url, title, source, source_type, published_at)
VALUES ('https://attempts.example/d', 'Attempts story', 'Src', 'news', now());"
  local counts=()
  for _ in 1 2 3 4; do
    counts+=("$(count_rows "$(run_stmt sc_attempts "$CLAIM_UNSCORED_SQL" 10)")")
  done
  expect "d: claimed for scoring 3 times, then never again" "1 1 1 0" "${counts[*]}"
}

# e. Claim for posting: score and confidence thresholds, per-channel cap, ordering.
check_claim_threshold_cap_order() {
  # e1: the 7 scored rows of the brief (5 valid, 2 decoys). Catches: no score filter
  # (decoy score 50 returned); no confidence filter (decoy confidence 80 returned, score
  # 90 leaks into the output); a claim that returns already sent rows again.
  expect "e1: fresh database" ok "$(new_db sc_e1)"
  {
    prelude
    ingest 'https://e.example/65' 'Story 65' news 0 90 65
    ingest 'https://e.example/63' 'Story 63' news 0 90 63
    ingest 'https://e.example/67' 'Story 67' news 0 90 67
    ingest 'https://e.example/64' 'Story 64' news 0 90 64
    ingest 'https://e.example/66' 'Story 66' news 0 90 66
    ingest 'https://e.example/d1' 'Decoy low score' news 0 90 50
    ingest 'https://e.example/d2' 'Decoy low confidence' news 0 80 90
  } | sql sc_e1
  local first second
  first=$(run_stmt sc_e1 "$CLAIM_TOP_SQL" "60, 5, $ALL_CHANNELS")
  expect "e1: 5 valid rows returned, best score first" "67 66 65 64 63" "$(column 8 "$first")"
  second=$(run_stmt sc_e1 "$CLAIM_TOP_SQL" "60, 5, $ALL_CHANNELS")
  expect "e1: second claim returns nothing" "" "$second"

  # e2: 7 valid rows in one source_type. Catches: no per-channel cap (7 returned, not
  # 5); no ordering by score; a row claimed in the first claim is returned again.
  expect "e2: fresh database" ok "$(new_db sc_e2)"
  {
    prelude
    ingest 'https://e.example/63' 'Story 63' news 0 90 63
    ingest 'https://e.example/61' 'Story 61' news 0 90 61
    ingest 'https://e.example/66' 'Story 66' news 0 90 66
    ingest 'https://e.example/67' 'Story 67' news 0 90 67
    ingest 'https://e.example/62' 'Story 62' news 0 90 62
    ingest 'https://e.example/65' 'Story 65' news 0 90 65
    ingest 'https://e.example/64' 'Story 64' news 0 90 64
  } | sql sc_e2
  first=$(run_stmt sc_e2 "$CLAIM_TOP_SQL" "60, 5, $ALL_CHANNELS")
  expect "e2: at most 5 per source_type, best score first" "67 66 65 64 63" "$(column 8 "$first")"
  second=$(run_stmt sc_e2 "$CLAIM_TOP_SQL" "60, 5, $ALL_CHANNELS")
  expect "e2: the 2 leftovers go out in the next claim" "62 61" "$(column 8 "$second")"
  expect "e2: then nothing" "" "$(run_stmt sc_e2 "$CLAIM_TOP_SQL" "60, 5, $ALL_CHANNELS")"
}

# f. One story per title. Catches: no within-claim dedupe (both rows of a title are
#    returned); no cross-source rule (a later row whose title was already sent is
#    returned again).
check_one_story_per_title() {
  expect "f: fresh database" ok "$(new_db sc_f)"
  {
    prelude
    ingest 'https://f.example/1' 'Claude Ships Thing' news 0 90 90
    ingest 'https://f.example/2' 'CLAUDE SHIPS THING' reddit 0 90 85
  } | sql sc_f
  local first later
  first=$(run_stmt sc_f "$CLAIM_TOP_SQL" "60, 5, $ALL_CHANNELS")
  expect "f: same title in two sources, only the best row is returned" \
    "https://f.example/1" "$(column 2 "$first")"
  {
    prelude
    ingest 'https://f.example/3' 'claude ships thing' news 0 90 99
  } | sql sc_f
  later=$(run_stmt sc_f "$CLAIM_TOP_SQL" "60, 5, $ALL_CHANNELS")
  expect "f: a later row whose title was already sent is never returned" "" "$later"
}

# g. Concurrent claims. Session A claims two rows and keeps its transaction open; session
#    B claims meanwhile and must wait on A's row locks. Catches: no sent_at IS NULL
#    re-check in the claim's UPDATE (B, once unblocked, would return the rows A claimed).
check_concurrent_claims_do_not_overlap() {
  expect "g: fresh database" ok "$(new_db sc_race)"
  {
    prelude
    ingest 'https://g.example/1' 'Race one' news 0 90 80
    ingest 'https://g.example/2' 'Race two' news 0 90 79
  } | sql sc_race

  ( {
    printf 'BEGIN;\n'
    prep stmt "$CLAIM_TOP_SQL"
    printf 'EXECUTE stmt(60, 5, %s);\nSELECT pg_sleep(4);\nCOMMIT;\n' "$ALL_CHANNELS"
  } | docker exec -i "$CONT" psql -X -q -v ON_ERROR_STOP=1 -At -F '|' -U postgres -d sc_race \
    >"$WORK/a.out" 2>&1 ) &
  local a_pid=$! a_sleeping=no b_blocked=no b_pid
  wait_for sc_race "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = 'sc_race' AND query LIKE 'SELECT pg_sleep%')" && a_sleeping=yes
  expect "g: session A holds its claim open" yes "$a_sleeping"

  ( {
    prep stmt "$CLAIM_TOP_SQL"
    printf 'EXECUTE stmt(60, 5, %s);\n' "$ALL_CHANNELS"
  } | docker exec -i "$CONT" psql -X -q -v ON_ERROR_STOP=1 -At -F '|' -U postgres -d sc_race \
    >"$WORK/b.out" 2>&1 ) &
  b_pid=$!
  wait_for sc_race "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = 'sc_race' AND wait_event_type = 'Lock')" && b_blocked=yes
  expect "g: session B waits on session A's row locks" yes "$b_blocked"

  wait "$a_pid" || true
  wait "$b_pid" || true
  expect "g: session A claimed both rows" "2" "$(count_rows "$(cat "$WORK/a.out")")"
  expect "g: session B, once unblocked, returns none of A's rows" "" "$(cat "$WORK/b.out")"
}

check_legacy_upgrade
check_insert_skips_already_sent_title
check_claim_skips_channels_without_webhook
check_rerun_keeps_fresh_rows
check_insert_is_idempotent
check_attempt_cap
check_claim_threshold_cap_order
check_one_story_per_title
check_concurrent_claims_do_not_overlap

echo
if [ "$FAILS" -gt 0 ]; then
  echo "$FAILS check(s) FAILED"
  exit 1
fi
echo "All checks PASSED"
