import "../../../entities/globals"; // Array.prototype.toMap
import { Connector } from "../../connection/connector";
import { DiffTable, DiffColumn, DiffForeignKey, DiffForeignKeyColumn, DiffIndex, DiffIndexColumn } from "../diffModels";
import { view } from "../../table";
import {
    SysSchemas, SysTables, SysTypes, SysDefaultConstraints,
} from "./sysTables";

// Port of Signum's Engine/Sync/SqlServer/SysTablesSchema.GetDatabaseDescription, scoped to
// the lean synchronizer (tables / columns / foreign keys). Faithful to Signum's single
// `from s in SysSchemas from t in s.Tables() select new DiffTable { … }` — the DiffTable,
// its DiffColumns (LEFT JOIN sys.types twice + sys.default_constraints) and its
// DiffForeignKeys (with a nested column sub-projection resolving names via correlated
// singles) are all built IN THE QUERY via `create`. Running it exercises the LINQ provider's
// SelectMany + nested projections + joins + correlated subqueries + typed-object construction.
//
// Divergences: async terminals; the byte→char length halving (fixSqlColumnLengthSqlServer)
// and default-schema 'dbo'→'' normalisation happen client-side (the latter inside create);
// temporal/index/stats/check/computed reads omitted.

export async function getDatabaseDescription(): Promise<Map<string, DiffTable>> {
    const dbCollation = await getDatabaseCollation();

    const tables = await view(SysSchemas)
        .flatMap(s => s.tables().map(t => ({ s, t })))
        .map(st => DiffTable.create({
            schemaName: st.s.name,
            tableName: st.t.name,

            primaryKeyName: st.t.keyConstraints().filter(k => k.type == "PK").map(k => k.name).firstOrNull().$v,

            columns: st.t.columns()
                .leftJoin(view(SysTypes), c => c.user_type_id, ut => ut.user_type_id, (c, ut) => ({ c, ut }))
                .leftJoin(view(SysTypes), x => x.c.system_type_id, sty => sty.user_type_id, (x, sty) => ({ c: x.c, ut: x.ut, sty }))
                .leftJoin(view(SysDefaultConstraints), x => x.c.default_object_id, dc => dc.object_id, (x, dc) => ({ c: x.c, ut: x.ut, sty: x.sty, dc }))
                .map(x => DiffColumn.create({
                    name: x.c.name,
                    // Signum's ToSqlDbType: userType.name ?? sysType.name, numeric folds to decimal.
                    typeName: x.sty == null ? "udt" : (x.ut != null ? (x.ut.name == "numeric" ? "decimal" : x.ut.name) : x.sty.name),
                    nullable: x.c.is_nullable,
                    length: x.c.max_length,
                    precision: x.c.precision,
                    scale: x.c.scale,
                    identity: x.c.is_identity,
                    // A DB-default collation (or none) normalises to undefined in create.
                    collation: x.c.collation_name != dbCollation ? x.c.collation_name : null,
                    defaultName: x.dc == null ? null : x.dc.name,
                    defaultDefinition: x.dc == null ? null : x.dc.definition,
                }))
                .toArray().$v,

            multiForeignKeys: st.t.foreignKeys()
                .innerJoin(view(SysTables), fk => fk.referenced_object_id, rt => rt.object_id, (fk, rt) => ({ fk, rt }))
                .map(fr => DiffForeignKey.create({
                    schemaName: fr.fk.schema().$v.name,
                    conname: fr.fk.name,
                    isDisabled: fr.fk.is_disabled,
                    isNotTrusted: fr.fk.is_not_trusted,
                    targetSchema: fr.rt.schema().$v.name,
                    targetName: fr.rt.name,
                    columns: fr.fk.foreignKeyColumns()
                        .map(fkc => DiffForeignKeyColumn.create({
                            parent: st.t.columns().single(c => c.column_id == fkc.parent_column_id).$v.name,
                            referenced: fr.rt.columns().single(c => c.column_id == fkc.referenced_column_id).$v.name,
                        }))
                        .toArray().$v,
                }))
                .toArray().$v,

            // The table's indexes: each index with its (key + included) columns resolved to
            // names by joining sys.index_columns back to sys.columns on column_id (Signum's
            // SimpleIndices). is_primary_key rows are read too (the synchronizer filters them);
            // the heap row (index_id 0, NULL name — Signum's DiffIndexType.Heap) is skipped.
            indices: st.t.indices()
                .filter(i => i.name != null)
                .map(i => DiffIndex.create({
                    indexName: i.name,
                    isUnique: i.is_unique,
                    isPrimary: i.is_primary_key,
                    filterDefinition: i.filter_definition,
                    columns: i.indexColumns()
                        .innerJoin(st.t.columns(), ic => ic.column_id, c => c.column_id, (ic, c) => ({ ic, c }))
                        .map(x => DiffIndexColumn.create({
                            index: x.ic.index_column_id,
                            columnName: x.c.name,
                            isDescending: x.ic.is_descending_key,
                            included: x.ic.is_included_column,
                        }))
                        .toArray().$v,
                }))
                .toArray().$v,
        }))
        .toArray();

    // SQL Server reports NChar/NVarChar length in bytes — halve to characters (Signum's
    // FixSqlColumnLengthSqlServer). Client-side (dialect-specific).
    for (const t of tables)
        t.fixSqlColumnLengthSqlServer();

    return tables.toMap(t => t.name.toString());
}

async function getDatabaseCollation(): Promise<string> {
    const rows = await Connector.current().executeQuery("SELECT CAST(DATABASEPROPERTYEX(DB_NAME(),'Collation') AS nvarchar(200)) AS c");
    return (rows[0] as { c: string }).c;
}
