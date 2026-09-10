import { reflect } from "@altea/altea/data/reflection";
import { MixinEntity, type Type } from "@altea/altea/data/entity";
import { MixinDeclarations } from "@altea/altea/data/mixinDeclarations";
import { stringLengthValidator, validate, ValidationMessage } from "@altea/altea/data/validators";
import type { IsolationStrategy } from "@altea/altea-isolation/data/Isolation";
import { DynamicTypeEntity } from "./DynamicType";

// Port of Signum.Dynamic's Isolation/DynamicIsolation.cs — which ISOLATION STRATEGY a dynamically defined
// type uses, so `DynamicIsolationLogic` can generate its `Isolation.register` call.
//
// A MIXIN, as in Signum, and for Signum's reason: @altea/altea-dynamic must not force an isolation column
// on the many applications that never use isolation, so the APP declares it (`DynamicIsolationMixin
// .declare()`) and the generator tolerates its absence. That is also why altea-dynamic merely DEPENDS on
// @altea/altea-isolation and never starts it — exactly the relationship Signum.Dynamic has with
// Signum.Isolation, and the one Southwind has (reference, never start).
//
// altea divergence, and it is the one thing here worth knowing: **the column stores the strategy's NAME**,
// where Signum stores its enum ordinal. altea's `IsolationStrategy` is deliberately a plain string union
// rather than a reflected enum — "never a stored column, so it needs no enum table", says
// altea-isolation/data/Isolation.ts, which this is the first thing to falsify. Giving the module a
// reflected enum for one consumer would add an enum table and touch every comparison in it; declaring a
// SECOND enum here would mean two spellings of one concept. So the field is a `string` restricted to the
// three names, which is what a definition-level setting wants anyway (it is read once, at generation).
@reflect
export class DynamicIsolationMixin extends MixinEntity {

    /** Defaults to `None`, as Signum's does. */
    @stringLengthValidator({ max: 20 })
    @validate<DynamicIsolationMixin>((e, fi) =>
        isolationStrategies.includes(e.isolationStrategy as IsolationStrategy) ? null
            : ValidationMessage._0DoesNotHaveAValid1Format.niceToString(
                fi.niceToString(), isolationStrategies.join(" / ")))
    isolationStrategy: string = "None";
}

/** The three values the field accepts — altea-isolation's own union, as an array the editor can offer. */
export const isolationStrategies: IsolationStrategy[] = ["Isolated", "Optional", "None"];

export namespace DynamicIsolationMixin {
    let declared = false;

    /**
     * Declare the mixin on DynamicTypeEntity. The APP calls this, as it calls Signum's
     * `MixinDeclarations.Register` — nothing in Signum.Dynamic does it either.
     *
     * Idempotent, and it must run on BOTH TIERS before anything is (de)serialized or the schema is built:
     * it is what tells the serializer and the schema builder that the field exists. Put the call next to
     * the app's other entity overrides, and expect a `sync` — the field is a new column on `dynamic_type`.
     */
    export function declare(): void {
        if (declared)
            return;
        declared = true;

        MixinDeclarations.register(
            DynamicTypeEntity,
            DynamicIsolationMixin);
    }

    export function isDeclared(): boolean {
        return declared;
    }
}
