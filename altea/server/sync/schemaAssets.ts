import { Connector } from "../connection/connector";
import { ObjectName, SchemaName, DatabaseName } from "../schema/objectName";
import { SqlPreCommand, SqlPreCommandSimple, Spacing } from "./sqlPreCommand";
import { Synchronizer, Replacements } from "./synchronizer";
import { view } from "../table";
import { SysObjects, SysSqlModules, SysViews } from "./sqlServer/sysTables";
import { PgProc, PgClass, RelKind } from "./postgres/postgresCatalog";
import { PostgresFunctions } from "./postgres/postgresFunctions";

// Port of Signum's Engine/Schema/SchemaAssets.cs — the schema's Views and stored procedures /
// user-defined functions, with GENERATION (CreateView/CreateSql emitted from the model) and
// SYNCHRONIZATION (diff the model against the live catalog via Synchronizer.SynchronizeScript).
//
// An app registers assets through IncludeView / IncludeUserDefinedFunction / IncludeStoreProcedure
// (see MinimumExtensions.includeFunction in altea-test), and the Schema wires the four
// schema_* methods into its generating / synchronizing pipelines (see schema.ts). UDFs are forced
// to beforeTables=true (Signum), so they exist before the tables that may reference them.
//
// Divergences from Signum:
//  - No GoBefore/GoAfter batch splitting: altea's executeNonQuery runs each SqlPreCommandSimple
//    as its own batch already (SchemaAssets.cs relied on GO markers to isolate CREATE FUNCTION).
//    So each create/alter/drop is a single SqlPreCommandSimple, which is what the SQL Server
//    "CREATE FUNCTION must be the only statement in its batch" rule requires.
//  - Single-database only: DatabaseNames()/OverrideDatabaseInSysViews multi-db handling is dropped.
//  - async: the catalog readers use async query terminals, so the schema_Synchronizing* methods
//    return Promises (Signum is synchronous).

// Signum's Clean: `command.Replace("\r","").Trim(' ','\n',';')`. Strips carriage returns, then
// trims spaces, newlines and semicolons off both ends (NOT internal whitespace — sys.sql_modules
// stores the definition verbatim, and the mergeBoth comparison depends on an exact match).
function clean(command: string): string {
    let s = command.replace(/\r/g, "");
    // Trim(' ', '\n', ';') — C# trims the given chars off both ends.
    s = s.replace(/^[ \n;]+/, "").replace(/[ \n;]+$/, "");
    return s;
}

// The default schema of either dialect ('dbo' / 'public') maps to altea's empty default
// SchemaName, so a registered asset's key matches the catalog-derived key (which normalises the
// same way — see diffModels.normalizeSchema). Faithful to Signum's SchemaName.Default(isPostgres).
function normalizeSchema(name: string): string {
    return name === "dbo" || name === "public" ? "" : name;
}

// Parse "schema.name" / "name" into an ObjectName with the default schema normalised, so the map
// key (objectName.toString()) collapses to the bare name for default-schema objects — matching
// the catalog reader. Single-database (no [database] qualifier). Mirrors Signum's
// IncludeXxx(string) which builds `new ObjectName(SchemaName.Default(isPostgres), name)`.
function parseAssetName(name: string): ObjectName {
    const parts = name.split(".");
    if (parts.length === 1)
        return new ObjectName(parts[0], new SchemaName("", new DatabaseName("")));
    const objName = parts[parts.length - 1];
    const schema = parts[parts.length - 2];
    return new ObjectName(objName, new SchemaName(normalizeSchema(schema), new DatabaseName("")));
}

// Renders a fully-qualified, escaped object name for the DDL text (via the active dialect's
// SqlBuilder), matching how tables are emitted.
function renderName(name: ObjectName): string {
    return Connector.current().sqlBuilder.objectName(name);
}

// ---- Views ------------------------------------------------------------------

export class AssetView {
    constructor(
        public readonly name: ObjectName,
        public readonly definition: string,
    ) { }

    createView(): SqlPreCommandSimple {
        return new SqlPreCommandSimple(`CREATE VIEW ${renderName(this.name)} ` + this.definition);
    }

    alterView(): SqlPreCommandSimple {
        return new SqlPreCommandSimple(`ALTER VIEW ${renderName(this.name)} ` + this.definition);
    }

    dropView(): SqlPreCommandSimple {
        return new SqlPreCommandSimple(`DROP VIEW ${renderName(this.name)} `);
    }
}

// ---- Procedures / functions -------------------------------------------------

export class Procedure {
    beforeTables = false;

