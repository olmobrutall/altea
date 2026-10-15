import * as React from "react";
import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import { JavascriptMessage } from "../../data/uiMessages";
import { cn } from "./utils";

export interface ProgressProps {
    /** Between `min` and `max` (0–100 by default); null for an indeterminate bar. */
    value: number | null;
    min?: number;
    max?: number;
    /** Moving stripes. */
    animated?: boolean;
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

export function Progress({ value, min = 0, max = 100, label, variant = "primary", striped, animated, className }: ProgressProps): React.ReactElement {
    const percent = value == null ? null : max === min ? 100 : (value - min) / (max - min) * 100;
    return (
        <ProgressPrimitive.Root value={percent} className={cn("sf-progress relative h-4 overflow-hidden rounded-md bg-muted text-xs", className)}>
            <ProgressPrimitive.Track className="flex h-full w-full">
            <ProgressPrimitive.Indicator
                className={cn("flex items-center justify-center overflow-hidden whitespace-nowrap transition-[width]", variants[variant],
                    (striped || animated || percent == null) && "bg-[linear-gradient(45deg,rgb(255_255_255/.15)_25%,transparent_25%,transparent_50%,rgb(255_255_255/.15)_50%,rgb(255_255_255/.15)_75%,transparent_75%,transparent)] bg-[length:1rem_1rem]",
                    (animated || percent == null) && "animate-pulse")}
                style={{ width: percent == null ? "100%" : `${Math.max(0, Math.min(100, percent))}%` }}>
                {label}
            </ProgressPrimitive.Indicator>
            </ProgressPrimitive.Track>
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
