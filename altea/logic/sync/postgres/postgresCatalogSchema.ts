import "../../../entities/globals"; // Array.prototype.toMap
import { Connector } from "../../connection/connector";
import { DiffTable, DiffColumn, DiffForeignKey, DiffForeignKeyColumn } from "../diffModels";
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
    }));

    return tables.toMap(t => t.name.toString());
}

// ---- shapes the giant query materialises ------------------------------------

interface RawColumnRow {
    attname: string; attnum: number; atttypid: number; atttypmod: number;
    attnotnull: boolean; attidentity: string;
}
interface RawFkRow { conname: string; conkey: number[]; confkey: number[]; confrelid: number; }
interface RawTableRow {
    oid: number; schemaName: string; tableName: string; primaryKeyName: string | null;
    columns: RawColumnRow[]; foreignKeys: RawFkRow[];
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
