import * as React from "react";
import type { Lite } from "@altea/altea/data/lite";
import type { TypeConditionSetModel, TypeConditionSymbol } from "../../data/Rules";
import { type Slice, sliceKey, shortCondition } from "./AuthSlice";

// The type-condition slice picker for the property / operation rule editors (Signum's TypeConditions
// <select>): "Fallback" plus one option per configured condition SET. Renders nothing when the type/role
// has no conditions (only the Fallback exists, so there is nothing to choose).
export function SliceSelector({ available, slice, onChange, className }: {
    available: TypeConditionSetModel[];
    slice: Slice;
    onChange: (s: Slice) => void;
    className?: string;
}): React.JSX.Element | null {
    if (available.length === 0)
        return null;
    const label = (tcs: Lite<TypeConditionSymbol>[]): string => tcs.map(shortCondition).join(" & ");
    return (
        <select className={"form-select form-select-sm " + (className ?? "")} style={{ maxWidth: "22rem" }}
            value={sliceKey(slice)}
            onChange={e => {
                const v = e.currentTarget.value;
                onChange(v === "" ? undefined : available.find(s => sliceKey(s.typeConditions) === v)?.typeConditions);
            }}>
            <option value="">Fallback</option>
            {available.map((s, i) => <option key={i} value={sliceKey(s.typeConditions)}>{label(s.typeConditions)}</option>)}
        </select>
    );
}
