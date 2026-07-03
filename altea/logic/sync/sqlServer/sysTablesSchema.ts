import { Connector } from "../../connection/connector";
import { AbstractDbType } from "../../schema/dbType";
import { ObjectName, SchemaName, DatabaseName } from "../../schema/objectName";
import { DiffTable, DiffColumn, DiffForeignKey, DiffForeignKeyColumn, DiffDefaultConstraint } from "../diffModels";
import { view } from "../../table";
import {
    SysSchemas, SysTables, SysColumns, SysTypes, SysDefaultConstraints,
    SysForeignKeys, SysForeignKeyColumns, SysKeyConstraints,
} from "./sysTables";

// Port of Signum's Engine/Sync/SqlServer/SysTablesSchema.GetDatabaseDescription, scoped to
// the lean synchronizer (tables / columns / foreign keys). Kept as ONE big query, faithful
// to Signum's `from s in SysSchemas from t in s.Tables() select new DiffTable { … }` — the
// nested Columns projection LEFT JOINs sys.types (twice: user + system type) and
// sys.default_constraints, and MultiForeignKeys nests its own column sub-projection with
// correlated single lookups. Running this query end to end exercises the LINQ provider's
// SelectMany + nested projections + joins + correlated subqueries — it is a test in itself.
//
// Signum's `t.Columns()` etc. are IQueryable navigation (= `Database.View<SysColumns>()
// .Where(c => c.object_id == object_id)`); altea inlines the same filtered view so the
// result stays a chainable Query. The DiffXxx graph is built from the query rows in a thin
// post-step (the analogue of Signum's `.ToDictionaryEx`/`.ToList`). Divergences: async
// terminals; single database; default schema 'dbo' normalised to '' (altea's default
// SchemaName); temporal/index/stats/check/computed reads omitted.

const DEFAULT_SCHEMA_SQLSERVER = "dbo";

export async function getDatabaseDescription(): Promise<Map<string, DiffTable>> {
    const dbCollation = await getDatabaseCollation();

    const rows = await view(SysSchemas)
        .flatMap(s => s.tables().map(t => ({ s, t })))
        .map(st => ({
            schemaName: st.s.name,
            tableName: st.t.name,

            // (from k in t.KeyConstraints() where k.type == "PK" select k.name).SingleOrDefaultEx()
            primaryKeyName: st.t.keyConstraints()
                .filter(k => k.type == "PK")
                .map(k => k.name)
                .firstOrNull().$v,

            columns: st.t.columns()
                .leftJoin(view(SysTypes), c => c.user_type_id, ut => ut.user_type_id, (c, ut) => ({ c, ut }))
                .leftJoin(view(SysTypes), x => x.c.system_type_id, sty => sty.user_type_id, (x, sty) => ({ c: x.c, ut: x.ut, sty }))
                .leftJoin(view(SysDefaultConstraints), x => x.c.default_object_id, dc => dc.object_id, (x, dc) => ({ c: x.c, ut: x.ut, sty: x.sty, dc }))
                .map(x => ({
                    name: x.c.name,
                    typeName: x.sty == null ? "udt" : (x.ut != null ? x.ut.name : x.sty.name),
                    nullable: x.c.is_nullable,
                    collation: x.c.collation_name,
                    length: x.c.max_length,
                    precision: x.c.precision,
                    scale: x.c.scale,
                    identity: x.c.is_identity,
                    defaultName: x.dc == null ? null : x.dc.name,
                    defaultDefinition: x.dc == null ? null : x.dc.definition,
                }))
                .toArray().$v,

            multiForeignKeys: st.t.foreignKeys()
                .innerJoin(view(SysTables), fk => fk.referenced_object_id, rt => rt.object_id, (fk, rt) => ({ fk, rt }))
                .map(fr => ({
                    fkName: fr.fk.name,
                    isDisabled: fr.fk.is_disabled,
                    isNotTrusted: fr.fk.is_not_trusted,
                    targetSchema: fr.rt.schema().$v.name,
                    targetName: fr.rt.name,
                    columns: fr.fk.foreignKeyColumns()
                        .map(fkc => ({
                            parent: st.t.columns().single(c => c.column_id == fkc.parent_column_id).$v.name,
                            referenced: fr.rt.columns().single(c => c.column_id == fkc.referenced_column_id).$v.name,
                        }))
                        .toArray().$v,
                }))
                .toArray().$v,
        }))
        .toArray() as unknown as RawTableRow[];

    const result = new Map<string, DiffTable>();
    for (const r of rows) {
        const schemaName = normalizeSchema(r.schemaName);
        const dt = new DiffTable();
        dt.name = objectName(schemaName, r.tableName);
        dt.primaryKeyName = r.primaryKeyName == null ? undefined : objectName(schemaName, r.primaryKeyName);

        dt.columns = {};
        for (const c of r.columns)
            dt.columns[c.name] = buildColumn(c, dbCollation);

        dt.multiForeignKeys = r.multiForeignKeys.map(fk => {
            const df = new DiffForeignKey();
            df.name = objectName(schemaName, fk.fkName);
            df.isDisabled = fk.isDisabled;
            df.isNotTrusted = fk.isNotTrusted;
            df.targetTable = objectName(normalizeSchema(fk.targetSchema), fk.targetName);
            df.columns = fk.columns.map(c => {
                const dfc = new DiffForeignKeyColumn();
                dfc.parent = c.parent;
                dfc.referenced = c.referenced;
                return dfc;
            });
            return df;
        });

        dt.fixSqlColumnLengthSqlServer();
        dt.foreignKeysToColumns();

        result.set(dt.name.toString(), dt);
    }

    return result;
}

