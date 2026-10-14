import * as React from "react";
import { cn } from "./utils";

type DivProps = React.HTMLAttributes<HTMLDivElement>;

export function Card({ className, ...props }: DivProps): React.ReactElement {
    return <div className={cn("sf-card flex min-w-0 flex-col rounded-md border-1 bg-card text-card-foreground", className)} {...props} />;
}

export function CardHeader({ className, ...props }: DivProps): React.ReactElement {
    return <div className={cn("sf-card-header border-b bg-muted/40 px-4 py-2 first:rounded-t-md", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>): React.ReactElement {
    return <h5 className={cn("sf-card-title mb-2 text-h5 font-medium", className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>): React.ReactElement {
    return <p className={cn("sf-card-description text-sm text-muted-foreground", className)} {...props} />;
}

export function CardContent({ className, ...props }: DivProps): React.ReactElement {
    return <div className={cn("sf-card-body flex-auto p-4", className)} {...props} />;
}

export function CardFooter({ className, ...props }: DivProps): React.ReactElement {
    return <div className={cn("sf-card-footer border-t bg-muted/40 px-4 py-2 last:rounded-b-md", className)} {...props} />;
}
