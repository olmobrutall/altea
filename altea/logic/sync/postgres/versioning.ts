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
