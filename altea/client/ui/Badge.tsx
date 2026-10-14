import * as React from "react";
import { cn } from "./utils";

export type BadgeVariant = "primary" | "secondary" | "tertiary" | "success" | "destructive" | "warning" | "info" | "light" | "dark";

const variants: Record<BadgeVariant, string> = {
    primary: "bg-primary text-primary-foreground",
    secondary: "bg-secondary text-secondary-foreground",
    tertiary: "bg-tertiary text-tertiary-foreground",
    success: "bg-success text-success-foreground",
    destructive: "bg-destructive text-destructive-foreground",
    warning: "bg-warning text-warning-foreground",
    info: "bg-info text-info-foreground",
    light: "bg-light text-light-foreground",
    dark: "bg-dark text-dark-foreground",
};

export function Badge({ className, variant = "secondary", pill, ...props }: React.HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant, pill?: boolean }): React.ReactElement {
    return <span className={cn("sf-badge inline-flex items-center gap-1 px-[.65em] py-[.35em] text-[.75em] font-bold leading-none whitespace-nowrap align-baseline",
        pill ? "rounded-full" : "rounded-md", variants[variant], className)} {...props} />;
}
