import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "./utils";

const outlineTone = {
    primary: "border-primary text-primary hover:bg-primary hover:text-primary-foreground",
    secondary: "border-secondary text-secondary hover:bg-secondary hover:text-secondary-foreground",
    success: "border-success text-success hover:bg-success hover:text-success-foreground",
    destructive: "border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground",
    warning: "border-warning text-warning hover:bg-warning hover:text-warning-foreground",
    info: "border-info text-info hover:bg-info hover:text-info-foreground",
    dark: "border-dark text-dark hover:bg-dark hover:text-dark-foreground",
};

/** Bootstrap's button metrics, so a migrated toolbar lines up with one that is not migrated yet. */
export const buttonVariants: (props?: ButtonVariantProps) => string = cva(
    "sf-button inline-flex items-center justify-center gap-1.5 whitespace-nowrap border-1 border-transparent font-normal " +
    "leading-normal select-none cursor-pointer transition-colors " +
    "focus-visible:outline-none focus-visible:ring-[.25rem] focus-visible:ring-ring " +
    "disabled:pointer-events-none disabled:opacity-65 aria-disabled:pointer-events-none aria-disabled:opacity-65 " +
    "[&_svg]:shrink-0",
    {
        variants: {
            variant: {
                primary: "bg-primary text-primary-foreground hover:bg-primary/90",
                secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/90",
                tertiary: "bg-tertiary text-tertiary-foreground hover:bg-[color-mix(in_srgb,var(--tertiary)_90%,var(--foreground))]",
                success: "bg-success text-success-foreground hover:bg-success/90",
                destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
                warning: "bg-warning text-warning-foreground hover:bg-warning/90",
                info: "bg-info text-info-foreground hover:bg-info/90",
                light: "bg-light text-light-foreground hover:bg-[color-mix(in_srgb,var(--light)_90%,black)]",
                dark: "bg-dark text-dark-foreground hover:bg-dark/90",
                outline: "bg-transparent",
                ghost: "bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground",
                link: "bg-transparent text-primary underline hover:text-primary/80",
            },
            tone: {
                primary: "", secondary: "", success: "", destructive: "", warning: "", info: "", dark: "",
            },
            size: {
                xs: "px-[.2rem] py-0 text-[.875em] rounded-sm",
                sm: "px-2 py-1 text-sm rounded-sm",
                md: "px-3 py-1.5 text-base rounded-md",
                lg: "px-4 py-2 text-xl rounded-lg",
                icon: "size-8 p-0 rounded-md",
            },
        },
        compoundVariants: (["primary", "secondary", "success", "destructive", "warning", "info", "dark"] as const).map(tone => ({
            variant: "outline" as const,
            tone,
            className: outlineTone[tone],
        })),
        defaultVariants: { variant: "primary", size: "md" },
    });

export interface ButtonVariantProps {
    variant?: "primary" | "secondary" | "tertiary" | "success" | "destructive" | "warning" | "info" | "light" | "dark" | "outline" | "ghost" | "link" | null;
    /** The colour of an `outline` button. */
    tone?: "primary" | "secondary" | "success" | "destructive" | "warning" | "info" | "dark" | null;
    size?: "xs" | "sm" | "md" | "lg" | "icon" | null;
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, ButtonVariantProps {
    /** Render the single child (a link, say) with the button's look instead of a <button>. */
    asChild?: boolean;
    ref?: React.Ref<HTMLButtonElement>;
}

export function Button({ className, variant, tone, size, asChild, type, ...props }: ButtonProps): React.ReactElement {
    const classes = cn(buttonVariants({ variant, tone: variant === "outline" ? (tone ?? "primary") : null, size }), className);
    if (asChild && React.isValidElement<{ className?: string }>(props.children)) {
        const { children, ...rest } = props;
        return React.cloneElement(children as React.ReactElement<{ className?: string }>, { ...rest, className: cn(classes, (children as React.ReactElement<{ className?: string }>).props.className) });
    }
    return <button className={classes} type={type ?? "button"} {...props} />;
}

export function ButtonGroup({ className, orientation = "horizontal", ...props }: React.HTMLAttributes<HTMLDivElement> & { orientation?: "horizontal" | "vertical" }): React.ReactElement {
    return <div role="group" className={cn("sf-btn-group inline-flex",
        orientation === "horizontal"
            ? "[&>*:not(:first-child)]:-ms-px [&>*:not(:first-child)]:rounded-s-none [&>*:not(:last-child)]:rounded-e-none"
            : "flex-col [&>*:not(:first-child)]:-mt-px [&>*:not(:first-child)]:rounded-t-none [&>*:not(:last-child)]:rounded-b-none",
        className)} {...props} />;
}
