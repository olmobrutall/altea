import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { cn } from "./utils";

export function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>): React.ReactElement {
    return <CommandPrimitive className={cn("sf-command flex flex-col overflow-hidden rounded-md bg-popover text-popover-foreground", className)} {...props} />;
}

export function CommandInput({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Input>): React.ReactElement {
    return (
        <div className="flex items-center gap-2 border-b px-3">
            <FontAwesomeIcon icon="magnifying-glass" className="text-[.8em] opacity-50" aria-hidden={true} />
            <CommandPrimitive.Input className={cn("sf-command-input flex h-9 w-full border-0 bg-transparent py-2 text-inherit text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50", className)} {...props} />
        </div>
    );
}

export function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>): React.ReactElement {
    return <CommandPrimitive.List className={cn("sf-command-list max-h-[300px] overflow-y-auto overflow-x-hidden p-1", className)} {...props} />;
}

export function CommandEmpty({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>): React.ReactElement {
    return <CommandPrimitive.Empty className={cn("py-4 text-center text-sm text-muted-foreground", className)} {...props} />;
}

export function CommandLoading({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Loading>): React.ReactElement {
    return <CommandPrimitive.Loading className={cn("py-4 text-center text-sm text-muted-foreground", className)} {...props} />;
}

export function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>): React.ReactElement {
    return <CommandPrimitive.Group className={cn("overflow-hidden [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground", className)} {...props} />;
}

export function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>): React.ReactElement {
    return <CommandPrimitive.Item className={cn("sf-command-item relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1 outline-none",
        "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50", className)} {...props} />;
}

export function CommandSeparator({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Separator>): React.ReactElement {
    return <CommandPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}
