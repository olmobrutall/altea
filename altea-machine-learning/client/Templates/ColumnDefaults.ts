import type { QueryToken } from "@altea/altea/client/QueryToken";
import {
    DefaultColumnEncodings, PredictorColumnNullHandling,
    type PredictorEntity_Column, type PredictorSubQueryEntity_Column,
} from "../../data/Predictor";

// Signum keeps `initializeColumn` inside Templates/Predictor.tsx and imports it from
// Templates/PredictorSubQuery.tsx — a module CYCLE, which survives there only because a function
// declaration is hoisted. It is a standalone decision about one column, so here it is its own module.

/**
 * Signum's `initializeColumn` — the encoding a freshly picked token should default to.
 *
 * The rule is the one thing a designer would otherwise get wrong on every column: a NUMBER wants
 * z-score normalization (a network fed raw prices learns almost nothing about a raw count beside it), a
 * BOOLEAN is already a number in [0,1] so it wants none, and anything else — an enum, a lite, a string —
 * has no meaningful magnitude and must become one slot per value.
 */
export function initializeColumn(
    column: PredictorEntity_Column | PredictorSubQueryEntity_Column,
    token: QueryToken | null | undefined,
): void {
    if (token == null)
        return;

    const typeName = token.type.typeName;

    column.encoding =
        typeName === "Number" || typeName === "Decimal" ? DefaultColumnEncodings.NormalizeZScore :
            typeName === "Boolean" ? DefaultColumnEncodings.None :
                DefaultColumnEncodings.OneHot;

    column.nullHandling = PredictorColumnNullHandling.Zero;
}
