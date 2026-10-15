import * as React from "react";
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { Radio } from "@base-ui/react/radio";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { cn } from "./utils";

const focus = "focus-visible:outline-none focus-visible:ring-[.25rem] focus-visible:ring-ring";

export interface CheckboxProps extends Omit<React.ComponentProps<typeof CheckboxPrimitive.Root>, "checked" | "onCheckedChange" | "className"> {
    checked?: boolean | "indeterminate";
    onCheckedChange?: (checked: boolean) => void;
    className?: string;
}

export function Checkbox({ className, checked, onCheckedChange, ...props }: CheckboxProps): React.ReactElement {
    const indeterminate = checked === "indeterminate";
    return (
        <CheckboxPrimitive.Root
            checked={indeterminate ? false : checked}
            indeterminate={indeterminate}
            onCheckedChange={c => onCheckedChange?.(c)}
            className={cn("sf-checkbox peer inline-flex size-4 shrink-0 items-center justify-center rounded-sm border-1 border-input bg-background align-[-.125em] cursor-pointer",
                "data-[checked]:border-primary data-[checked]:bg-primary data-[checked]:text-primary-foreground",
                "data-[indeterminate]:border-primary data-[indeterminate]:bg-primary data-[indeterminate]:text-primary-foreground",
                "data-[disabled]:cursor-default data-[disabled]:opacity-50 aria-invalid:border-destructive", focus, className)}
            {...props}>
            <CheckboxPrimitive.Indicator className="flex items-center justify-center text-[.7rem]">
                <FontAwesomeIcon icon={indeterminate ? "minus" : "check"} aria-hidden={true} />
            </CheckboxPrimitive.Indicator>
        </CheckboxPrimitive.Root>
    );
}

export interface SwitchProps extends Omit<React.ComponentProps<typeof SwitchPrimitive.Root>, "onCheckedChange" | "className"> {
    onCheckedChange?: (checked: boolean) => void;
    className?: string;
}

export function Switch({ className, onCheckedChange, ...props }: SwitchProps): React.ReactElement {
    return (
        <SwitchPrimitive.Root
            onCheckedChange={c => onCheckedChange?.(c)}
            className={cn("sf-switch peer inline-flex h-4 w-8 shrink-0 items-center rounded-full border-1 border-input bg-background p-px align-[-.125em] cursor-pointer transition-colors",
                "data-[checked]:border-primary data-[checked]:bg-primary data-[disabled]:cursor-default data-[disabled]:opacity-50", focus, className)}
            {...props}>
            <SwitchPrimitive.Thumb className="pointer-events-none block size-3 rounded-full bg-muted-foreground transition-transform data-[checked]:translate-x-4 data-[checked]:bg-primary-foreground rtl:data-[checked]:-translate-x-4" />
        </SwitchPrimitive.Root>
    );
}

export interface RadioGroupProps extends Omit<React.ComponentProps<typeof RadioGroupPrimitive>, "className" | "onValueChange"> {
    onValueChange?: (value: string) => void;
    className?: string;
}

export function RadioGroup({ className, onValueChange, ...props }: RadioGroupProps): React.ReactElement {
    return <RadioGroupPrimitive className={className} onValueChange={v => onValueChange?.(v as string)} {...props} />;
}

export function RadioGroupItem({ className, ...props }: Omit<React.ComponentProps<typeof Radio.Root>, "className"> & { className?: string }): React.ReactElement {
    return (
        <Radio.Root
            className={cn("sf-radio inline-flex size-4 shrink-0 items-center justify-center rounded-full border-1 border-input bg-background align-[-.125em] cursor-pointer",
                "data-[checked]:border-primary data-[checked]:bg-primary data-[disabled]:cursor-default data-[disabled]:opacity-50", focus, className)}
            {...props}>
            <Radio.Indicator className="block size-1.5 rounded-full bg-primary-foreground" />
        </Radio.Root>
    );
}
