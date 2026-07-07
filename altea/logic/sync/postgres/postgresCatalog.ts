import { reflect } from "../../../entities/reflection";
import { tableName, viewPrimaryKey, quoted } from "../../../entities/decorators";
import { int } from "../../../entities/basics";
import { view } from "../../table";
import { View } from "../../../entities/entity";
import type { Query } from "../../query";

// Port of Signum's Engine/Sync/Postgres/PostgresCatalog.cs — the strongly-typed IView classes
// over PostgreSQL's system catalog (pg_catalog.*). A view class = @reflect (Signum's `: IView`)
// + @tableName (Signum's [TableName]) + @viewPrimaryKey fields; [AutoExpressionField]
// navigation becomes @quoted methods returning Query<T> / Promise<T> and calling view(T)
// directly (these classes are server-only).
//
// Scoped to the lean synchronizer (tables / columns / foreign keys): the trigger/index/
// access-method/opclass views (versioning, vector, indexes) are omitted. Char columns
// (relkind/contype/attidentity/attgenerated) are typed as string — pg returns a 1-char
// string. conkey/confkey are int2[] → number[] (array columns).

@reflect
@tableName("pg_catalog.pg_namespace")
export class PgNamespace extends View {
    @viewPrimaryKey oid!: int;
    nspname!: string;
    nspowner!: int;

    // Signum's PgNamespace.IsInternal — excludes information_schema and the pg_* schemas.
    @quoted
    isInternal(): boolean { return this.nspname == "information_schema" || this.nspname.startsWith("pg_"); }

    @quoted
    tables(): Query<PgClass> { return view(PgClass).filter(t => t.relnamespace == this.oid && t.relkind == "r"); }
}

@reflect
@tableName("pg_catalog.pg_class")
export class PgClass extends View {
    @viewPrimaryKey oid!: int;
    relname!: string;
    relnamespace!: int;
    relkind!: string;
    relowner!: int;

    @quoted
    attributes(): Query<PgAttribute> { return view(PgAttribute).filter(t => t.attrelid == this.oid); }

    @quoted
    constraints(): Query<PgConstraint> { return view(PgConstraint).filter(t => t.conrelid == this.oid); }

    @quoted
    indices(): Query<PgIndex> { return view(PgIndex).filter(t => t.indrelid == this.oid); }

    @quoted
    namespace(): Promise<PgNamespace> { return view(PgNamespace).single(t => t.oid == this.relnamespace); }
}

// pg_proc / pg_extension / pg_depend — read by SchemaAssets.SyncProcedures (Postgres branch) to
// recover the existing functions/procedures (and their decompiled definition text via
// pg_get_functiondef). `Extension()` filters out functions owned by an installed extension (they
// are not part of the schema Signum manages).
@reflect
@tableName("pg_catalog.pg_proc")
export class PgProc extends View {
    @viewPrimaryKey oid!: int;
    pronamespace!: int;
    proname!: string;

    @quoted
    namespace(): Promise<PgNamespace | null> { return view(PgNamespace).firstOrNull(t => t.oid == this.pronamespace); }

    // The extension that owns this function (via a pg_depend deptype='e' edge), or null.
    @quoted
    extension(): Promise<PgExtension | null> {
        return view(PgDepend)
            .filter(t => t.deptype == "e" && t.objid == this.oid)
            .map(d => view(PgExtension).single(e => e.oid == d.refobjid).$v)
            .firstOrNull();
    }
}

@reflect
@tableName("pg_catalog.pg_extension")
export class PgExtension extends View {
    @viewPrimaryKey oid!: int;
    extname!: string;
}

@reflect
@tableName("pg_catalog.pg_depend")
export class PgDepend extends View {
    @viewPrimaryKey objid!: int;
    deptype!: string;
    refobjid!: int;
}

// pg_class.relkind values (Signum's RelKind).
export const RelKind = {
    Table: "r",
    Index: "i",
    Sequence: "s",
    View: "v",
} as const;

@reflect
@tableName("pg_catalog.pg_attribute")
export class PgAttribute extends View {
    @viewPrimaryKey attrelid!: int;
    @viewPrimaryKey attname!: string;

    atttypid!: int;
    atttypmod!: int;
    attnum!: int;
    attnotnull!: boolean;
    attidentity!: string;
    attgenerated!: string;
    attisdropped!: boolean;

    @quoted
    type(): Promise<PgType> { return view(PgType).single(t => t.oid == this.atttypid); }

    // The column's default row in pg_attrdef, or null (Signum's PgAttribute.AttrDef()).
    @quoted
    attrDef(): Promise<PgAttrDef | null> { return view(PgAttrDef).filter(d => d.adrelid == this.attrelid && d.adnum == this.attnum).firstOrNull(); }
}

@reflect
@tableName("pg_catalog.pg_attrdef")
export class PgAttrDef extends View {
    @viewPrimaryKey oid!: int;
    adrelid!: int;
    adnum!: int;
    // The stored default expression (a pg_node_tree); decompiled to SQL text via pg_get_expr.
    adbin!: string;
}

@reflect
@tableName("pg_catalog.pg_type")
export class PgType extends View {
    @viewPrimaryKey oid!: int;
    typname!: string;
    typnamespace!: int;
}

@reflect
@tableName("pg_catalog.pg_constraint")
export class PgConstraint extends View {
    @viewPrimaryKey oid!: int;
    conname!: string;
    connamespace!: int;
    contype!: string;
    conrelid!: int;
    conkey!: number[];
    confrelid!: int;
    confkey!: number[];

    @quoted
    namespace(): Promise<PgNamespace> { return view(PgNamespace).single(n => n.oid == this.connamespace); }

    // The referenced (target) table of a foreign key (Signum's PgConstraint.TargetTable()).
    @quoted
    targetTable(): Promise<PgClass> { return view(PgClass).single(c => c.oid == this.confrelid); }
}

// pg_constraint.contype values (Signum's ConstraintType).
export const ConstraintType = {
    Check: "c",
    ForeignKey: "f",
    PrimaryKey: "p",
    Unique: "u",
} as const;

@reflect
@tableName("pg_catalog.pg_index")
export class PgIndex extends View {
    @viewPrimaryKey indexrelid!: int;
    indrelid!: int;
    // Total attributes vs *key* attributes: positions >= indnkeyatts are INCLUDE (covering)
    // columns (Signum's PgIndex.indnatts / indnkeyatts).
    indnkeyatts!: int;
    indisunique!: boolean;
    indisprimary!: boolean;
    // The indexed columns' attnums (pg's int2vector, 0-based). generate_subscripts + `arr[i]`
    // subscripting resolve each attnum to a column name in the query.
    indkey!: number[];
    // The partial-index predicate (a pg_node_tree); decompiled to SQL text via pg_get_expr.
    indpred!: string;

    // The index's row in pg_class carries its NAME (Signum's PgIndex.Class().relname).
    @quoted
    class(): Promise<PgClass> { return view(PgClass).single(t => t.oid == this.indexrelid); }
}
