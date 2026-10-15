import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "./utils";

/** The variant's semantic class (components.css): Bootstrap's colour names, as hand-written markup uses them. */
const variantClass = {
    primary: "sf-btn-primary", secondary: "sf-btn-secondary", tertiary: "sf-btn-tertiary", success: "sf-btn-success",
    destructive: "sf-btn-danger", warning: "sf-btn-warning", info: "sf-btn-info", light: "sf-btn-light", dark: "sf-btn-dark",
    link: "sf-btn-link", outline: "", ghost: "hover:bg-accent hover:text-accent-foreground",
};
const toneClass = {
    primary: "sf-btn-outline-primary", secondary: "sf-btn-outline-secondary", success: "sf-btn-outline-success",
    destructive: "sf-btn-outline-danger", warning: "sf-btn-outline-warning", info: "sf-btn-outline-info", dark: "sf-btn-outline-dark",
};

/** The semantic button (`sf-btn sf-btn-<variant> sf-btn-<size>`) the views' hand-written markup also uses, so an
 *  application restyles both at once; the kit only adds the icon layout. */
export const buttonVariants: (props?: ButtonVariantProps) => string = cva(
    "sf-btn inline-flex items-center justify-center gap-1.5 whitespace-nowrap [&_svg]:shrink-0",
    {
        variants: {
            variant: variantClass,
            tone: { primary: "", secondary: "", success: "", destructive: "", warning: "", info: "", dark: "" },
            size: { xs: "sf-btn-xs", sm: "sf-btn-sm", md: "", lg: "sf-btn-lg", icon: "size-8 p-0" },
        },
        compoundVariants: (["primary", "secondary", "success", "destructive", "warning", "info", "dark"] as const).map(tone => ({
            variant: "outline" as const,
            tone,
            className: toneClass[tone],
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
    return <div role="group" className={cn(orientation === "horizontal" ? "sf-btn-group" : "sf-btn-group-vertical", className)} {...props} />;
}
