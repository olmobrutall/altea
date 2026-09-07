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

// ---- LEGACY MODE: Signum's versioning() -----------------------------------------------------------
//
// The upstream temporal_tables `versioning()` (version 0.2.0), VERBATIM — the exact text Signum ships as
// `Signum/Engine/Sync/Postgres/versioning_function.sql` and installs as a before-tables UDF. Byte for
// byte, because a Signum sync compares the STORED function text against this one and would otherwise
// offer a CREATE OR REPLACE on every run.
//
// It is a different CONTRACT from altea's function above, not merely a different body: `TG_ARGV[2]` is
// the boolean "mitigate update conflicts" flag (always `true` from Signum) rather than the column list,
// and the function derives the common columns itself from pg_attribute. That has one real advantage —
// adding or dropping a column never invalidates the trigger — against one real cost: every archived row
// travels through `$1.col` string concatenation built from `quote_ident`, where altea passes the columns
// natively. Neither is wrong; this one is what a Signum database HAS, which is the point of legacyMode
// (see SchemaSettings.legacyMode).
export const VERSIONING_FUNCTION_LEGACY =
`CREATE OR REPLACE FUNCTION versioning()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  sys_period text;
  history_table text;
  manipulate jsonb;
  commonColumns text[];
  time_stamp_to_use timestamptz := current_timestamp;
  range_lower timestamptz;
  transaction_info txid_snapshot;
  existing_range tstzrange;
  holder record;
  holder2 record;
  pg_version integer;
BEGIN
  -- version 0.2.0

  IF TG_WHEN != 'BEFORE' OR TG_LEVEL != 'ROW' THEN
    RAISE TRIGGER_PROTOCOL_VIOLATED USING
    MESSAGE = 'function "versioning" must be fired BEFORE ROW';
  END IF;

  IF TG_OP != 'INSERT' AND TG_OP != 'UPDATE' AND TG_OP != 'DELETE' THEN
    RAISE TRIGGER_PROTOCOL_VIOLATED USING
    MESSAGE = 'function "versioning" must be fired for INSERT or UPDATE or DELETE';
  END IF;

  IF TG_NARGS != 3 THEN
    RAISE INVALID_PARAMETER_VALUE USING
    MESSAGE = 'wrong number of parameters for function "versioning"',
    HINT = 'expected 3 parameters but got ' || TG_NARGS;
  END IF;

  sys_period := TG_ARGV[0];
  history_table := TG_ARGV[1];

  -- check if sys_period exists on original table
  SELECT atttypid, attndims INTO holder FROM pg_attribute WHERE attrelid = TG_RELID AND attname = sys_period AND NOT attisdropped;
  IF NOT FOUND THEN
    RAISE 'column "%" of relation "%" does not exist', sys_period, TG_TABLE_NAME USING
    ERRCODE = 'undefined_column';
  END IF;
  IF holder.atttypid != to_regtype('tstzrange') THEN
    IF holder.attndims > 0 THEN
      RAISE 'system period column "%" of relation "%" is not a range but an array', sys_period, TG_TABLE_NAME USING
      ERRCODE = 'datatype_mismatch';
    END IF;

    SELECT rngsubtype INTO holder2 FROM pg_range WHERE rngtypid = holder.atttypid;
    IF FOUND THEN
      RAISE 'system period column "%" of relation "%" is not a range of timestamp with timezone but of type %', sys_period, TG_TABLE_NAME, format_type(holder2.rngsubtype, null) USING
      ERRCODE = 'datatype_mismatch';
    END IF;

    RAISE 'system period column "%" of relation "%" is not a range but type %', sys_period, TG_TABLE_NAME, format_type(holder.atttypid, null) USING
    ERRCODE = 'datatype_mismatch';
  END IF;

  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
    -- Ignore rows already modified in this transaction
    --transaction_info := txid_current_snapshot();
    --IF OLD.xmin::text >= (txid_snapshot_xmin(transaction_info) % (2^32)::bigint)::text
    --AND OLD.xmin::text <= (txid_snapshot_xmax(transaction_info) % (2^32)::bigint)::text THEN
    --  IF TG_OP = 'DELETE' THEN
    --    RETURN OLD;
    --  END IF;

    --  RETURN NEW;
    --END IF;

    SELECT current_setting('server_version_num')::integer
    INTO pg_version;

    -- to support postgres < 9.6
    IF pg_version < 90600 THEN
      -- check if history table exits
      IF to_regclass(history_table::cstring) IS NULL THEN
        RAISE 'relation "%" does not exist', history_table;
      END IF;
    ELSE
      IF to_regclass(history_table) IS NULL THEN
        RAISE 'relation "%" does not exist', history_table;
      END IF;
    END IF;

    -- check if history table has sys_period
    IF NOT EXISTS(SELECT * FROM pg_attribute WHERE attrelid = history_table::regclass AND attname = sys_period AND NOT attisdropped) THEN
      RAISE 'history relation "%" does not contain system period column "%"', history_table, sys_period USING
      HINT = 'history relation must contain system period column with the same name and data type as the versioned one';
    END IF;

    EXECUTE format('SELECT $1.%I', sys_period) USING OLD INTO existing_range;

    IF existing_range IS NULL THEN
      RAISE 'system period column "%" of relation "%" must not be null', sys_period, TG_TABLE_NAME USING
      ERRCODE = 'null_value_not_allowed';
    END IF;

    IF isempty(existing_range) THEN
      RAISE 'system period column "%" of relation "%" contains invalid value',
        sys_period, TG_TABLE_NAME
        USING
          ERRCODE = 'data_exception',
          DETAIL  = 'valid ranges must be non-empty. Found: ' || existing_range::text;
    END IF;

    IF NOT upper_inf(existing_range) THEN
      RAISE 'system period column "%" of relation "%" contains invalid value',
        sys_period, TG_TABLE_NAME
        USING
          ERRCODE = 'data_exception',
          DETAIL  = 'valid ranges must be unbounded on the high side. Found: ' || existing_range::text;
    END IF;

    IF TG_ARGV[2] = 'true' THEN
      -- mitigate update conflicts
      range_lower := lower(existing_range);
      IF range_lower >= time_stamp_to_use THEN
        time_stamp_to_use := range_lower + interval '1 microseconds';
      END IF;
    END IF;

    WITH history AS
      (SELECT attname, atttypid
      FROM   pg_attribute
      WHERE  attrelid = history_table::regclass
      AND    attnum > 0
      AND    NOT attisdropped),
      main AS
      (SELECT attname, atttypid
      FROM   pg_attribute
      WHERE  attrelid = TG_RELID
      AND    attnum > 0
      AND    NOT attisdropped)
    SELECT
      history.attname AS history_name,
      main.attname AS main_name,
      history.atttypid AS history_type,
      main.atttypid AS main_type
    INTO holder
      FROM history
      INNER JOIN main
      ON history.attname = main.attname
    WHERE
      history.atttypid != main.atttypid;

    IF FOUND THEN
      RAISE 'column "%" of relation "%" is of type % but column "%" of history relation "%" is of type %',
        holder.main_name, TG_TABLE_NAME, format_type(holder.main_type, null), holder.history_name, history_table, format_type(holder.history_type, null)
      USING ERRCODE = 'datatype_mismatch';
    END IF;

    WITH history AS
      (SELECT attname
      FROM   pg_attribute
      WHERE  attrelid = history_table::regclass
      AND    attnum > 0
      AND    NOT attisdropped),
      main AS
      (SELECT attname
      FROM   pg_attribute
      WHERE  attrelid = TG_RELID
      AND    attnum > 0
      AND    NOT attisdropped)
    SELECT array_agg(quote_ident(history.attname)) INTO commonColumns
      FROM history
      INNER JOIN main
      ON history.attname = main.attname
      AND history.attname != sys_period;

    EXECUTE ('INSERT INTO ' || history_table || '(' ||
      array_to_string(commonColumns , ',') ||
      ',' ||
      quote_ident(sys_period) ||
      ') VALUES ($1.' ||
      array_to_string(commonColumns, ',$1.') ||
      ',tstzrange($2, $3, ''[)''))')
       USING OLD, range_lower, time_stamp_to_use;
  END IF;

  IF TG_OP = 'UPDATE' OR TG_OP = 'INSERT' THEN
    manipulate := jsonb_set('{}'::jsonb, ('{' || sys_period || '}')::text[], to_jsonb(tstzrange(time_stamp_to_use, null, '[)')));

    RETURN jsonb_populate_record(NEW, manipulate);
  END IF;

  RETURN OLD;
END;
$function$`;
