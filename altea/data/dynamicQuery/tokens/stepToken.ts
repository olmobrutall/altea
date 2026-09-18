import type { PropertyRoute } from "../../propertyRoute";
import type { Implementations } from "../../implementations";
import { TypeReference } from "../../reflection";
import { Enum } from "../../enum";
import { registerEnum } from "../../registration";
import { QueryTokenMessage } from "../../dynamicQueries";
import { QueryToken, SubTokensOptions } from "./queryToken";

/**
 * Signum's `RoundingType` (DynamicQuery/Tokens/DecimalSpecialTokens.cs): WHICH end of a bucket a
 * value is snapped to when a number is quantized into steps.
 *
 * `Floor` / `Ceil` snap down / up, so a bucket is labelled by one of its own edges. `Round` snaps to
 * the NEAREST edge. `RoundMiddle` shifts the grid by half a step first, so the label lands in the
 * MIDDLE of the bucket it names — which is what a histogram wants on its axis: with step 10, values
 * 5…15 all answer 10, not "10 means 10-to-20".
 *
 * A string enum like its siblings in this folder (CollectionAnyAllType, AggregateFunction …): the
 * member name IS the token key and the wire value, and it is stored inside a user asset's token
 * string (`UnitPrice.Step1.x2_5.RoundMiddle`), so it must never be an ordinal.
 */
export enum RoundingType {
    Floor = "Floor",
    Ceil = "Ceil",
    Round = "Round",
    RoundMiddle = "RoundMiddle",
}

// Registered so the four member names are TRANSLATABLE — `StepRoundingToken.toString()` is a column
// HEADER. Hand-written because no entity field is of this type, and it creates no table (the schema
// builder only builds one where a FieldEnum references the type). Same reason as StringCase /
// DateTimePrecision in data/validators.ts.
registerEnum(RoundingType);

// A step/multiplier size spelled for a token KEY: invariant, and the decimal point replaced by "_"
// because a "." separates token segments (Signum's `ToString(InvariantCulture).Replace(".", "_")`).
function sizeKey(size: number): string {
    return String(size).replace(".", "_");
}

/**
 * Port of Signum's `StepToken`: the numeric value BUCKETED into steps of `stepSize` —
 * `ceil(x / 1000) * 1000`. It is what a chart groups a continuous measure by to get a histogram, the
 * numeric counterpart of `MonthStart` on a date.
 *
 * The three-level chain is Signum's, and is a UI affordance rather than three ideas: `Step 1000`
 * offers `x1 … x8` MULTIPLIERS (so 1500 and 2500 are reachable without listing every size), and each
 * multiplier offers the four ROUNDINGS. Every level is a complete, groupable token in its own right —
 * `Step1000` alone means `x1` and `Ceil` — and all three build their expression from the ORIGINAL
 * numeric token, never from the level above.
 */
export class StepToken extends QueryToken {
    constructor(private readonly _parent: QueryToken, public readonly stepSize: number) {
        super();
        this.priority = 1;
    }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return "Step" + sizeKey(this.stepSize); }
    override toString(): string { return QueryTokenMessage.Step0.niceToString(this.stepSize); }
    niceName(): string { return QueryTokenMessage._0Steps1.niceToString(this._parent.niceName(), this.stepSize); }

    // Signum's `Parent!.Type.Nullify()`: bucketing a number yields the same kind of number. Copied
    // rather than shared — the parent's TypeReference may be a live FieldInfo, which must not be mutated.
    get type(): TypeReference { return nullify(this._parent.type); }

    get format(): string | undefined { return this._parent.format; }
    get unit(): string | undefined { return this._parent.unit; }
    override get isGroupable(): boolean { return true; }
    getImplementations(): Implementations | undefined { return this._parent.getImplementations(); }
    getPropertyRoute(): PropertyRoute | undefined { return this._parent.getPropertyRoute(); }
    isAllowed(): string | null { return this._parent.isAllowed(); }

    protected subTokensOverride(_options: SubTokensOptions): QueryToken[] {
        return STEP_MULTIPLIERS.map(m => new StepMultiplierToken(this, m));
    }
}

