import * as React from "react";
import { cn } from "./utils";

/** altea's four form sizes — `StyleContext.formSize`. */
export type FormSize = "xs" | "sm" | "md" | "lg";

export const formControlSizes: Record<FormSize, string> = {
    xs: "px-[5px] py-[.5px] text-[.875em] rounded-sm",
    sm: "px-2 py-1 text-sm rounded-sm",
    md: "px-3 py-1.5 text-base rounded-md",
    lg: "px-4 py-2 text-xl rounded-lg",
};

/** Bootstrap's `.form-control` look: what a migrated input shares with one that is not migrated yet. */
export const formControlBase: string =
    "block w-full min-w-0 border-1 border-input bg-background text-foreground leading-normal " +
    "placeholder:text-muted-foreground transition-[border-color,box-shadow] " +
    "focus:outline-none focus:border-[color-mix(in_srgb,var(--primary)_50%,var(--background))] focus:ring-[.25rem] focus:ring-ring " +
    "disabled:bg-muted disabled:opacity-100 read-only:bg-muted " +
    "aria-invalid:border-destructive aria-invalid:focus:ring-destructive/25";

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
    size?: FormSize;
    ref?: React.Ref<HTMLInputElement>;
}

export function Input({ className, size = "md", type = "text", ...props }: InputProps): React.ReactElement {
    return <input type={type} className={cn("sf-form-control", formControlBase, formControlSizes[size], className)} {...props} />;
}

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
    size?: FormSize;
    ref?: React.Ref<HTMLTextAreaElement>;
}

export function Textarea({ className, size = "md", ...props }: TextareaProps): React.ReactElement {
    return <textarea className={cn("sf-form-control", formControlBase, formControlSizes[size], "min-h-[calc(1.5em+.75rem+2px)]", className)} {...props} />;
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>): React.ReactElement {
    return <label className={cn("sf-form-label mb-2 inline-block", className)} {...props} />;
}

/** An input with addons (`InputGroupText`, a `Button`) fused to its sides. */
export function InputGroup({ className, size = "md", ...props }: React.HTMLAttributes<HTMLDivElement> & { size?: FormSize }): React.ReactElement {
    return <div className={cn("sf-input-group relative flex w-full flex-nowrap items-stretch",
        "[&>*]:rounded-none [&>*:first-child]:rounded-s-[inherit] [&>*:last-child]:rounded-e-[inherit] [&>*:not(:first-child)]:-ms-px",
        "[&>.sf-form-control]:flex-auto [&>.sf-form-control]:w-[1%] [&>*:focus]:z-10",
        size === "lg" ? "rounded-lg" : size === "md" ? "rounded-md" : "rounded-sm", className)} {...props} />;
}

export function InputGroupText({ className, size = "md", ...props }: React.HTMLAttributes<HTMLSpanElement> & { size?: FormSize }): React.ReactElement {
    return <span className={cn("sf-input-group-text flex items-center whitespace-nowrap border-1 border-input bg-muted text-center",
        formControlSizes[size], className)} {...props} />;
}
