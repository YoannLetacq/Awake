#!/usr/bin/env bash
# SQL contract checks for the n8n scoring and posting pipeline, run against a
# throwaway Postgres 16 container.
#
# Each check drives the real files: scripts/init.sql (schema and migration) and
# n8n/sql/*.sql (the statements). The n8n Postgres node (pg-promise) inlines its
# positional values into the query text client side, before sending it; this script
# PREPAREs and EXECUTEs each statement file instead, an equivalent server-side binding
# of the same positional parameters.
# Every check prints PASS or FAIL; the script exits 1 if any check fails. An SQL error that no
# check expects is a FAIL too (see sql).
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
: >"$WORK/unexpected"
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
# A SQL error prints "SQL_ERROR: ..." instead, so the check fails with the message. The error
# is also a FAIL, unless the call says it expects one: EXPECT_SQL_ERROR=1 q DB SQL.
# sql runs inside $(...) subshells, where FAILS would be lost: the FAIL is logged to a file
# and counted at the end of the script.
sql() {
  if docker exec -i "$CONT" psql -X -q -v ON_ERROR_STOP=1 -At -F '|' -U postgres -d "$1" \
    >"$WORK/out" 2>"$WORK/err"; then
    cat "$WORK/out"
  else
    local msg
    msg="SQL_ERROR: $(sed '/^NOTICE:/d' "$WORK/err" | tr '\n' ' ')"
    echo "$msg"
    if [ -z "${EXPECT_SQL_ERROR:-}" ]; then
      echo "FAIL unexpected $msg" >&2
      echo "$msg" >>"$WORK/unexpected"
    fi
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
#    scorable); no DROP FUNCTION (the dead dedup functions survive on a live DB);
#    check_url_duplicates_json still created or kept.
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
CREATE FUNCTION check_url_duplicates_json(urls_json JSONB) RETURNS TABLE(
    url TEXT, is_new BOOLEAN, existing_id INTEGER,
    existing_created_at TIMESTAMP WITH TIME ZONE, existing_sent_at TIMESTAMP WITH TIME ZONE)
    LANGUAGE sql AS 'SELECT NULL::TEXT, NULL::BOOLEAN, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ WHERE false';
SQL
  expect "a: init.sql applies to a live pre-migration table" ok "$(init sc_legacy)"
  expect "a: legacy row is marked sent and out of the scoring budget" "t|3" \
    "$(q sc_legacy "SELECT sent_at IS NOT NULL, score_attempts FROM rss_articles WHERE url = 'https://legacy.example/a';")"
  expect "a: claim-unscored never returns a legacy row" "" \
    "$(run_stmt sc_legacy "$CLAIM_UNSCORED_SQL" 10)"
  expect "a: dead dedup functions dropped, kept ones remain" "0|2" \
    "$(q sc_legacy "SELECT (SELECT count(*) FROM pg_proc WHERE proname IN ('filter_new_urls', 'check_url_duplicates', 'process_rss_batch', 'check_url_duplicates_json')), (SELECT count(*) FROM pg_proc WHERE proname IN ('purge_old_articles', 'get_source_stats'));")"
}