    constructor(
        public readonly procedureType: string, // "PROCEDURE" | "FUNCTION"
        public readonly name: ObjectName,
        public readonly codeAndArguments: string,
    ) { }

    createSql(): SqlPreCommandSimple {
        return new SqlPreCommandSimple(`CREATE ${this.procedureType} ${renderName(this.name)} ` + this.codeAndArguments);
    }

    alterSql(): SqlPreCommandSimple {
        if (Connector.current().isPostgres)
            return new SqlPreCommandSimple(`CREATE OR REPLACE ${this.procedureType} ${renderName(this.name)} ` + this.codeAndArguments);

        return new SqlPreCommandSimple(`ALTER ${this.procedureType} ${renderName(this.name)} ` + this.codeAndArguments);
    }

    dropSql(): SqlPreCommandSimple {
        return new SqlPreCommandSimple(`DROP ${this.procedureType} ${renderName(this.name)} `);
    }
}

// ---- SchemaAssets -----------------------------------------------------------

export class SchemaAssets {
    // Keyed by objectName.toString() (default schema normalised), so they align with the
    // catalog-derived keys used in the sync diff. Signum keys by ObjectName (value equality);
    // altea uses the rendered string, which is the same distinguishing key.
    readonly views = new Map<string, AssetView>();
    readonly storeProcedures = new Map<string, Procedure>();

    // ---- registration -------------------------------------------------------

    includeView(viewName: string, viewDefinition: string): AssetView {
        const name = parseAssetName(viewName);
        const v = new AssetView(name, viewDefinition);
        this.views.set(name.toString(), v);
        return v;
    }

    // Signum forces UDFs to beforeTables=true (a function a computed column / index may reference
    // must exist before the tables). procedureType "FUNCTION".
    includeUserDefinedFunction(functionName: string, functionCodeAndArguments: string, _beforeTables = true): Procedure {
        const name = parseAssetName(functionName);
        const p = new Procedure("FUNCTION", name, functionCodeAndArguments);
        p.beforeTables = true;
        this.storeProcedures.set(name.toString(), p);
        return p;
    }

    includeStoreProcedure(procedureName: string, procedureCodeAndArguments: string, beforeTables = false): Procedure {
        const name = parseAssetName(procedureName);
        const p = new Procedure("PROCEDURE", name, procedureCodeAndArguments);
        p.beforeTables = beforeTables;
        this.storeProcedures.set(name.toString(), p);
        return p;
    }

    // ---- generation ---------------------------------------------------------

    private generateViews(): SqlPreCommand | undefined {
        return SqlPreCommand.combine(Spacing.Double, ...[...this.views.values()].map(v => v.createView()));
    }

    private generateProcedures(beforeTables: boolean): SqlPreCommand | undefined {
        return SqlPreCommand.combine(Spacing.Double,
            ...[...this.storeProcedures.values()].filter(p => p.beforeTables === beforeTables).map(p => p.createSql()));
    }

    schema_GeneratingBeforeTables(): SqlPreCommand | undefined {
        return this.generateProcedures(/* beforeTables */ true);
    }

    schema_Generating(): SqlPreCommand | undefined {
        const views = this.generateViews();
        const procedures = this.generateProcedures(/* beforeTables */ false);
        return SqlPreCommand.combine(Spacing.Triple, views, procedures);
    }

    // ---- synchronization ----------------------------------------------------

    schema_Synchronizing(replacements: Replacements): Promise<SqlPreCommand | undefined> {
        return this.syncAll(replacements, /* beforeTables */ false);
    }

    schema_SynchronizingBeforeTables(replacements: Replacements): Promise<SqlPreCommand | undefined> {
        return this.syncProcedures(replacements, /* beforeTables */ true);
    }

    private async syncAll(replacements: Replacements, beforeTables: boolean): Promise<SqlPreCommand | undefined> {
        const views = await this.syncViews(replacements, beforeTables);
        const procedures = await this.syncProcedures(replacements, beforeTables);
        return SqlPreCommand.combine(Spacing.Triple, views, procedures);
    }

    // Read the live views + their definition text, keyed the same way as the model, then diff
    // (Signum's SyncViews). A matched view whose CREATE text equals the stored definition
    // produces no script.
    private async syncViews(_replacements: Replacements, beforeTables: boolean): Promise<SqlPreCommand | undefined> {
        const oldViews = await this.readOldViews();

        return Synchronizer.synchronizeScript(
            Spacing.Double,
            this.views,
            oldViews,
            /* createNew */ (_name, newView) => beforeTables ? undefined : newView.createView(),
            /* removeOld */ undefined,
            /* mergeBoth */ (_name, newDef, oldDef) =>
                clean(newDef.createView().sql) === clean(oldDef) ? undefined :
                    beforeTables ? newDef.dropView() : newDef.createView(),
        );
    }

