import * as React from "react";
import { cn } from "./utils";

/** altea's four form sizes — `StyleContext.formSize`. */
export type FormSize = "xs" | "sm" | "md" | "lg";

/** The semantic classes a text field wears — the same ones a Line's `StyleContext` hands out. */
export function formControlClass(size: FormSize = "md"): string {
    return `sf-form-control sf-form-control-${size}`;
}

/** The semantic classes of a field that opens a list. */
export function formSelectClass(size: FormSize = "md"): string {
    return `sf-form-select sf-form-select-${size}`;
}

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
    size?: FormSize;
    ref?: React.Ref<HTMLInputElement>;
}

export function Input({ className, size = "md", type = "text", ...props }: InputProps): React.ReactElement {
    return <input type={type} className={cn(formControlClass(size), className)} {...props} />;
}

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
    size?: FormSize;
    ref?: React.Ref<HTMLTextAreaElement>;
}

export function Textarea({ className, size = "md", ...props }: TextareaProps): React.ReactElement {
    return <textarea className={cn(formControlClass(size), className)} {...props} />;
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>): React.ReactElement {
    return <label className={cn("sf-form-label", className)} {...props} />;
}

/** An input with addons (`InputGroupText`, a `Button`) fused to its sides. */
export function InputGroup({ className, size = "md", ...props }: React.HTMLAttributes<HTMLDivElement> & { size?: FormSize }): React.ReactElement {
    return <div className={cn("sf-input-group", `sf-input-group-${size}`, className)} {...props} />;
}

export function InputGroupText({ className, ...props }: React.HTMLAttributes<HTMLSpanElement> & { size?: FormSize }): React.ReactElement {
    return <span className={cn("sf-input-group-text", className)} {...props} />;
}
