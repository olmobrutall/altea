import { BaseEntity, Entity } from "./entity";
import { Lite } from "./lite";
import { tryGetTypeInfo } from "./reflection";
import { cleanTypeName } from "./registration";
import { Temporal, Decimal } from "./basics";

// Port of Signum's ObjectDumper (Signum/Entities/ObjectDumper.cs) — renders an entity GRAPH as
// pseudo-source text, one property per line. It exists for exactly one reason: a textual dump is
// DIFFABLE, which is what @altea/altea-diff-log builds an operation's before/after view on.
//
// It lives in core (as it does in Signum) rather than in the diff-log package: it needs nothing but
// reflection + entity/lite, and a dump is generally useful for diagnostics.
//
// altea divergences, documented inline:
//  - the output is C#-FLAVOURED, deliberately, and unchanged from Signum: `new OrderEntity(10248) { … }`,
//    `new LiteImp<CustomerEntity>(5, "Acme")`, trailing commas, 3-space indent. Keeping the format means a
//    dump stored by a Signum application still diffs against one produced here — and, more practically,
//    that DiffLog's `simplifyDump` regex (which collapses a fat lite to `{ Entity = /* Loaded */ }`) is
//    the same regex. The type NAME is altea's clean name.
//  - `ShowIgnoredFields` collapses to one boolean: altea has no `[QueryableProperty]`, so the
//    OnlyQueryables middle case has nothing to distinguish. `@column(false)` (Signum's `[Ignore]`) is the
//    skip condition, plus `@serialize(false)` bookkeeping, which is never interesting in a dump.
//  - `[AvoidDump]` / `[AvoidDumpEntity]` have no altea decorators yet; the two hooks they fed are exposed
//    as `ObjectDumper.avoidDump` / `avoidDumpEntity` sets keyed by "TypeName.fieldName", so an application
//    can opt a field out without a new decorator. (Signum's attributes are per-property; a set of routes is
//    the same information, declared centrally.)
//  - CULTURE INDEPENDENCE replaces Signum's `Schema.ForceCultureInfo` scope. Signum wraps every dump in a
//    fixed culture so the reader's locale can't pollute a diff; altea instead formats invariantly here — a
//    Temporal renders as its ISO string, a Decimal through `toString()`, a number through `String(n)` —
//    so there is no culture to fix.
//  - MIXINS are not a separate branch: altea inlines a mixin's fields onto the owner, so they dump as the
//    owner's own fields (Signum sorts them last through `IsMixinField`).

export namespace ObjectDumper {

    /** Signum's `ObjectDumper.IgnoreTypes` — dumped as `new X { toString }`, never walked. */
    export const ignoreTypes = new Set<string>(["Exception"]);

    /** Skip this field entirely (Signum's `[AvoidDump]`). Keys are `"CleanTypeName.fieldName"`. */
    export const avoidDump = new Set<string>();

    /** Dump this reference as a lite, never expanded (Signum's `[AvoidDumpEntity]`). Same key shape. */
    export const avoidDumpEntity = new Set<string>();

    export interface DumpOptions {
        /** Signum's ShowIgnoredFields — include `@column(false)` fields. Default false. */
        readonly showIgnoredFields?: boolean;
        /** Signum's showByteArrays — spell out a Blob's bytes instead of `{...}`. Default false. */
        readonly showByteArrays?: boolean;
    }

    export function dump(value: unknown, options?: DumpOptions): string {
        const visitor = new DumpVisitor(options?.showIgnoredFields === true, options?.showByteArrays === true);
        visitor.dumpObject(value);
        return visitor.text;
    }
}

function indent(text: string, level: number): string {
    return " ".repeat(level * 3) + text;
}

class DumpVisitor {
    /** Reference identity, so a cycle (or a shared node) is reported instead of walked twice. */
    private readonly seen = new Set<object>();
    private parts: string[] = [];
    private level = 0;

    constructor(private readonly showIgnoredFields: boolean, private readonly showByteArrays: boolean) { }

    get text(): string {
        return this.parts.join("");
    }

    private append(text: string): void {
        this.parts.push(text);
    }

    private appendLine(text = ""): void {
        this.parts.push(text + "\n");
    }

