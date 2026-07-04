import "../../../entities/globals"; // Array.prototype.toMap
import { Connector } from "../../connection/connector";
import { DiffTable, DiffColumn, DiffForeignKey, DiffForeignKeyColumn, DiffIndex, DiffIndexColumn } from "../diffModels";
import { view } from "../../table";
import { PgNamespace, PgType } from "./postgresCatalog";

// Port of Signum's Engine/Sync/Postgres/PostgresCatalogSchema.GetDatabaseDescription, scoped
// to the lean synchronizer (tables / columns / foreign keys). Faithful to Signum's
// `from ns in PgNamespace where !ns.IsInternal() from t in ns.Tables() select new DiffTable`
// giant query; the DiffTable graph is assembled from the rows in a thin post-step (Signum's
// ToDictionaryEx analogue). Divergences vs Signum: async terminals; pg type name resolved via
// a fetched pg_type map (instead of a per-column correlated subquery); column defaults read
// via a raw `pg_get_expr` side-query (pg_get_expr isn't modelled as a LINQ function yet);
// FK columns resolved from the conkey/confkey arrays in TS rather than in-SQL
// generate_subscripts; default schema 'public' normalised to '' (altea's default SchemaName).

const NUMERIC_TYPE = "numeric";

export async function getDatabaseDescription(): Promise<Map<string, DiffTable>> {
    const connector = Connector.current();

    // pg_type oid -> type name, and (adrelid, adnum) -> default expression (pg_get_expr).
    const types = await view(PgType).map(t => ({ oid: t.oid, typname: t.typname })).toArray() as { oid: number; typname: string }[];
    const typeNameByOid = types.toMap(t => t.oid, t => t.typname);
    const defaultByCol = await getColumnDefaults();
    // Filtered-index predicates keyed by the index's pg_class oid (indexrelid). pg_get_expr
    // decompiles the stored pg_node_tree predicate — done via raw SQL, like column defaults.
    const predByIndex = await getIndexPredicates();

    // Faithful giant query: namespaces (non-internal) → their tables → columns + FKs.
    const rows = await view(PgNamespace)
        .filter(ns => !ns.isInternal())
        .flatMap(ns => ns.tables().map(t => ({ ns, t })))
        .map(x => ({
            oid: x.t.oid,
            schemaName: x.ns.nspname,
            tableName: x.t.relname,

            primaryKeyName: x.t.constraints()
                .filter(c => c.contype == "p")
                .map(c => c.conname)
                .firstOrNull().$v,

            columns: x.t.attributes()
                .filter(a => !a.attisdropped && a.attnum > 0)
                .map(a => ({
                    attname: a.attname, attnum: a.attnum, atttypid: a.atttypid, atttypmod: a.atttypmod,
                    attnotnull: a.attnotnull, attidentity: a.attidentity,
                }))
                .toArray().$v,

            foreignKeys: x.t.constraints()
                .filter(c => c.contype == "f")
                .map(fk => ({ conname: fk.conname, conkey: fk.conkey, confkey: fk.confkey, confrelid: fk.confrelid }))
                .toArray().$v,

            // Indexes: the flags + the index name (from the index's own pg_class row) + the raw
            // indkey attnum vector. Column names are resolved from indkey in TS (pg's array
            // indexing / generate_subscripts aren't modelled in the LINQ provider), mirroring
            // how FK columns are resolved from conkey/confkey below.
            indices: x.t.indices()
                .map(ix => ({
                    indexName: ix.class().$v.relname,
                    indexrelid: ix.indexrelid,
                    indisunique: ix.indisunique,
                    indisprimary: ix.indisprimary,
                    indnkeyatts: ix.indnkeyatts,
                    indkey: ix.indkey,
                }))
                .toArray().$v,
        }))
        .toArray() as RawTableRow[];

    // (attrelid, attnum) -> column name, across all tables (for FK column resolution), and
    // oid -> table (for FK target resolution).
    const tableByOid = rows.toMap(r => r.oid);
    const attNameByKey = rows.flatMap(r => r.columns.map(c => ({ key: `${r.oid}:${c.attnum}`, name: c.attname })))
        .toMap(x => x.key, x => x.name);

    const tables = rows.map(r => DiffTable.create({
        schemaName: r.schemaName,
        tableName: r.tableName,
        primaryKeyName: r.primaryKeyName,
        columns: r.columns.map(c => buildColumn(c, typeNameByOid, defaultByCol.get(`${r.oid}:${c.attnum}`))),
        multiForeignKeys: r.foreignKeys.map(fk => {
            const target = tableByOid.get(fk.confrelid);
            return DiffForeignKey.create({
                schemaName: r.schemaName,
                conname: fk.conname,
                targetSchema: target?.schemaName ?? r.schemaName,
                targetName: target?.tableName ?? String(fk.confrelid),
                columns: fk.conkey.map((parentAttnum, i) => DiffForeignKeyColumn.create({
                    parent: attNameByKey.get(`${r.oid}:${parentAttnum}`)!,
                    referenced: attNameByKey.get(`${fk.confrelid}:${fk.confkey[i]}`)!,
                })),
            });
        }),
        indices: r.indices.map(ix => DiffIndex.create({
            indexName: ix.indexName,
            isUnique: ix.indisunique,
            isPrimary: ix.indisprimary,
            filterDefinition: predByIndex.get(ix.indexrelid) ?? null,
            // indkey positions >= indnkeyatts are INCLUDE columns. Attnum 0 marks an expression
            // column (not modelled) — drop it.
            columns: toIntArray(ix.indkey)
                .map((attnum, i) => ({ attnum, i }))
                .filter(x => x.attnum > 0)
                .map(x => DiffIndexColumn.create({
                    index: x.i,
                    columnName: attNameByKey.get(`${r.oid}:${x.attnum}`)!,
                    included: x.i >= ix.indnkeyatts,
                })),
        })),
    }));

    return tables.toMap(t => t.name.toString());
}

