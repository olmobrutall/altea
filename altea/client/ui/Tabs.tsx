import * as React from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { cn } from "./utils";

export type TabKey = string | number;

export interface TabProps {
    eventKey: TabKey;
    title: React.ReactNode;
    disabled?: boolean;
    /** On the panel. */
    className?: string;
    /** On the tab button. */
    tabClassName?: string;
    children?: React.ReactNode;
}

/** Declares one tab of a `Tabs`; `Tabs` renders it. */
export function Tab(_p: TabProps): React.ReactElement | null {
    return null;
}

export interface TabsProps {
    id?: string;
    activeKey?: TabKey;
    defaultActiveKey?: TabKey;
    onSelect?: (key: string) => void;
    /** A panel is rendered the first time it is shown, then kept. */
    mountOnEnter?: boolean;
    /** Only the active panel is rendered. Without either flag every panel is rendered, hidden — react-bootstrap's default. */
    unmountOnExit?: boolean;
    variant?: "tabs" | "pills";
    className?: string;
    children?: React.ReactNode;
}

/** react-bootstrap's `<Tabs><Tab eventKey title>…</Tab></Tabs>`, over Radix Tabs. */
export function Tabs(p: TabsProps): React.ReactElement {
    const tabs = React.Children.toArray(p.children)
        .filter((c): c is React.ReactElement<TabProps> => React.isValidElement(c) && c.type === Tab);

    const [uncontrolled, setUncontrolled] = React.useState<string | undefined>(() =>
        p.defaultActiveKey != null ? String(p.defaultActiveKey) : tabs.length ? String(tabs[0].props.eventKey) : undefined);
    const active = p.activeKey != null ? String(p.activeKey) : uncontrolled;

    const visited = React.useRef(new Set<string>());
    if (active != null)
        visited.current.add(active);

    const pills = p.variant === "pills";

    return (
        <TabsPrimitive.Root id={p.id} value={active} activationMode="manual"
            onValueChange={k => { setUncontrolled(k); p.onSelect?.(k); }}
            className={cn("sf-tabs", p.className)}>
            <TabsPrimitive.List className={cn("sf-tab-list mb-0 flex flex-wrap", pills ? "gap-1" : "border-b")}>
                {tabs.map(t =>
                    <TabsPrimitive.Trigger key={String(t.props.eventKey)} value={String(t.props.eventKey)} disabled={t.props.disabled}
                        id={p.id ? `${p.id}-tab-${t.props.eventKey}` : undefined}
                        className={cn("sf-tab cursor-pointer border-1 border-transparent bg-transparent px-4 py-2 text-primary",
                            "hover:text-primary/80 focus-visible:outline-none focus-visible:ring-[.25rem] focus-visible:ring-ring",
                            "disabled:cursor-default disabled:text-muted-foreground",
                            pills
                                ? "rounded-md data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                                : "-mb-px rounded-t-md hover:border-muted hover:border-b-border data-[state=active]:border-border data-[state=active]:border-b-background data-[state=active]:bg-background data-[state=active]:text-foreground",
                            t.props.tabClassName)}>
                        {t.props.title}
                    </TabsPrimitive.Trigger>)}
            </TabsPrimitive.List>
            {tabs.map(t => {
                const key = String(t.props.eventKey);
                const rendered = p.unmountOnExit ? key === active : p.mountOnEnter ? visited.current.has(key) : true;
                return (
                    <TabsPrimitive.Content key={key} value={key} forceMount={rendered ? true : undefined}
                        id={p.id ? `${p.id}-tabpane-${key}` : undefined}
                        className={cn("sf-tab-pane outline-none data-[state=inactive]:hidden", t.props.className)}>
                        {rendered && t.props.children}
                    </TabsPrimitive.Content>
                );
            })}
        </TabsPrimitive.Root>
    );
}
