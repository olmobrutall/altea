import { reflect, field } from "@altea/altea/data/reflection";
import { EmbeddedEntity } from "@altea/altea/data/entity";
import { stringLengthValidator, validate, ValidationMessage, ComparisonType } from "@altea/altea/data/validators";
import { Enum } from "@altea/altea/data/enum";
import type { ChartScriptParameter } from "./ChartScriptParameter";
import type { IChartBase } from "./ChartRequest";

// Port of Signum.Chart/ChartParameter.cs. One tunable parameter value of a chart: a Name (matching its
// ScriptParameter) and a string Value validated by that ScriptParameter's value-definition.
@reflect
export class ChartParameterEmbedded extends EmbeddedEntity {
    // Signum's `[Ignore] IChartBase parentChart` back-reference. `@field(false)` — runtime scratch only
    // (not part of the reflected model), so its interface type stays an `import type`.
    @field(false)
    parentChart: IChartBase | null;

    // Signum's `[Ignore, InTypeScript(false)] ChartScriptParameter ScriptParameter` — the runtime-bound
    // definition (set by synchronizeColumns). `@field(false)` — runtime scratch only.
    @field(false)
    scriptParameter: ChartScriptParameter | null;

    // Signum's `[StringLengthValidator(Min = 3, Max = 100)] string Name`. Must match ScriptParameter.Name.
    @validate<ChartParameterEmbedded>((p, fi) =>
        p.scriptParameter != null && p.name !== p.scriptParameter.name
            ? ValidationMessage._0ShouldBe12.niceToString(
                fi.niceToString(), Enum.niceName(ComparisonType, "EqualTo"), p.scriptParameter.name)
            : null)
    @stringLengthValidator({ min: 3, max: 100 })
    name: string;

    // Signum's `[StringLengthValidator(Max = 500)] string? Value`, validated by the ScriptParameter.
    @validate<ChartParameterEmbedded>(p =>
        p.scriptParameter != null
            ? p.scriptParameter.validate(p.value ?? null, p.scriptParameter.getToken(p.parentChart!))
            : null)
    @stringLengthValidator({ max: 500 })
    value: string | null;

    toString(): string {
        return this.name + ": " + this.value;
    }

    /** Signum's ChartParameterEmbedded.Clone(). */
    clone(): ChartParameterEmbedded {
        return ChartParameterEmbedded.create({ name: this.name, value: this.value });
    }
}
