import * as React from "react";
import { Checkbox as CheckboxPrimitive, Switch as SwitchPrimitive, RadioGroup as RadioGroupPrimitive } from "radix-ui";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { cn } from "./utils";

const focus = "focus-visible:outline-none focus-visible:ring-[.25rem] focus-visible:ring-ring";

export type CheckboxProps = React.ComponentProps<typeof CheckboxPrimitive.Root>;

export function Checkbox({ className, ...props }: CheckboxProps): React.ReactElement {
    return (
        <CheckboxPrimitive.Root
            className={cn("sf-checkbox peer inline-flex size-4 shrink-0 items-center justify-center rounded-sm border-1 border-input bg-background align-[-.125em] cursor-pointer",
                "data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
                "data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground",
                "disabled:cursor-default disabled:opacity-50 aria-invalid:border-destructive", focus, className)}
            {...props}>
            <CheckboxPrimitive.Indicator className="flex items-center justify-center text-[.7rem]">
                <FontAwesomeIcon icon={props.checked === "indeterminate" ? "minus" : "check"} aria-hidden={true} />
            </CheckboxPrimitive.Indicator>
        </CheckboxPrimitive.Root>
    );
}

export type SwitchProps = React.ComponentProps<typeof SwitchPrimitive.Root>;

export function Switch({ className, ...props }: SwitchProps): React.ReactElement {
    return (
        <SwitchPrimitive.Root
            className={cn("sf-switch peer inline-flex h-4 w-8 shrink-0 items-center rounded-full border-1 border-input bg-background p-px align-[-.125em] cursor-pointer transition-colors",
                "data-[state=checked]:border-primary data-[state=checked]:bg-primary disabled:cursor-default disabled:opacity-50", focus, className)}
            {...props}>
            <SwitchPrimitive.Thumb className="pointer-events-none block size-3 rounded-full bg-muted-foreground transition-transform data-[state=checked]:translate-x-4 data-[state=checked]:bg-primary-foreground rtl:data-[state=checked]:-translate-x-4" />
        </SwitchPrimitive.Root>
    );
}

export const RadioGroup: typeof RadioGroupPrimitive.Root = RadioGroupPrimitive.Root;

export function RadioGroupItem({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Item>): React.ReactElement {
    return (
        <RadioGroupPrimitive.Item
            className={cn("sf-radio inline-flex size-4 shrink-0 items-center justify-center rounded-full border-1 border-input bg-background align-[-.125em] cursor-pointer",
                "data-[state=checked]:border-primary data-[state=checked]:bg-primary disabled:cursor-default disabled:opacity-50", focus, className)}
            {...props}>
            <RadioGroupPrimitive.Indicator className="block size-1.5 rounded-full bg-primary-foreground" />
        </RadioGroupPrimitive.Item>
    );
}
