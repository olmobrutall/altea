import type { Implementations } from "../../entities/implementations";
import type { PropertyRoute } from "../../entities/propertyRoute";

// Port of Signum's `Meta` / `CleanMeta` / `DirtyMeta` (DynamicQuery/Meta.cs). A column's derived
// metadata — its `implementations` and `IsAllowed` (and, once altea models them, unit/format/niceName)
// — obtained by tracking which entity `PropertyRoute`s an expression reads (the MetadataVisitor).
//
//  - CleanMeta: the value passes through from one (or, for a polymorphic reference, several) route(s)
//    unchanged, so it inherits that route's metadata directly.
//  - DirtyMeta: the value is COMPUTED (arithmetic, an aggregate, a conditional, …) from zero or more
//    routes; unit/format/niceName can't be inherited, but IsAllowed still ANDs over every contributing
//    clean route (so a computed column is denied if any source column is).
export abstract class Meta {
    protected constructor(readonly implementations: Implementations | undefined) { }

    // Signum's Meta.IsAllowed(): null ⇒ allowed; otherwise a human-readable reason (the offending
    // routes). Resolves through PropertyRoute.isAllowedCallback, so it re-evaluates per current user.
    abstract isAllowed(): string | null;

    // The clean routes that feed this metadata (a CleanMeta's own routes; a DirtyMeta's contributors).
    abstract get cleanRoutes(): readonly PropertyRoute[];
}

export class CleanMeta extends Meta {
    constructor(implementations: Implementations | undefined, readonly propertyRoutes: PropertyRoute[]) {
        super(implementations);
    }

    override isAllowed(): string | null {
        const reasons = this.propertyRoutes.map(r => r.isAllowed()).filter((x): x is string => x != null);
        return reasons.length === 0 ? null : [...new Set(reasons)].join(", ");
    }

    override get cleanRoutes(): readonly PropertyRoute[] { return this.propertyRoutes; }

    toString(): string { return `CleanMeta(${this.propertyRoutes.join(", ")})`; }
}

export class DirtyMeta extends Meta {
    // Signum flattens: a DirtyMeta keeps the CleanMetas of all its contributors (a nested DirtyMeta
    // contributes its own CleanMetas), so IsAllowed can walk every ultimately-referenced route.
    readonly cleanMetas: CleanMeta[];

    constructor(implementations: Implementations | undefined, metas: Meta[]) {
        super(implementations);
        this.cleanMetas = metas.flatMap(m => m instanceof CleanMeta ? [m] : (m as DirtyMeta).cleanMetas);
    }

    override isAllowed(): string | null {
        const reasons = this.cleanMetas.map(cm => cm.isAllowed()).filter((x): x is string => x != null);
        return reasons.length === 0 ? null : [...new Set(reasons)].join(", ");
    }

    override get cleanRoutes(): readonly PropertyRoute[] { return this.cleanMetas.flatMap(cm => cm.propertyRoutes); }

    toString(): string { return `DirtyMeta(${this.cleanMetas.join(", ")})`; }
}
