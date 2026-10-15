import * as React from "react";
import { Select as SelectPrimitive } from "radix-ui";
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
        <SelectPrimitive.Root value={p.value ?? undefined} onValueChange={v => p.onChange(v as T)} disabled={p.disabled}>
            <SelectPrimitive.Trigger id={p.id} aria-label={p["aria-label"]} aria-labelledby={p["aria-labelledby"]} aria-invalid={p["aria-invalid"]}
                className={cn(formSelectClass(size), "text-start cursor-pointer data-[placeholder]:text-muted-foreground", p.className)}>
                <span className="block truncate"><SelectPrimitive.Value placeholder={p.placeholder} /></span>
            </SelectPrimitive.Trigger>
            <SelectPrimitive.Portal>
                <SelectPrimitive.Content position="popper" sideOffset={2}
                    className={cn("sf-select-content z-[1060] max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) overflow-y-auto rounded-md border-1 bg-popover p-1 text-popover-foreground shadow-md",
                        size === "xs" || size === "sm" ? "text-sm" : "text-base")}>
                    <SelectPrimitive.Viewport>
                        {p.options.map(o =>
                            <SelectPrimitive.Item key={o.value} value={o.value} disabled={o.disabled}
                                className="relative flex cursor-pointer select-none items-center rounded-sm py-1 ps-7 pe-2 outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50">
                                <SelectPrimitive.ItemIndicator className="absolute start-2 inline-flex">
                                    <FontAwesomeIcon icon="check" className="text-[.75em]" aria-hidden={true} />
                                </SelectPrimitive.ItemIndicator>
                                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                            </SelectPrimitive.Item>)}
                    </SelectPrimitive.Viewport>
                </SelectPrimitive.Content>
            </SelectPrimitive.Portal>
        </SelectPrimitive.Root>
    );
}
