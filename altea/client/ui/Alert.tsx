import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { JavascriptMessage } from "../../data/uiMessages";
import { cn } from "./utils";

export type AlertVariant = "primary" | "secondary" | "success" | "destructive" | "warning" | "info" | "light" | "dark";

const variants: Record<AlertVariant, string> = {
    primary: "border-primary/30 bg-primary/10 text-primary",
    secondary: "border-secondary/30 bg-secondary/10 text-foreground",
    success: "border-success/30 bg-success/10 text-success",
    destructive: "border-destructive/30 bg-destructive/10 text-destructive",
    warning: "border-warning/50 bg-warning/15 text-foreground",
    info: "border-info/40 bg-info/10 text-foreground",
    light: "border-border bg-light text-light-foreground",
    dark: "border-dark bg-dark/10 text-foreground",
};

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
    variant?: AlertVariant;
    /** Shows a close button. */
    onClose?: () => void;
}

export function Alert({ className, variant = "info", onClose, children, ...props }: AlertProps): React.ReactElement {
    return (
        <div role="alert" className={cn("sf-alert relative mb-4 rounded-md border-1 px-4 py-4", onClose && "pe-12", variants[variant], className)} {...props}>
            {children}
            {onClose && <CloseButton className="absolute end-2 top-2" onClick={onClose} />}
        </div>
    );
}

export function AlertTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>): React.ReactElement {
    return <h4 className={cn("sf-alert-title mb-2 text-h4 font-medium text-inherit", className)} {...props} />;
}

export function CloseButton({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>): React.ReactElement {
    return (
        <button type="button" aria-label={JavascriptMessage.Close.niceToString()}
            className={cn("sf-close-button inline-flex size-8 border-0 text-inherit items-center justify-center rounded-md bg-transparent opacity-50 hover:opacity-75 cursor-pointer focus-visible:outline-none focus-visible:ring-[.25rem] focus-visible:ring-ring", className)}
            {...props}>
            <FontAwesomeIcon icon="xmark" aria-hidden={true} />
        </button>
    );
}