// ---- shapes the giant query materialises ------------------------------------

interface RawColumnRow {
    name: string; typeName: string; nullable: boolean; collation: string;
    length: number; precision: number; scale: number; identity: boolean;
    defaultName: string | null; defaultDefinition: string | null;
}
interface RawFkColumnRow { parent: string; referenced: string; }
interface RawFkRow {
    fkName: string; isDisabled: boolean; isNotTrusted: boolean;
    targetSchema: string; targetName: string; columns: RawFkColumnRow[];
}
interface RawTableRow {
    schemaName: string; tableName: string; primaryKeyName: string | null;
    columns: RawColumnRow[]; multiForeignKeys: RawFkRow[];
}

// ---- helpers ----------------------------------------------------------------

function buildColumn(c: RawColumnRow, dbCollation: string): DiffColumn {
    const typeName = toSqlDbType(c.typeName);
    const col = new DiffColumn();
    col.name = c.name;
    // Only the SQL Server slot is compared on this dialect; the pg slot mirrors it so the
    // AbstractDbType is well-formed.
    col.dbType = new AbstractDbType(typeName, typeName);
    col.nullable = c.nullable;
    // Absent (non-char → null) or DB-default collation normalises to undefined so it matches
    // an un-collated model column (`null === undefined` would otherwise differ).
    col.collation = c.collation && c.collation !== dbCollation ? c.collation : undefined;
    col.length = c.length;
    col.precision = c.precision;
    col.scale = c.scale;
    col.identity = c.identity;
    col.primaryKey = false; // Ignored by columnEquals (ignorePrimaryKey); PK handled via primaryKeyName.
    if (c.defaultName != null)
        col.defaultConstraint = Object.assign(new DiffDefaultConstraint(), { name: c.defaultName, definition: c.defaultDefinition! });
    return col;
}

// Signum's ToSqlDbType — numeric folds to decimal; otherwise the catalog name is the SQL
// Server type name altea uses in AbstractDbType.sqlServer.
function toSqlDbType(name: string): string {
    const n = name.toLowerCase();
    return n === "numeric" ? "decimal" : n;
}

function normalizeSchema(name: string): string {
    return name === DEFAULT_SCHEMA_SQLSERVER ? "" : name;
}

function objectName(schema: string, name: string): ObjectName {
    return new ObjectName(name, new SchemaName(schema, new DatabaseName("")));
}

async function getDatabaseCollation(): Promise<string> {
    const rows = await Connector.current().executeQuery("SELECT CAST(DATABASEPROPERTYEX(DB_NAME(),'Collation') AS nvarchar(200)) AS c");
    return (rows[0] as { c: string }).c;
}
