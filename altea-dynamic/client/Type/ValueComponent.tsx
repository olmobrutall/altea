import * as React from "react";
import { Binding } from "@altea/altea/client/binding";
import { classes } from "@altea/altea/data/globals/helpers";

/** Signum's DynamicTypeDesignContext — the one thing every editor here needs: "re-render me". */
export interface DynamicTypeDesignContext {
    refreshView: () => void;
}

export interface ValueComponentProps {
    binding: Binding<any>;
    dc: DynamicTypeDesignContext;
    type: "number" | "string" | "boolean" | "textArea" | null;
    options?: (string | number)[];
    labelClass?: string;
    defaultValue: number | string | boolean | null;
    avoidDelete?: boolean;
    hideLabel?: boolean;
    labelColumns?: number;
    autoOpacity?: boolean;
    onBlur?: () => void;
    onChange?: () => void;
}

// Port of Signum.Dynamic's Type/ValueComponent.tsx — verbatim.
//
// It exists because the type DEFINITION is a JSON document, not an entity: there is no PropertyRoute to
// hang an altea `AutoLine` off, so every field of the editor is a Binding onto a plain object. The one
// behaviour worth naming is `defaultValue` + `deleteValue`: writing the default DELETES the key, which is
// what keeps a stored definition free of noise (`{"identity": true}` and `{}` mean the same thing, so only
// one is stored).
export default function ValueComponent(p: ValueComponentProps): React.JSX.Element {

    function updateValue(value: string | boolean | undefined): void {
        let parsedValue: unknown = p.type !== "number" ? value
            : (isNaN(parseFloat(value as string)) ? null : parseFloat(value as string));

        if (parsedValue === "")
            parsedValue = null;

        if (parsedValue == p.defaultValue && !p.avoidDelete)
            p.binding.deleteValue();
        else
            p.binding.setValue(parsedValue);

        p.onChange?.();
        p.dc.refreshView();
    }

    function handleChangeCheckbox(e: React.ChangeEvent<HTMLInputElement>): void {
        updateValue(e.currentTarget.checked);
    }

    function handleChangeSelectOrInput(e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement | HTMLTextAreaElement>): void {
        updateValue(e.currentTarget.value);
    }

    function renderValue(value: number | string | boolean | null | undefined): React.JSX.Element {
        const val = value === undefined ? p.defaultValue : value;
        const style = p.hideLabel ? { display: "inline-block" } as React.CSSProperties : undefined;

        if (p.options != null) {
            return (
                <select className="form-control form-control-sm" style={style} onBlur={p.onBlur}
                    value={val == null ? "" : val.toString()} onChange={handleChangeSelectOrInput}>
                    {val == null && <option value="">{" - "}</option>}
                    {p.options.map((o, i) => <option key={i} value={o.toString()}>{o.toString()}</option>)}
                </select>
            );
        }

        if (p.type === "boolean") {
            return (
                <input type="checkbox" onBlur={p.onBlur} className="form-check-input"
                    checked={value === undefined ? p.defaultValue as boolean : value as boolean}
                    onChange={handleChangeCheckbox} />
            );
        }

        if (p.type === "textArea") {
            return (
                <textarea className="form-control form-control-sm" style={style} onBlur={p.onBlur}
                    value={val == null ? "" : val.toString()} onChange={handleChangeSelectOrInput} />
            );
        }

        return (
            <input className="form-control form-control-sm" style={style} onBlur={p.onBlur} type="text"
                value={val == null ? "" : val.toString()} onChange={handleChangeSelectOrInput} />
        );
    }

    const value = p.binding.getValue();
    const opacity = p.autoOpacity === true && value == null ? { opacity: 0.5 } as React.CSSProperties : undefined;

    if (p.hideLabel === true) {
        return (
            <div className="row align-items-center">
                <div className="col-auto">
                    {renderValue(value)}
                </div>
            </div>
        );
    }

    const lc = p.labelColumns;

    return (
        <div className="form-group form-group-sm row" style={opacity}>
            <label className={classes("col-form-label col-form-label-sm", p.labelClass, "col-sm-" + (lc == null ? 2 : lc))}>
                {p.binding.member}
            </label>
            <div className={"col-sm-" + (lc == null ? 10 : 12 - lc)}>
                {renderValue(value)}
            </div>
        </div>
    );
}
