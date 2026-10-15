import * as React from "react";
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "./utils";

export type TabKey = string | number;

/** Other attributes (data-*, …) go on the panel, as react-bootstrap put them. */
export interface TabProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
    eventKey: TabKey;
    title: React.ReactNode;
    disabled?: boolean;
    /** On the panel. */
    className?: string;
    /** On the tab button. */
    tabClassName?: string;
    /** This panel only: rendered the first time it is shown. */
    mountOnEnter?: boolean;
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

/** react-bootstrap's `<Tabs><Tab eventKey title>…</Tab></Tabs>`, over Base UI Tabs. */
export function Tabs(p: TabsProps): React.ReactElement {
    // By shape, not by type: views and ReactVisitor still hand in react-bootstrap <Tab>s.
    const tabs = React.Children.toArray(p.children)
        .filter((c): c is React.ReactElement<TabProps> => React.isValidElement(c) && (c.props as Partial<TabProps>).eventKey !== undefined);

    const [uncontrolled, setUncontrolled] = React.useState<string | undefined>(() =>
        p.defaultActiveKey != null ? String(p.defaultActiveKey) : tabs.length ? String(tabs[0].props.eventKey) : undefined);
    const active = p.activeKey != null ? String(p.activeKey) : uncontrolled;

    const visited = React.useRef(new Set<string>());
    if (active != null)
        visited.current.add(active);

    const pills = p.variant === "pills";

    return (
        <TabsPrimitive.Root id={p.id} value={active}
            onValueChange={k => { setUncontrolled(String(k)); p.onSelect?.(String(k)); }}
            className={cn("sf-tabs", p.className)}>
            <TabsPrimitive.List activateOnFocus={false} className={cn("sf-tab-list", pills ? "sf-tabs-pills" : "sf-tabs-tabs")}>
                {tabs.map(t =>
                    <TabsPrimitive.Tab key={String(t.props.eventKey)} value={String(t.props.eventKey)} disabled={t.props.disabled}
                        id={p.id ? `${p.id}-tab-${t.props.eventKey}` : undefined}
                        data-event-key={String(t.props.eventKey)}
                        className={cn("sf-tab", t.props.tabClassName)}>
                        {t.props.title}
                    </TabsPrimitive.Tab>)}
            </TabsPrimitive.List>
            {tabs.map(t => {
                const { eventKey, title, disabled, className, tabClassName, mountOnEnter, children, ...panelAttributes } = t.props;
                const key = String(eventKey);
                const rendered = p.unmountOnExit ? key === active : (p.mountOnEnter || mountOnEnter) ? visited.current.has(key) : true;
                return (
                    <TabsPrimitive.Panel {...panelAttributes} key={key} value={key} keepMounted={rendered}
                        id={p.id ? `${p.id}-tabpane-${key}` : undefined}
                        className={cn("sf-tab-pane outline-none", className)}>
                        {rendered && children}
                    </TabsPrimitive.Panel>
                );
            })}
        </TabsPrimitive.Root>
    );
}
