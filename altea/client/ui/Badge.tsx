import * as React from "react";
import { cn } from "./utils";

export type BadgeVariant = "primary" | "secondary" | "tertiary" | "success" | "destructive" | "warning" | "info" | "light" | "dark";

/** The semantic badge (`sf-badge sf-badge-<variant>`, semantic.css), so a design restyles every badge in one place;
 *  the kit only adds the icon layout. */
export function Badge({ className, variant = "secondary", pill, ...props }: React.HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant, pill?: boolean }): React.ReactElement {
    return <span className={cn("sf-badge inline-flex items-center gap-1", "sf-badge-" + variant, pill && "sf-badge-pill", className)} {...props} />;
}
