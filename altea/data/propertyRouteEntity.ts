import { Entity } from './entity';
import { field } from './reflection';
import { entity, quoted, ticksColumn, uniqueIndex } from './decorators';
import { stringLengthValidator } from './validators';
import { msg } from './utils/localization';
import { TypeEntity } from './typeEntity';
import { PropertyRoute } from './propertyRoute';
import { resolveModifiableType } from './registration';

// Port of Signum's `PropertyRouteEntity` (Signum/Basics/PropertyRouteEntity.cs): the system table with one
// row per PROPERTY ROUTE of every registered type — `(rootType, path)`, where the path is the route's
// `propertyString()` ("name", "shipAddress.city", "[MyMixin].field").
//
// This table is a NORMALIZATION: five modules need to point at a route (a property authorization rule, a
// property's help, a tour's css step, a dynamic validation's sub-entity, a translated instance), and each
// stores an FK here rather than repeating the pair. The rows are DERIVED — generated from reflection and
// diffed on every sync, exactly like TypeEntity and QueryEntity — so nothing here is authored by a user.
//
// altea history: this type was deliberately NOT ported at first, and each of those five consumers stored the
// route as a STRING instead. That reads as the simpler model right up to the moment a database has to line
// up with a Signum one: `basics.property_route` then has no counterpart, so a sync offers to rename it into
// whatever unmatched table sorts nearest (a real run offered `basics.tour_trigger`), and the five consumer
// tables each diverge from Signum's shape by a column. Normalizing here is what makes all six match.
//
// altea divergences:
//  - `ToPropertyRouteFunc` — Signum's static hook filled by `PropertyRouteLogic` so the DATA layer can
//    resolve a row into a `PropertyRoute` without referencing the server — is unnecessary: `PropertyRoute`
//    and the type↔ctor registry both live in this isomorphic layer, so `toPropertyRoute()` resolves here.
@entity("System", "Master")
// Signum's [TicksColumn(false)]: the rows are written only by generation and by the synchronizer, never by
// two people at once, so a concurrency stamp would be a column with no reader.
@ticksColumn(false)
// Signum's `.WithUniqueIndex(p => new { p.Path, p.RootType })`, in that member order.
@uniqueIndex((p: PropertyRouteEntity) => [p.path, p.rootType])
export class PropertyRouteEntity extends Entity {
    /** The route's `propertyString()` relative to {@link rootType}. Signum's [StringLengthValidator(1, 100)]. */
    @stringLengthValidator({ min: 1, max: 100 })
    path: string;

    rootType: TypeEntity;

    /**
     * The in-memory route this row names (Signum's `ToPropertyRoute()`, which goes through the
     * `ToPropertyRouteFunc` hook — see the header). Throws when the path no longer parses against the
     * current schema, which is what makes a stale row loud rather than silently ignored.
     */
    toPropertyRoute(): PropertyRoute {
        const ctor = resolveModifiableType(this.rootType.cleanName);
        if (ctor == undefined)
            throw new Error(`PropertyRoute '${this.path}': root type '${this.rootType.cleanName}' is not a registered type`);
        return PropertyRoute.parse(ctor, this.path);
    }

    // Signum's `[AutoExpressionField] ToString() => Path`. @quoted so it ALSO lowers to SQL: this table has
    // no stored ToStr column, so without it every `Lite<PropertyRouteEntity>` read from a FK would arrive
    // with an empty toStr — the same treatment TypeEntity.toString and QueryEntity.toString get.
    @quoted
    override toString(): string {
        return this.path;
    }
}

export const PropertyRouteMessage = {
    Translated: msg("Translated"),
};
