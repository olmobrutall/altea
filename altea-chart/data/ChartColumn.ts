import { reflect, field } from "@altea/altea/data/reflection";
import { EmbeddedEntity } from "@altea/altea/data/entity";
import { validate, ValidationMessage } from "@altea/altea/data/validators";
import { type int } from "@altea/altea/data/basics";
import { OrderType } from "@altea/altea/data/dynamicQueries";
import { QueryTokenEmbedded } from "@altea/altea-user-assets/data/Queries";
import { enumColumn } from "@altea/altea-user-assets/data/UserAssets";
import type { ChartScriptColumn } from "./ChartScriptColumn";
import type { IChartBase } from "./ChartRequest";
import { isChartColumnType } from "./ChartUtils";
import { ChartColumnType } from "./ChartScriptColumn";
import { ChartMessage } from "./ChartMessage";

// Port of Signum.Chart/ChartColumn.cs. One column of a chart: the query token bound to a ScriptColumn slot,
// plus display name / format / ordering. altea divergences documented inline.
@reflect
export class ChartColumnEmbedded extends EmbeddedEntity {
    // Signum's `[Ignore] ChartScriptColumn ScriptColumn` — the runtime-bound slot definition (set by
    // synchronizeColumns). `@field(false)`: pure runtime scratch, not part of the reflected model (no DB
    // column, no serialization, no type metadata — so its plain-class type stays an `import type`).
    @field(false)
    scriptColumn: ChartScriptColumn | null;

    // Signum's `[Ignore] IChartBase parentChart` back-reference. `@field(false)` — runtime scratch only.
    @field(false)
    parentChart: IChartBase | null;

    // Signum's `QueryTokenEmbedded? Token`. altea has no property setters, so Signum's setter side effect
    // (TokenChanged) is invoked explicitly by the editor (see tokenChanged()). Signum's PropertyValidation
    // for Token lives here: required unless the slot is optional, and (once resolved) the token's
    // ChartColumnType must be compatible with the slot's ColumnType.
    @validate<ChartColumnEmbedded>(c => {
        if (c.token == null)
            return c.scriptColumn != null && !c.scriptColumn.isOptional
                ? ChartMessage._0IsNotOptional.niceToString(c.scriptColumn.getDisplayName())
                : null;

        if (c.scriptColumn != null && c.token.token != null && !isChartColumnType(c.token.token, c.scriptColumn.columnType))
            // altea: Signum formats this with `DisplayName` alone, which is null until the user renames the
            // column — so the message reads " is not AnyGroupKey". Fall back to the token's nice name, which
            // is what actually doesn't fit (the offending slot is already reddened by ChartColumn.tsx).
            return ChartMessage._0IsNot1.niceToString(c.displayName ?? c.token.token.niceName(), ChartColumnType[c.scriptColumn.columnType]);

        return null;
    })
    token: QueryTokenEmbedded | null;

    // Signum's `[Translatable] string? DisplayName`.
    displayName: string | null;

    format: string | null;

    // Signum's `[NumberIsValidator(GreaterThan, 0)] int? OrderByIndex`.
    @validate<ChartColumnEmbedded>(c =>
        c.orderByIndex != null && c.orderByIndex <= 0
            ? ValidationMessage.NumberIsTooSmall.niceToString()
            : null)
    orderByIndex: int | null;

    // Signum's `OrderType? OrderByType`. Stored as the member-name string (see enumColumn).
    @enumColumn()
    // A REFLECTED enum, so the column is an FK to the enum table (`OrderByTypeID`) as Signum's
    // `OrderType? OrderByType` is. It was typed `OrderTypeKeys` — the string UNION — which the
    // transformer sees as a plain string, giving a varchar `OrderByType` column instead. The field
    // therefore holds the ORDINAL: compare through `OrderType.Ascending`, and cross to a NAME with
    // `Enum.toName` wherever it meets a DTO (a ChartColumnOption, the url, the XML, an OrderRequest).
    orderByType: OrderType | null;

    // Signum's TokenChanged(): re-fix column-bound parameters and clear the (now stale) display name/format.
    // Invoked by the editor when the token changes (altea has no property setters).
    tokenChanged(): void {
        this.parentChart?.fixParameters(this);

        if (this.token != null) {
            this.displayName = null;
            this.format = null;
        }
    }

    // Signum's GetTitle(): "DisplayName (unit)".
    getTitle(): string {
        const unit = this.token?.token?.unit;
        return (this.displayName ?? "") + (unit ? ` (${unit})` : "");
    }

    toString(): string {
        return this.token?.toString() ?? "";
    }

    /** Signum's ChartColumnEmbedded.Clone(). `scriptColumn` / `parentChart` are runtime scratch
     *  (`@field(false)`), re-bound by synchronizeColumns, so a clone starts without them. */
    clone(): ChartColumnEmbedded {
        return ChartColumnEmbedded.create({
            token: this.token?.clone() ?? null,
            displayName: this.displayName,
            format: this.format,
            orderByIndex: this.orderByIndex,
            orderByType: this.orderByType,
        });
    }
}