// Signum's multiplier list. They are the "nice" bucket sizes between two powers of ten: 1000 × these
// gives 1000, 1200, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 8000.
const STEP_MULTIPLIERS: readonly number[] = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8];

/** Port of Signum's `StepMultiplierToken`: the parent step scaled by a "nice" factor. */
export class StepMultiplierToken extends QueryToken {
    constructor(private readonly _parent: StepToken, public readonly multiplier: number) {
        super();
    }

    /** The effective bucket size — what the expression actually divides by. */
    stepSizeValue(): number { return roundNoise(this._parent.stepSize * this.multiplier); }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return "x" + sizeKey(this.multiplier); }
    // Signum's literal "x1.5" — a multiplication SYMBOL, not a word, so there is nothing to localize.
    override toString(): string { return "x" + this.multiplier; }
    niceName(): string { return QueryTokenMessage._0Steps1.niceToString(this._parent.niceName(), this.stepSizeValue()); }
    get type(): TypeReference { return nullify(this._parent.type); }
    get format(): string | undefined { return this._parent.format; }
    get unit(): string | undefined { return undefined; }
    override get isGroupable(): boolean { return true; }
    getImplementations(): Implementations | undefined { return this._parent.getImplementations(); }
    getPropertyRoute(): PropertyRoute | undefined { return this._parent.getPropertyRoute(); }
    isAllowed(): string | null { return this._parent.isAllowed(); }

    protected subTokensOverride(_options: SubTokensOptions): QueryToken[] {
        return [RoundingType.Ceil, RoundingType.Floor, RoundingType.Round, RoundingType.RoundMiddle]
            .map(r => new StepRoundingToken(this, r));
    }
}

// The bracket pair Signum draws each rounding with, inside the NiceName: ⌈⌉ ceiling, ⌊⌋ floor,
// [] nearest, || nearest-with-the-label-in-the-middle.
const ROUNDING_BRACKETS: Readonly<Record<RoundingType, [string, string]>> = {
    [RoundingType.Ceil]: ["⌈", "⌉"],
    [RoundingType.Floor]: ["⌊", "⌋"],
    [RoundingType.Round]: ["[", "]"],
    [RoundingType.RoundMiddle]: ["|", "|"],
};

/** Port of Signum's `StepRoundingToken`: the multiplied step, snapped with an explicit RoundingType. */
export class StepRoundingToken extends QueryToken {
    constructor(private readonly _parent: StepMultiplierToken, public readonly rounding: RoundingType) {
        super();
    }

    /** The effective bucket size (the multiplier level's). */
    stepSizeValue(): number { return this._parent.stepSizeValue(); }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return this.rounding; }
    override toString(): string { return Enum.niceName(RoundingType, this.rounding); }
    niceName(): string {
        const [open, close] = ROUNDING_BRACKETS[this.rounding];
        return QueryTokenMessage._0Steps1.niceToString(this._parent.niceName(), open + this.stepSizeValue() + close);
    }
    get type(): TypeReference { return nullify(this._parent.type); }
    get format(): string | undefined { return this._parent.format; }
    get unit(): string | undefined { return undefined; }
    override get isGroupable(): boolean { return true; }
    getImplementations(): Implementations | undefined { return this._parent.getImplementations(); }
    getPropertyRoute(): PropertyRoute | undefined { return this._parent.getPropertyRoute(); }
    isAllowed(): string | null { return this._parent.isAllowed(); }

    protected subTokensOverride(_options: SubTokensOptions): QueryToken[] {
        return [];
    }
}

function nullify(type: TypeReference): TypeReference {
    return Object.assign(new TypeReference(), type, { isNullable: true });
}

// `0.001 * 1.2` is 0.0012000000000000001 in binary floating point, and that number would end up BOTH
// in the token key (`x1_2` is fine, but the SQL divisor is not) and in the SQL. Twelve significant
// digits is far beyond any step size offered here and clips the noise exactly.
function roundNoise(n: number): number {
    return Number(n.toPrecision(12));
}