    // Read the live procedures/functions + their definition text, then diff (Signum's
    // SyncProcedures). A matched function whose codeAndArguments equals the stored definition
    // (from the first "(" onward) produces no script — this is what makes a freshly generated
    // schema round-trip to an empty sync.
    private async syncProcedures(_replacements: Replacements, beforeTables: boolean): Promise<SqlPreCommand | undefined> {
        const oldProcedures = await this.readOldProcedures();

        if (beforeTables) {
            return Synchronizer.synchronizeScript(
                Spacing.Double,
                this.storeProcedures,
                oldProcedures,
                /* createNew */ (_name, newProc) => newProc.beforeTables ? newProc.createSql() : undefined,
                /* removeOld */ undefined,
                /* mergeBoth */ (_name, newProc, oldProc) =>
                    clean(newProc.codeAndArguments) === clean("(" + afterFirst(oldProc, "(")) ? undefined :
                        newProc.beforeTables ? newProc.alterSql() : undefined,
            );
        }

        return Synchronizer.synchronizeScript(
            Spacing.Double,
            this.storeProcedures,
            oldProcedures,
            /* createNew */ (_name, newProc) => !newProc.beforeTables ? newProc.createSql() : undefined,
            /* removeOld */ undefined,
            /* mergeBoth */ (_name, newProc, oldProc) =>
                clean(newProc.codeAndArguments) === clean("(" + afterFirst(oldProc, "(")) ? undefined :
                    newProc.beforeTables ? undefined :
                        newProc.alterSql(),
        );
    }

    // ---- catalog reads ------------------------------------------------------

    // Map<key, definitionText> of the live views. key = objectName.toString() (default schema
    // normalised), matching the model keys. Dialect-branched, mirroring Signum's SyncViews.
    private async readOldViews(): Promise<Map<string, string>> {
        const isPostgres = Connector.current().isPostgres;
        const map = new Map<string, string>();

        if (isPostgres) {
            const rows = await view(PgClass)
                .filter(p => p.relkind == RelKind.View && !p.namespace().$v.isInternal())
                .map(p => ({ schema: p.namespace().$v.nspname, name: p.relname, definition: PostgresFunctions.pg_get_viewdef(p.oid) }))
                .toArray();
            for (const r of rows)
                map.set(objectKey(r.schema, r.name), r.definition);
        } else {
            const rows = await view(SysViews)
                .innerJoin(view(SysSqlModules), v => v.object_id, m => m.object_id, (v, m) => ({ v, m }))
                .map(x => ({ schema: x.v.schema().$v.name, name: x.v.name, definition: x.m.definition }))
                .toArray();
            for (const r of rows)
                map.set(objectKey(r.schema, r.name), r.definition);
        }

        return map;
    }

    // Map<key, definitionText> of the live stored procedures / functions. Dialect-branched,
    // mirroring Signum's SyncProcedures.
    private async readOldProcedures(): Promise<Map<string, string>> {
        const isPostgres = Connector.current().isPostgres;
        const map = new Map<string, string>();

        if (isPostgres) {
            const rows = await view(PgProc)
                .filter(v => v.namespace().$v != null && !v.namespace().$v!.isInternal() && v.extension().$v == null)
                .map(v => ({ schema: v.namespace().$v!.nspname, name: v.proname, definition: PostgresFunctions.pg_get_functiondef(v.oid) }))
                .toArray();
            for (const r of rows)
                map.set(objectKey(r.schema, r.name), r.definition);
        } else {
            const types = ["P", "IF", "FN", "TF"];
            const rows = await view(SysObjects)
                .filter(p => types.contains(p.type))
                .innerJoin(view(SysSqlModules), p => p.object_id, m => m.object_id, (p, m) => ({ p, m }))
                .map(x => ({ schema: x.p.schema().$v.name, name: x.p.name, definition: x.m.definition }))
                .toArray();
            for (const r of rows)
                map.set(objectKey(r.schema, r.name), r.definition);
        }

        return map;
    }
}

// The diff key for a catalog-read object: default schema normalised, matching parseAssetName.
function objectKey(schema: string, name: string): string {
    return new ObjectName(name, new SchemaName(normalizeSchema(schema), new DatabaseName(""))).toString();
}

// C#'s string.After('('): the substring after the FIRST occurrence of `sep` (empty if absent).
function afterFirst(s: string, sep: string): string {
    const i = s.indexOf(sep);
    return i < 0 ? "" : s.substring(i + sep.length);
}