# b. Re-running init.sql after the migration. Catches: an unguarded backfill (every
#    re-run would mark fresh candidates as sent and exhausted); the scoring lease column
#    added inside the score_attempts guard (a database migrated before the lease existed
#    would never get it).
check_rerun_keeps_fresh_rows() {
  q sc_legacy "INSERT INTO rss_articles (url, title, source, source_type, published_at)
VALUES ('https://fresh.example/b', 'Fresh story', 'Fresh', 'news', now() - interval '1 hour');"
  q sc_legacy "ALTER TABLE rss_articles DROP COLUMN IF EXISTS scoring_started_at;"
  expect "b: init.sql re-runs cleanly" ok "$(init sc_legacy)"
  expect "b: fresh candidate stays unscored" "t|0" \
    "$(q sc_legacy "SELECT sent_at IS NULL, score_attempts FROM rss_articles WHERE url = 'https://fresh.example/b';")"
  expect "b: a database migrated before the lease gets scoring_started_at" "1" \
    "$(q sc_legacy "SELECT count(*) FROM information_schema.columns WHERE table_name = 'rss_articles' AND column_name = 'scoring_started_at';")"
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

# i2. The CASE keeps 'Reddit Communities' as its own channel. Catches: 'Reddit Communities'
#     dropped from the IN (...) list (the row then counts as 'Other' and follows its webhook).
check_claim_reddit_is_its_own_channel() {
  expect "i2: fresh database" ok "$(new_db sc_i2)"
  {
    prelude
    ingest 'https://i2.example/r' 'Story R' 'Reddit Communities' 0 90 70
  } | sql sc_i2
  expect "i2: not claimed for the Other channel" "0" \
    "$(count_rows "$(run_stmt sc_i2 "$CLAIM_TOP_SQL" "60, 5, ARRAY['Other']")")"
  expect "i2: claimed for the Reddit Communities channel" "Story R" \
    "$(column 3 "$(run_stmt sc_i2 "$CLAIM_TOP_SQL" "60, 5, ARRAY['Reddit Communities']")")"
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
    # Each run dies before Save Scores: its lease expires (check k).
    q sc_attempts "UPDATE rss_articles SET scoring_started_at = now() - interval '16 minutes';" >/dev/null
  done
  expect "d: claimed for scoring 3 times, then never again" "1 1 1 0" "${counts[*]}"
}

# e. Claim for posting: score and confidence thresholds, per-channel cap, ordering.
check_claim_threshold_cap_order() {
  # e1: the 7 scored rows of the brief (5 valid, 2 decoys). Catches: no confidence filter
  # (decoy confidence 80 returned, score 90 leaks into the output); a claim that returns
  # already sent rows again. The 5-row cap hides the score-50 decoy from the first claim:
  # the score threshold itself is pinned by check n5.
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
#    returned); no sent-title rule in insert-candidates (a row whose title was already sent
#    is inserted again); no sent-title rule in claim-top-articles (a row whose title was
#    already sent is claimed, when a plain INSERT put it in the table).
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

  # insert-candidates skips a title that was already sent (row 1): 0 new rows.
  run_stmt sc_f "$INSERT_SQL" "'https://f.example/3', 'claude ships thing', 'desc', 'Src', 'news', 0, now()" >/dev/null
  expect "f: insert-candidates adds 0 rows for a title already sent" "2" \
    "$(q sc_f "SELECT count(*) FROM rss_articles;")"
  expect "f: the skipped url is not in the table" "0" \
    "$(q sc_f "SELECT count(*) FROM rss_articles WHERE url = 'https://f.example/3';")"

  # claim-top-articles never returns a row whose title was already sent. The row comes from a
  # plain INSERT (bypassing insert-candidates) and is eligible in every other respect: unsent,
  # score 99, confidence 90, published now, channel Other. Only the title rule excludes it.
  q sc_f "INSERT INTO rss_articles (url, title, source, source_type, published_at, gemini_score, gemini_confidence)
VALUES ('https://f.example/4', 'CLAUDE SHIPS THING', 'Src', 'news', now(), 99, 90);" >/dev/null
  later=$(run_stmt sc_f "$CLAIM_TOP_SQL" "60, 5, $ALL_CHANNELS")
  expect "f: a row whose title was already sent is never claimed" "" "$later"
  expect "f: and it stays unsent" "t" \
    "$(q sc_f "SELECT sent_at IS NULL FROM rss_articles WHERE url = 'https://f.example/4';")"
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

# j. Claim-unscored selection. Catches: no gemini_confidence IS NULL filter (a scored row
#    is sent to Gemini again: double spend); no 48 h created_at window, or a narrower one;
#    no LIMIT (one paid call carries every candidate); oldest-first order (the freshest
#    items age out of the window while the backlog drains); NULL published_at first.
check_claim_unscored_selection() {
  expect "j1: fresh database" ok "$(new_db sc_j1)"
  {
    prelude
    ingest 'https://j.example/s' 'Scored' news 0 90 70
  } | sql sc_j1 >/dev/null
  q sc_j1 "INSERT INTO rss_articles (url, title, source, source_type, published_at, created_at) VALUES
('https://j.example/old', 'Old 49h', 'Src', 'news', now(), now() - interval '49 hours'),
('https://j.example/new', 'Fresh 47h', 'Src', 'news', now(), now() - interval '47 hours');" >/dev/null
  expect "j1: a scored row and a 49 h-old row are never claimed, a 47 h-old one is" "Fresh 47h" \
    "$(column 2 "$(run_stmt sc_j1 "$CLAIM_UNSCORED_SQL" 10)")"

  # 30 eligible rows: 'No date' (published_at NULL, lowest id), then Batch 1..29, Batch 29
  # the freshest. A batch of 25 takes Batch 5..29; the 5 left are 'No date' and Batch 1..4.
  expect "j2: fresh database" ok "$(new_db sc_j2)"
  q sc_j2 "INSERT INTO rss_articles (url, title, source, source_type, published_at)
VALUES ('https://j.example/nodate', 'No date', 'Src', 'news', NULL);
INSERT INTO rss_articles (url, title, source, source_type, published_at)
SELECT 'https://j.example/' || g, 'Batch ' || g, 'Src', 'news', now() - (30 - g) * interval '1 minute'
FROM generate_series(1, 29) g;" >/dev/null
  expect "j2: 30 eligible rows, a batch of 25 claims exactly 25" "25" \
    "$(count_rows "$(run_stmt sc_j2 "$CLAIM_UNSCORED_SQL" 25)")"
  expect "j2: the freshest are claimed first, undated rows last" "No date,Batch 1,Batch 2,Batch 3,Batch 4" \
    "$(q sc_j2 "SELECT string_agg(title, ',' ORDER BY id) FROM rss_articles WHERE score_attempts = 0;")"
}

# k. Claim-unscored lease. Catches: no lease (a run that starts before the previous one
#    saved its scores claims the same rows again: paid twice, two attempts spent at once);
#    a lease that never expires (a run that died holds its rows forever); a lease shorter
#    or longer than 15 minutes.
check_claim_unscored_lease() {
  expect "k: fresh database" ok "$(new_db sc_k)"
  q sc_k "INSERT INTO rss_articles (url, title, source, source_type, published_at) VALUES
('https://k.example/1', 'Lease one', 'Src', 'news', now()),
('https://k.example/2', 'Lease two', 'Src', 'news', now());" >/dev/null
  expect "k: the first claim takes both rows" "2" "$(count_rows "$(run_stmt sc_k "$CLAIM_UNSCORED_SQL" 10)")"
  expect "k: a second claim before Save Scores returns 0 rows" "0" \
    "$(count_rows "$(run_stmt sc_k "$CLAIM_UNSCORED_SQL" 10)")"
  q sc_k "UPDATE rss_articles SET scoring_started_at = now() - interval '14 minutes';" >/dev/null
  expect "k: a lease 14 minutes old still holds" "0" "$(count_rows "$(run_stmt sc_k "$CLAIM_UNSCORED_SQL" 10)")"
  q sc_k "UPDATE rss_articles SET scoring_started_at = now() - interval '16 minutes';" >/dev/null
  expect "k: a lease older than 15 minutes is re-claimable" "2" \
    "$(count_rows "$(run_stmt sc_k "$CLAIM_UNSCORED_SQL" 10)")"
}

# l. Re-ingesting a url that was scored and sent. Catches: ON CONFLICT DO UPDATE that
#    resets sent_at, the gemini_* fields or score_attempts (re-scored and re-posted on
#    every fetch). The new title differs, so the sent-title rule does not hide the conflict.
check_reinsert_keeps_scoring_and_sent_state() {
  expect "l: fresh database" ok "$(new_db sc_l)"
  {
    prelude
    prep cu "$CLAIM_UNSCORED_SQL"
    prep ct "$CLAIM_TOP_SQL"
    printf "EXECUTE ins('https://l.example/a', 'Story L', 'desc', 'Src', 'Tech News', 0, now() - interval '1 hour');\n"
    printf 'EXECUTE cu(10);\n'
    printf '%s\n' "SELECT id AS scored_id FROM rss_articles WHERE url = 'https://l.example/a' \gset"
    printf "EXECUTE sc(:scored_id, 90, 80, 'LLM', 'tag', 'sum', 'take');\n"
    printf 'EXECUTE ct(60, 5, %s);\n' "$ALL_CHANNELS"
  } | sql sc_l >/dev/null
  local state="SELECT sent_at, gemini_confidence, gemini_score, category, ai_tag, ai_summary, ai_takeaway, score_attempts, title FROM rss_articles WHERE url = 'https://l.example/a';"
  local before
  before=$(q sc_l "$state")
  expect "l: the row is scored, sent and has spent 1 attempt" "t|90|80|1" \
    "$(q sc_l "SELECT sent_at IS NOT NULL, gemini_confidence, gemini_score, score_attempts FROM rss_articles WHERE url = 'https://l.example/a';")"
  run_stmt sc_l "$INSERT_SQL" "'https://l.example/a', 'Story L retitled', 'desc 2', 'Src 2', 'Company Blogs', 3, now()" >/dev/null
  expect "l: re-inserting its url leaves sent_at, gemini_* and score_attempts unchanged" "$before" "$(q sc_l "$state")"
}

# m. Positional round trip. Every value is distinct, and every column is read back.
#    Catches: any two $n swapped in insert-candidates or save-scores (title/description,
#    source/source_type, confidence/score, summary/takeaway...).
check_positional_round_trip() {
  expect "m: fresh database" ok "$(new_db sc_m)"
  {
    prelude
    printf "EXECUTE ins('https://m.example/u', 'M title', 'M description', 'M source', 'M source_type', 7, '2026-01-02 03:04:05+00');\n"
    printf '%s\n' "SELECT id AS mid FROM rss_articles WHERE url = 'https://m.example/u' \gset"
    printf "EXECUTE sc(:mid, 91, 72, 'M category', 'M tag', 'M summary', 'M takeaway');\n"
  } | sql sc_m >/dev/null
  expect "m: every insert-candidates and save-scores value lands in its own column" \
    "https://m.example/u|M title|M description|M source|M source_type|7|2026-01-02 03:04:05|91|72|M category|M tag|M summary|M takeaway" \
    "$(q sc_m "SELECT url, title, description, source, source_type, prio, published_at AT TIME ZONE 'UTC', gemini_confidence, gemini_score, category, ai_tag, ai_summary, ai_takeaway FROM rss_articles;")"
}

# n. Claim for posting: window, per-channel cap, prio, thresholds.
check_claim_top_selection() {
  # n1. Catches: no 48 h published_at window, or a narrower one.
  expect "n1: fresh database" ok "$(new_db sc_n1)"
  {
    prelude
    ingest 'https://n.example/old' 'Old 49h' 'Tech News' 0 90 99
    ingest 'https://n.example/new' 'Recent 47h' 'Tech News' 0 90 70
  } | sql sc_n1 >/dev/null
  q sc_n1 "UPDATE rss_articles SET published_at = now() - interval '49 hours' WHERE url = 'https://n.example/old';
UPDATE rss_articles SET published_at = now() - interval '47 hours' WHERE url = 'https://n.example/new';" >/dev/null
  expect "n1: a row published 49 h ago is never claimed, 47 h ago is" "Recent 47h" \
    "$(column 3 "$(run_stmt sc_n1 "$CLAIM_TOP_SQL" "60, 5, $ALL_CHANNELS")")"

  # n2. 6 Tech News rows and 2 Company Blogs rows, cap 5. Catches: one global cap (5 rows
  # in all, the Company Blogs rows held back).
  expect "n2: fresh database" ok "$(new_db sc_n2)"
  {
    prelude
    for s in 80 79 78 77 76 75; do ingest "https://n.example/t$s" "Tech $s" 'Tech News' 0 90 "$s"; done
    ingest 'https://n.example/c70' 'Blog 70' 'Company Blogs' 0 90 70
    ingest 'https://n.example/c69' 'Blog 69' 'Company Blogs' 0 90 69
  } | sql sc_n2 >/dev/null
  run_stmt sc_n2 "$CLAIM_TOP_SQL" "60, 5, $ALL_CHANNELS" >/dev/null
  expect "n2: the cap is counted per source_type" "Company Blogs:2,Tech News:5" \
    "$(q sc_n2 "SELECT string_agg(source_type || ':' || n, ',' ORDER BY source_type) FROM (SELECT source_type, count(*) AS n FROM rss_articles WHERE sent_at IS NOT NULL GROUP BY source_type) t;")"

  # n3. Equal score, prio 10 ingested before prio 0 (so published_at alone favours prio 0).
  # Catches: prio ignored in the per-channel ranking.
  expect "n3: fresh database" ok "$(new_db sc_n3)"
  {
    prelude
    ingest 'https://n.example/p10' 'Prio ten' 'Tech News' 10 90 70
    ingest 'https://n.example/p0' 'Prio zero' 'Tech News' 0 90 70
  } | sql sc_n3 >/dev/null
  expect "n3: prio breaks a score tie in the cap" "Prio ten" \
    "$(column 3 "$(run_stmt sc_n3 "$CLAIM_TOP_SQL" "60, 1, $ALL_CHANNELS")")"

  # n4. Catches: prio ignored in the output order (70 + 10 must come before 75 + 0).
  expect "n4: fresh database" ok "$(new_db sc_n4)"
  {
    prelude
    ingest 'https://n.example/p10' 'Prio ten' 'Tech News' 10 90 70
    ingest 'https://n.example/p75' 'Plain 75' 'Tech News' 0 90 75
    ingest 'https://n.example/p0' 'Prio zero' 'Tech News' 0 90 70
  } | sql sc_n4 >/dev/null
  expect "n4: output is ordered by gemini_score + prio" \
    "https://n.example/p10 https://n.example/p75 https://n.example/p0" \
    "$(column 2 "$(run_stmt sc_n4 "$CLAIM_TOP_SQL" "60, 5, $ALL_CHANNELS")")"

  # n5. Fewer valid rows than the cap, so a decoy would show. Catches: score threshold
  # ignored, or > instead of >= (60 dropped); confidence floor not 85 inclusive.
  expect "n5: fresh database" ok "$(new_db sc_n5)"
  {
    prelude
    ingest 'https://n.example/v70' 'Valid 70' 'Tech News' 0 90 70
    ingest 'https://n.example/a60' 'At 60' 'Tech News' 0 90 60
    ingest 'https://n.example/b59' 'Below 59' 'Tech News' 0 90 59
    ingest 'https://n.example/d50' 'Decoy 50' 'Tech News' 0 90 50
    ingest 'https://n.example/c85' 'Conf 85' 'Tech News' 0 85 65
    ingest 'https://n.example/c84' 'Conf 84' 'Tech News' 0 84 99
  } | sql sc_n5 >/dev/null
  expect "n5: only score >= 60 and confidence >= 85 are claimed" "70 65 60" \
    "$(column 8 "$(run_stmt sc_n5 "$CLAIM_TOP_SQL" "60, 5, $ALL_CHANNELS")")"
}

check_legacy_upgrade
check_insert_skips_already_sent_title
check_claim_skips_channels_without_webhook
check_claim_reddit_is_its_own_channel
check_rerun_keeps_fresh_rows
check_insert_is_idempotent
check_attempt_cap
check_claim_threshold_cap_order
check_one_story_per_title
check_concurrent_claims_do_not_overlap
check_claim_unscored_selection
check_claim_unscored_lease
check_reinsert_keeps_scoring_and_sent_state
check_positional_round_trip
check_claim_top_selection

# Each unexpected SQL error that sql() logged is a FAIL.
FAILS=$((FAILS + $(wc -l <"$WORK/unexpected")))

echo
if [ "$FAILS" -gt 0 ]; then
  echo "$FAILS check(s) FAILED"
  exit 1
fi
echo "All checks PASSED"