// ---- shapes the giant query materialises ------------------------------------

interface RawColumnRow {
    attname: string; attnum: number; atttypid: number; atttypmod: number;
    attnotnull: boolean; attidentity: string;
}
interface RawFkRow { conname: string; conkey: number[]; confkey: number[]; confrelid: number; }
interface RawIndexRow {
    indexName: string; indexrelid: number; indisunique: boolean; indisprimary: boolean;
    indnkeyatts: number; indkey: unknown;
}
interface RawTableRow {
    oid: number; schemaName: string; tableName: string; primaryKeyName: string | null;
    columns: RawColumnRow[]; foreignKeys: RawFkRow[]; indices: RawIndexRow[];
}

// pg's int2vector (indkey) may reach the driver as a JS array or as a space-separated string
// ("1 2 3") since node-postgres has no parser for the int2vector type; normalise to numbers.
function toIntArray(v: unknown): number[] {
    if (Array.isArray(v))
        return v.map(Number);
    if (typeof v === "string")
        return v.trim() === "" ? [] : v.trim().split(/\s+/).map(Number);
    return [];
}

// ---- helpers ----------------------------------------------------------------

function buildColumn(c: RawColumnRow, typeNameByOid: Map<number, string>, defaultDefinition: string | undefined): DiffColumn {
    const typname = typeNameByOid.get(c.atttypid) ?? "unknown";
    const isNumeric = typname === NUMERIC_TYPE && c.atttypmod > 0;
    return DiffColumn.create({
        name: c.attname,
        typeName: typname,
        nullable: !c.attnotnull,
        // varchar/bpchar length is atttypmod - 4 (VARHDRSZ); -1 when unbounded / non-string.
        length: (typname === "varchar" || typname === "bpchar") && c.atttypmod > 0 ? c.atttypmod - 4 : -1,
        // numeric(p,s): precision/scale packed into atttypmod - 4.
        precision: isNumeric ? ((c.atttypmod - 4) >> 16) & 65535 : 0,
        scale: isNumeric ? (c.atttypmod - 4) & 65535 : 0,
        identity: c.attidentity === "a", // GENERATED ALWAYS AS IDENTITY
        defaultDefinition: defaultDefinition ?? null,
    });
}

// Column defaults keyed "<adrelid>:<adnum>". pg_get_expr decompiles the stored default into
// its SQL text; done via raw SQL because pg_get_expr isn't modelled as a LINQ function.
async function getColumnDefaults(): Promise<Map<string, string>> {
    const rows = await Connector.current().executeQuery(
        "SELECT adrelid, adnum, pg_get_expr(adbin, adrelid) AS def FROM pg_catalog.pg_attrdef") as { adrelid: number; adnum: number; def: string }[];
    return rows.toMap(r => `${r.adrelid}:${r.adnum}`, r => r.def);
}

// Filtered-index predicates keyed by indexrelid. pg_get_expr decompiles indpred (a
// pg_node_tree) into SQL text; done via raw SQL since pg_get_expr isn't a modelled LINQ function.
async function getIndexPredicates(): Promise<Map<number, string>> {
    const rows = await Connector.current().executeQuery(
        "SELECT indexrelid, pg_get_expr(indpred, indrelid) AS def FROM pg_catalog.pg_index WHERE indpred IS NOT NULL") as { indexrelid: number; def: string }[];
    return rows.toMap(r => r.indexrelid, r => r.def);
}
