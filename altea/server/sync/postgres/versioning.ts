// altea's own Postgres system-versioning trigger machinery (Option C — no third-party
// dependency). ONE generic `versioning()` plpgsql function, shared by every versioned
// table, installed once as a before-tables UDF (SchemaAssets) when a Postgres schema has
// any system-versioned table. Each versioned table gets a per-table trigger that passes
// the sys_period column, the history table, and the row's column list as arguments.
//
// The row copy is NATIVE (`$1."col" USING OLD`) so it is fully type-safe for any column
// type — vector / tsvector / ltree / arrays / composites all copy in their binary form,
// never through jsonb. jsonb touches ONLY the single sys_period range field (which round-
// trips reliably). A column add/drop re-emits just the per-table trigger; the function is
// column-agnostic and never changes.

// The generic function body. `TG_ARGV`: [0] = sys_period column, [1] = history table
// (qualified+quoted), [2] = comma-separated quoted column list (excluding sys_period).
export const VERSIONING_FUNCTION =
`CREATE OR REPLACE FUNCTION versioning() RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  sys_period    text := TG_ARGV[0];
  history_table text := TG_ARGV[1];
  cols          text := TG_ARGV[2];
  now_ts   timestamptz := current_timestamp;
  lower_ts timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
    EXECUTE format('SELECT lower(($1).%I)', sys_period) USING OLD INTO lower_ts;
    -- Mitigate same-transaction changes (temporal_tables' behaviour): when a row is inserted
    -- and updated within one transaction, current_timestamp is unchanged, so [lower_ts, now_ts)
    -- would be an EMPTY range (its lower/upper both read back NULL — an unbounded period that
    -- matches every AsOf). Nudge the end forward so the archived period is non-empty. (SQL Server
    -- simply drops such zero-width history rows; this keeps Postgres history clean too.)
    IF lower_ts IS NOT NULL AND lower_ts >= now_ts THEN
      now_ts := lower_ts + interval '1 microsecond';
    END IF;
    EXECUTE format(
      'INSERT INTO %s (%s, %I) VALUES (%s, tstzrange($2, $3, ''[)''))',
      history_table, cols, sys_period, '$1.' || replace(cols, ',', ',$1.')
    ) USING OLD, lower_ts, now_ts;
  END IF;
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    RETURN jsonb_populate_record(NEW, jsonb_build_object(sys_period, tstzrange(now_ts, NULL, '[)')));
  END IF;
  RETURN OLD;
END;
$function$`;
