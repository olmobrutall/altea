import "../../../entities/globals"; // Array.prototype.toMap
import { DiffTable, DiffColumn, DiffForeignKey, DiffForeignKeyColumn, DiffIndex, DiffIndexColumn } from "../diffModels";
import { view } from "../../table";
import { PgNamespace } from "./postgresCatalog";
import { generateSubscripts, PostgresFunctions } from "./postgresFunctions";

// Port of Signum's Engine/Sync/Postgres/PostgresCatalogSchema.GetDatabaseDescription, now
// faithful to Signum's single giant query: `from ns in PgNamespace where !ns.IsInternal()
// from t in ns.Tables() select new DiffTable { … }`. The whole DiffTable graph — DiffColumns
// (type via the pg_type nav, length via _pg_char_max_length, precision/scale from atttypmod,
// default via pg_get_expr over the pg_attrdef nav), DiffForeignKeys and DiffIndexes (their
// column lists built with generate_subscripts + array subscripting, exactly like Signum) — is
// constructed IN THE QUERY via `.create`. This exercises SelectMany, nested projections,
// correlated subqueries, CROSS JOIN LATERAL set-returning functions and typed-object
// construction. Divergences vs Signum: async terminals; 'public'→'' (in create); precision/
// scale computed with integer `/` and `%` (Postgres integer division) instead of `>> 16` /
// `& 65535` (altea's formatter has no bitwise operators — the results are identical);
// temporal/computed/stats/vector reads omitted.

// pg_type oid of `numeric` — precision/scale are packed into atttypmod only for this type.
const NUMERIC_OID = 1700;

export async function getDatabaseDescription(): Promise<Map<string, DiffTable>> {
    const tables = await view(PgNamespace)
        .filter(ns => !ns.isInternal())
        .flatMap(ns => ns.tables().map(t => ({ ns, t })))
        .map(x => DiffTable.create({
            schemaName: x.ns.nspname,
            tableName: x.t.relname,

            primaryKeyName: x.t.constraints()
                .filter(c => c.contype == "p")
                .map(c => c.conname)
                .firstOrNull().$v,

            columns: x.t.attributes()
                .filter(a => !a.attisdropped && a.attnum > 0)
                .map(a => DiffColumn.create({
                    name: a.attname,
                    typeName: a.type().$v.typname,
                    nullable: !a.attnotnull,
                    // char/varchar declared length (NULL → -1 in create); numeric packs
                    // precision/scale into atttypmod - 4 (high/low 16 bits).
                    length: PostgresFunctions._pg_char_max_length(a.atttypid, a.atttypmod),
                    precision: a.atttypid == NUMERIC_OID && a.atttypmod > 0 ? (a.atttypmod - 4) / 65536 : 0,
                    scale: a.atttypid == NUMERIC_OID && a.atttypmod > 0 ? (a.atttypmod - 4) % 65536 : 0,
                    identity: a.attidentity == "a", // GENERATED ALWAYS AS IDENTITY
                    // pg_get_expr decompiles the stored default; NULL (no default) → NULL.
                    // adrelid == attrelid, so we pass attrelid directly and read adbin via the nav.
                    defaultDefinition: PostgresFunctions.pg_get_expr(a.attrDef().$v!.adbin, a.attrelid),
                }))
                .toArray().$v,

            multiForeignKeys: x.t.constraints()
                .filter(c => c.contype == "f")
                .map(fk => DiffForeignKey.create({
                    schemaName: x.ns.nspname,
                    conname: fk.conname,
                    targetSchema: fk.targetTable().$v.namespace().$v.nspname,
                    targetName: fk.targetTable().$v.relname,
                    // generate_subscripts(conkey, 1) iterates the FK's columns (Signum); conkey[i]
                    // / confkey[i] give the parent/referenced attnums, resolved to names via the
                    // attribute tables.
                    columns: generateSubscripts(fk.conkey, 1).map(i => DiffForeignKeyColumn.create({
                        parent: x.t.attributes().single(c => c.attnum == fk.conkey[i]).$v.attname,
                        referenced: fk.targetTable().$v.attributes().single(c => c.attnum == fk.confkey[i]).$v.attname,
                    })).toArray().$v,
                }))
                .toArray().$v,

            indices: x.t.indices()
                .map(ix => DiffIndex.create({
                    indexName: ix.class().$v.relname,
                    isUnique: ix.indisunique,
                    isPrimary: ix.indisprimary,
                    filterDefinition: PostgresFunctions.pg_get_expr(ix.indpred, ix.indrelid),
                    // indkey is a 0-based int2vector; generate_subscripts yields 0..n-1, and a
                    // subscript >= indnkeyatts is an INCLUDE column (Signum).
                    columns: generateSubscripts(ix.indkey, 1).map(i => DiffIndexColumn.create({
                        index: i,
                        columnName: x.t.attributes().single(a => a.attnum == ix.indkey[i]).$v.attname,
                        included: i >= ix.indnkeyatts,
                    })).toArray().$v,
                }))
                .toArray().$v,
        }))
        .toArray();

    return tables.toMap(t => t.name.toString());
}
