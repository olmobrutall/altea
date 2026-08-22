import type { Locator, Page } from "@playwright/test";
import type { PropertyRoute } from "@altea/altea/data/propertyRoute";

// Port of Signum.Playwright's LineProxies/BaseLineProxy.cs — what every line proxy has (its element, the
// route it stands for) plus the untyped get/set the container's `value()` shortcuts go through.
//
// `autoLine` is Signum's dispatcher: given a route, pick the proxy for the line altea's <AutoLine> would
// have rendered. altea's dispatch reads the SAME facts off the field's TypeReference + implementations
// (CLAUDE.md: "UI Lines read their type from ctx.memberType"), so the two tables agree by construction —
// which is the point: a test that says `lc.value(a => a.x, v)` must drive whatever the app actually rendered.
export abstract class BaseLineProxy {

    constructor(readonly element: Locator, readonly route: PropertyRoute) { }

    get page(): Page { return this.element.page(); }

    abstract setValueUntyped(value: unknown): Promise<void>;
    abstract getValueUntyped(): Promise<unknown>;
    abstract isReadonly(): Promise<boolean>;

    /**
     * Signum's `BaseLineProxy.AutoLine(element, route)`. Kept as a REGISTRY rather than a hard-coded
     * if-chain: the concrete proxies live in modules that import this one, so a static chain here would be a
     * cycle. Each proxy module registers itself (see the bottom of every file), and LineProxies/index.ts
     * imports them all — exactly what an app's test does.
     */
    static autoLine(element: Locator, route: PropertyRoute): BaseLineProxy {
        for (const rule of autoLineRules) {
            const proxy = rule(element, route);
            if (proxy != null)
                return proxy;
        }
        throw new Error(`No line proxy fits ${route.toString()} (${route.type?.typeName}).`
            + " Import '@altea/altea-playwright/LineProxies/index' so every proxy is registered.");
    }

    /** Register a dispatch rule; later registrations are tried FIRST (an app can override one). */
    static registerAutoLine(rule: AutoLineRule): void {
        autoLineRules.unshift(rule);
    }
}

export type AutoLineRule = (element: Locator, route: PropertyRoute) => BaseLineProxy | null;

const autoLineRules: AutoLineRule[] = [];
