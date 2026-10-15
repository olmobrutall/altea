import * as React from "react";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { cn } from "./utils";
import { formSelectClass, type FormSize } from "./Input";

export interface SelectOption<T extends string = string> {
    value: T;
    label: React.ReactNode;
    disabled?: boolean;
}

export interface SelectProps<T extends string = string> {
    value: T | null | undefined;
    onChange: (value: T) => void;
    options: SelectOption<T>[];
    placeholder?: React.ReactNode;
    size?: FormSize;
    disabled?: boolean;
    id?: string;
    className?: string;
    "aria-label"?: string;
    "aria-labelledby"?: string;
    "aria-invalid"?: boolean;
}

/** A short list without filtering. A long or searchable one is a `Combobox`. */
export function Select<T extends string = string>(p: SelectProps<T>): React.ReactElement {
    const size = p.size ?? "md";
    return (
        <SelectPrimitive.Root value={p.value ?? null} onValueChange={v => { if (v != null) p.onChange(v as T); }} disabled={p.disabled}
            items={p.options.map(o => ({ label: o.label, value: o.value }))}>
            <SelectPrimitive.Trigger id={p.id} aria-label={p["aria-label"]} aria-labelledby={p["aria-labelledby"]} aria-invalid={p["aria-invalid"]}
                className={cn(formSelectClass(size), "text-start cursor-pointer data-[placeholder]:text-muted-foreground", p.className)}>
                <SelectPrimitive.Value placeholder={p.placeholder} className="block truncate" />
            </SelectPrimitive.Trigger>
            <SelectPrimitive.Portal>
                <SelectPrimitive.Positioner alignItemWithTrigger={false} sideOffset={2} className="z-[1070]">
                    <SelectPrimitive.Popup
                        className={cn("sf-select-content max-h-(--available-height) min-w-(--anchor-width) overflow-y-auto rounded-md border-1 bg-popover p-1 text-popover-foreground shadow-md outline-none",
                            size === "xs" || size === "sm" ? "text-sm" : "text-base")}>
                        {p.options.map(o =>
                            <SelectPrimitive.Item key={o.value} value={o.value} disabled={o.disabled}
                                className="relative flex cursor-pointer select-none items-center rounded-sm py-1 ps-7 pe-2 outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50">
                                <SelectPrimitive.ItemIndicator className="absolute start-2 inline-flex">
                                    <FontAwesomeIcon icon="check" className="text-[.75em]" aria-hidden={true} />
                                </SelectPrimitive.ItemIndicator>
                                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                            </SelectPrimitive.Item>)}
                    </SelectPrimitive.Popup>
                </SelectPrimitive.Positioner>
            </SelectPrimitive.Portal>
        </SelectPrimitive.Root>
    );
}