    dumpObject(o: unknown, avoidDumpEntity = false): void {
        if (o == undefined) {
            this.append("null");
            return;
        }

        if (typeof o === "function") {
            this.append("[DELEGATE]");
            return;
        }

        if (isBasicValue(o)) {
            this.append(dumpValue(o));
            return;
        }

        // ---- entity / lite / embedded headers -------------------------------------------------

        if (o instanceof Lite) {
            this.append(`new LiteImp<${cleanTypeName(o.entityType)}>`);
            this.append(`(${o.id ?? "null"}, "${escapeString(o.toString())}")`);

            if (o.entityOrNull != undefined && !avoidDumpEntity) {
                this.appendLine();
                this.appendLine(indent("{", this.level));
                this.level += 1;
                this.dumpPropertyOrField("Entity", o.entityOrNull);
                this.level -= 1;
                this.append(indent("}", this.level));
            }
            return;
        }

        if (!(o instanceof BaseEntity)) {
            // A plain object / array / Map — dumped structurally, as Signum does for non-Modifiables.
            this.dumpPlain(o, avoidDumpEntity);
            return;
        }

        const typeName = cleanTypeName(o.constructor);
        this.append("new " + typeName);

        if (ObjectDumper.ignoreTypes.has(typeName)) {
            this.append(`{ ${safeToString(o)} }`);
            return;
        }

        if (this.seen.has(o)) {
            if (o instanceof Entity)
                this.append(`(${o.isNew ? "IsNew" : String(o.id)}${o.ticks ? ", ticks: " + o.ticks : ""})`);
            this.append(` /* [ALREADY] ${safeToString(o)} */`);
            return;
        }
        this.seen.add(o);

        if (o instanceof Entity) {
            this.append(`(${o.isNew ? "IsNew" : String(o.id)}${o.ticks ? ", ticks: " + o.ticks : ""})`);
            this.append(` /* ${safeToString(o)} ${avoidDumpEntity ? "[DUMP AS LITE]" : ""} */`);
            if (avoidDumpEntity)
                return;
        }

        // ---- the fields, from reflection ------------------------------------------------------

        const ti = tryGetTypeInfo(o.constructor);
        const fields = ti == undefined ? [] : Object.values(ti.fields);

        this.appendLine();
        this.appendLine(indent("{", this.level));
        this.level += 1;

        for (const fi of fields) {
            // `id` / `ticks` already appear in the header (Signum's IsIdOrTicks).
            if (fi.name === "id" || fi.name === "ticks")
                continue;
            // Pure bookkeeping (`isNew`, `_snapshot`) is never interesting.
            if (fi.noSerialize === true)
                continue;
            if (fi.notMapped && !this.showIgnoredFields)
                continue;

            const route = `${typeName}.${fi.name}`;
            if (ObjectDumper.avoidDump.has(route))
                continue;

            this.dumpPropertyOrField(fi.name, (o as unknown as Record<string, unknown>)[fi.name],
                ObjectDumper.avoidDumpEntity.has(route));
        }

        this.level -= 1;
        this.append(indent("}", this.level));
    }

    /** Signum's non-Modifiable branch: an array, a Map, or a plain object. */
    private dumpPlain(o: object, avoidDumpEntity: boolean): void {
        if (o instanceof Uint8Array) {
            this.append("new Blob");
            this.append(this.showByteArrays ? `{ ${[...o].join(", ")} }` : "{...}");
            return;
        }

        if (this.seen.has(o)) {
            this.append(`/* [ALREADY] ${safeToString(o)} */`);
            return;
        }
        this.seen.add(o);

        if (Array.isArray(o)) {
            this.append("new []");
            if (o.length === 0) {
                this.append("{}");
                return;
            }
            this.appendLine();
            this.appendLine(indent("{", this.level));
            this.level += 1;
            for (const item of o) {
                this.append(indent("", this.level));
                this.dumpObject(item, avoidDumpEntity);
                this.appendLine(",");
            }
            this.level -= 1;
            this.append(indent("}", this.level));
            return;
        }

        if (o instanceof Map) {
            this.append("new Dictionary");
            if (o.size === 0) {
                this.append("{}");
                return;
            }
            this.appendLine();
            this.appendLine(indent("{", this.level));
            this.level += 1;
            for (const [key, value] of o) {
                this.append(indent("{", this.level));
                this.dumpObject(key);
                this.append(", ");
                this.dumpObject(value);
                this.appendLine("},");
            }
            this.level -= 1;
            this.append(indent("}", this.level));
            return;
        }

        this.append("new " + (o.constructor?.name ?? "Object"));
        const entries = Object.entries(o);
        if (entries.length === 0) {
            this.append("{}");
            return;
        }
        this.appendLine();
        this.appendLine(indent("{", this.level));
        this.level += 1;
        for (const [key, value] of entries)
            this.dumpPropertyOrField(key, value);
        this.level -= 1;
        this.append(indent("}", this.level));
    }

    private dumpPropertyOrField(name: string, value: unknown, avoidDumpEntity = false): void {
        this.append(indent(`${name} = `, this.level));
        this.dumpObject(value, avoidDumpEntity);
        this.appendLine(",");
    }
}

/** A value that renders inline, with no braces (Signum's IsBasicType || IsValueType). */
function isBasicValue(o: unknown): boolean {
    return typeof o === "string" || typeof o === "number" || typeof o === "boolean" || typeof o === "bigint"
        || o instanceof Decimal
        || o instanceof Temporal.PlainDate || o instanceof Temporal.PlainDateTime
        || o instanceof Temporal.PlainTime || o instanceof Temporal.Duration
        || o instanceof Temporal.Instant || o instanceof Temporal.ZonedDateTime
        || o instanceof Date;
}

/**
 * Signum's DumpValue. Culture-INVARIANT by construction (see the header): a Temporal renders as its own
 * ISO string, a Decimal / number through `toString`, so no culture scope is needed around a dump.
 */
function dumpValue(item: unknown): string {
    if (typeof item === "string")
        return `"${escapeString(item)}"`;

    if (typeof item === "boolean")
        return item ? "true" : "false";

    if (item instanceof Decimal)
        return `${item.toString()}M`;

    if (item instanceof Date)
        return `DateTime.Parse("${item.toISOString()}")`;

    // Every Temporal type round-trips through its own ISO form (Signum's `DateTime.Parse("O")`).
    if (item instanceof Temporal.PlainDate || item instanceof Temporal.PlainDateTime
        || item instanceof Temporal.PlainTime || item instanceof Temporal.Duration
        || item instanceof Temporal.Instant || item instanceof Temporal.ZonedDateTime)
        return `${item.constructor.name}.from("${item.toString()}")`;

    return String(item);
}

function escapeString(value: string): string {
    return value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, "\\\"")
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n")
        .replace(/\t/g, "\\t");
}

/** Signum's SafeToString — a throwing `toString()` must not take the whole dump down. */
function safeToString(o: unknown): string {
    try {
        return String(o);
    } catch (e) {
        const message = e instanceof Error ? `${e.name}:${e.message}` : String(e);
        return "ToString thrown " + (message.length <= 100 ? message : message.slice(0, 100) + "...");
    }
}

