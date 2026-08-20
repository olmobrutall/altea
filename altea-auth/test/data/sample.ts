import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, uniqueIndex, quoted, stringLengthValidator, backReference } from "@altea/altea/data/decorators";
import { type int, toInt } from "@altea/altea/data/basics";
import type { ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";
import { TypeConditionSymbol } from "@altea/altea-auth/data/Rules";

// A tiny, purpose-built domain for the authorization test suite (the altea analog of
// Signum.Test.Environment's own entities). One entity, one hidable property, one boolean that drives two
// mutually-exclusive row-level type conditions, and two operations — enough to exercise every dimension
// (type / property / operation / query) plus type conditions and the cross-role merge.

@reflect
@entity("Main", "Master")
export class SampleEntity extends Entity {
    @uniqueIndex
    @stringLengthValidator({ min: 1, max: 100 })
    name: string;

    // The property that property-authorization hides / makes read-only per role.
    secret: string = "";

    // Drives the row-level type conditions below: Confidential ⇔ true, Public ⇔ false.
    confidential: boolean = false;

    value: int = toInt(0);

    // Owned parts (Sample ← Panel[] ← Widget[]) — exercise the part-ownership inheritance + chaining.
    panels: SamplePanelEntity[];

    @quoted
    toString(): string {
        return this.name;
    }
}

// A Part of SampleEntity (array/back-reference). Hidden from the Type-Auth grid; inherits Sample's rules.
@reflect
@entity("Part")
export class SamplePanelEntity extends Entity {
    @backReference sample: Lite<SampleEntity>;
    title: string = "";
    secret: string = "";
    // A part of a part → tests the ownership CHAIN Widget → Panel → Sample.
    widgets: SampleWidgetEntity[];
}

@reflect
@entity("Part")
export class SampleWidgetEntity extends Entity {
    @backReference panel: Lite<SamplePanelEntity>;
    caption: string = "";
}

// Signum's `[AutoInit] static class SampleOperation`. The namespace name matters: OperationAuthLogic
// derives a type's operations from the `<Type>Operation.<Member>` key convention, so these become
// "SampleOperation.Save" / "SampleOperation.Delete" — attached to the "Sample" type.
export namespace SampleOperation {
    export const Save: ExecuteSymbol<SampleEntity> = init();
    export const Delete: DeleteSymbol<SampleEntity> = init();
}

// Row-level type conditions on SampleEntity (evaluated in-memory by the engine tests, and lowered to SQL
// by the query-filter path). Public and Confidential partition SampleEntity by the `confidential` flag.
export namespace SampleTypeCondition {
    export const Public: TypeConditionSymbol = init();
    export const Confidential: TypeConditionSymbol = init();
    // A DB-ONLY condition (registered without an in-memory predicate) — exercises the fillTypeConditions
    // SQL evaluation path (Signum's _typeConditions), unlike Public/Confidential which are registerCompile'd.
    export const HighValue: TypeConditionSymbol = init();
}
