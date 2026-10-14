import * as React from "react";
import { Progress as ProgressPrimitive } from "radix-ui";
import { JavascriptMessage } from "../../data/uiMessages";
import { cn } from "./utils";

export interface ProgressProps {
    /** 0–100; null for an indeterminate bar. */
    value: number | null;
    label?: React.ReactNode;
    variant?: "primary" | "success" | "destructive" | "warning" | "info";
    striped?: boolean;
    className?: string;
}

const variants = {
    primary: "bg-primary text-primary-foreground",
    success: "bg-success text-success-foreground",
    destructive: "bg-destructive text-destructive-foreground",
    warning: "bg-warning text-warning-foreground",
    info: "bg-info text-info-foreground",
};

export function Progress({ value, label, variant = "primary", striped, className }: ProgressProps): React.ReactElement {
    return (
        <ProgressPrimitive.Root value={value} className={cn("sf-progress relative flex h-4 overflow-hidden rounded-md bg-muted text-xs", className)}>
            <ProgressPrimitive.Indicator
                className={cn("flex items-center justify-center overflow-hidden whitespace-nowrap transition-[width]", variants[variant],
                    (striped || value == null) && "bg-[linear-gradient(45deg,rgb(255_255_255/.15)_25%,transparent_25%,transparent_50%,rgb(255_255_255/.15)_50%,rgb(255_255_255/.15)_75%,transparent_75%,transparent)] bg-[length:1rem_1rem]",
                    value == null && "animate-pulse")}
                style={{ width: value == null ? "100%" : `${Math.max(0, Math.min(100, value))}%` }}>
                {label}
            </ProgressPrimitive.Indicator>
        </ProgressPrimitive.Root>
    );
}

export function Spinner({ className, size = "md" }: { className?: string, size?: "sm" | "md" }): React.ReactElement {
    return (
        <span role="status" className={cn("sf-spinner inline-block animate-spin rounded-full border-solid border-current border-e-transparent align-[-.125em]",
            size === "sm" ? "size-4 border-2" : "size-8 border-4", className)}>
            <span className="sr-only">{JavascriptMessage.loading.niceToString()}</span>
        </span>
    );
}

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
    return <div aria-hidden={true} className={cn("sf-skeleton animate-pulse rounded-md bg-muted", className)} {...props} />;
}
