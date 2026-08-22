import type { Locator, Page } from "@playwright/test";
import type { Quoted } from "quote-transformer/quoted";
import { PropertyRoute, PropertyRouteType } from "@altea/altea/data/propertyRoute";
import type { BaseEntity } from "@altea/altea/data/entity";
import { isPresent, waitVisible, waitPresent, waitNotVisible, waitNotPresent } from "../PlaywrightExtensions";
import { BaseLineProxy } from "../LineProxies/BaseLineProxy";
import { CheckboxLineProxy } from "../LineProxies/CheckboxLineProxy";
import { DateTimeLineProxy } from "../LineProxies/DateTimeLineProxy";
import { EnumLineProxy } from "../LineProxies/EnumLineProxy";
import { NumberLineProxy } from "../LineProxies/NumberLineProxy";
import { TimeLineProxy } from "../LineProxies/TimeLineProxy";
import { TextAreaLineProxy, TextBoxLineProxy } from "../LineProxies/TextLineProxy";
import { EntityLineProxy } from "../LineProxies/EntityLineProxy";
import { EntityComboProxy } from "../LineProxies/EntityComboProxy";
import { EntityDetailProxy } from "../LineProxies/EntityDetailProxy";
import { EntityStripProxy } from "../LineProxies/EntityStripProxy";
import { EntityRepeaterProxy } from "../LineProxies/EntityRepeaterProxy";
import { EntityTabRepeaterProxy } from "../LineProxies/EntityTabRepeaterProxy";
import { EntityTableProxy } from "../LineProxies/EntityTableProxy";
import { EntityCheckboxListProxy } from "../LineProxies/EntityCheckboxListProxy";
import { FileLineProxy } from "../LineProxies/FileLineProxy";

// Port of Signum.Playwright's Frames/LineContainer.cs — "the thing that holds lines": an entity page, an
// entity modal, a repeater row, a detail. Everything a test does to a form goes through it.
//
// The addressing scheme is Signum's and works unchanged in altea, because altea's LineBase renders the same
// two attributes: `data-property-path` (which line) and `data-changes` (a re-render counter — see
// PlaywrightExtensions). A property lambda is turned into that path by altea's own PropertyRoute.addLambda,
// which reads the quote-transformer's expression tree — so `lc.textBox(a => a.shipAddress.city)` is checked
// by the compiler AND survives minification, where Signum parses the C# expression tree for the same result.
//
// altea divergences from the C# shape:
//  - C# extension methods on `ILineContainer<T>` become METHODS on the class (TypeScript has none), so
//    `lineContainer.EntityLine(a => a.Customer)` reads `lc.entityLine(a => a.customer)`.
//  - the proxies are constructed directly instead of through Signum's `.Value()` / `…ValueAsync` overload
//    pairs; each proxy has `getValue()` / `setValue(v)`, and `lc.value(…)` / `lc.setValue(…, v)` are the
//    untyped shortcuts over `autoLine`.

/** Signum's `LineLocator<S>` — the located line plus the route it was reached by. */
export interface LineLocator {
    readonly locator: Locator;
    readonly route: PropertyRoute;
}

export class LineContainer<T extends BaseEntity> {

    constructor(readonly element: Locator, readonly route: PropertyRoute) { }

    get page(): Page { return this.element.page(); }

    /** Signum's `As<S>()` — the same element, seen as a subtype (an @implementedBy pick, a mixin host). */
    as<S extends BaseEntity>(type: Function): LineContainer<S> {
        return new LineContainer<S>(this.element, PropertyRoute.root(type));
    }

    // ---- Addressing --------------------------------------------------------------------------------

    /**
     * Signum's `LineLocator(property)`: the element of ONE line, by property lambda.
     *
     * The walk NARROWS once per step (into the embedded's line, then into the member's), which is both what
     * altea's re-rooted `data-property-path` requires and what keeps a nested `city` from matching a
     * sibling's — Signum narrows for the second reason alone.
     */
    lineLocator<S>(property: Quoted<(t: T) => S>): LineLocator {
        const route = this.route.addLambda(property as never);

        let locator = this.element;
        for (const step of routeChain(this.route, route))
            locator = locator.locator(`[data-property-path='${step.member}']`).first();

        return { locator, route };
    }

    /** Signum's `UntypedLineLocator(route)` — for a route computed at runtime. */
    untypedLineLocator(route: PropertyRoute): Locator {
        let locator = this.element;
        for (const step of routeChain(this.route, route))
            locator = locator.locator(`[data-property-path='${step.member}']`).first();
        return locator;
    }

    isVisible<S>(property: Quoted<(t: T) => S>): Promise<boolean> {
        return this.lineLocator(property).locator.isVisible();
    }

    isPresent<S>(property: Quoted<(t: T) => S>): Promise<boolean> {
        return isPresent(this.lineLocator(property).locator);
    }

    async waitVisible<S>(property: Quoted<(t: T) => S>): Promise<void> {
        await waitVisible(this.lineLocator(property).locator);
    }

    async waitPresent<S>(property: Quoted<(t: T) => S>): Promise<void> {
        await waitPresent(this.lineLocator(property).locator);
    }

    async waitNotVisible<S>(property: Quoted<(t: T) => S>): Promise<void> {
        await waitNotVisible(this.lineLocator(property).locator);
    }

    async waitNotPresent<S>(property: Quoted<(t: T) => S>): Promise<void> {
        await waitNotPresent(this.lineLocator(property).locator);
    }

    // ---- The lines ---------------------------------------------------------------------------------

    checkbox<S>(property: Quoted<(t: T) => S>): CheckboxLineProxy {
        const { locator, route } = this.lineLocator(property);
        return new CheckboxLineProxy(locator, route);
    }

    dateTime<S>(property: Quoted<(t: T) => S>): DateTimeLineProxy {
        const { locator, route } = this.lineLocator(property);
        return new DateTimeLineProxy(locator, route);
    }

    time<S>(property: Quoted<(t: T) => S>): TimeLineProxy {
        const { locator, route } = this.lineLocator(property);
        return new TimeLineProxy(locator, route);
    }

    enumLine<S>(property: Quoted<(t: T) => S>): EnumLineProxy {
        const { locator, route } = this.lineLocator(property);
        return new EnumLineProxy(locator, route);
    }

    number<S>(property: Quoted<(t: T) => S>): NumberLineProxy {
        const { locator, route } = this.lineLocator(property);
        return new NumberLineProxy(locator, route);
    }

    textBox<S>(property: Quoted<(t: T) => S>): TextBoxLineProxy {
        const { locator, route } = this.lineLocator(property);
        return new TextBoxLineProxy(locator, route);
    }

    textArea<S>(property: Quoted<(t: T) => S>): TextAreaLineProxy {
        const { locator, route } = this.lineLocator(property);
        return new TextAreaLineProxy(locator, route);
    }

    file<S>(property: Quoted<(t: T) => S>): FileLineProxy {
        const { locator, route } = this.lineLocator(property);
        return new FileLineProxy(locator, route);
    }

    entityLine<S>(property: Quoted<(t: T) => S>): EntityLineProxy {
        const { locator, route } = this.lineLocator(property);
        return new EntityLineProxy(locator, route);
    }

    entityCombo<S>(property: Quoted<(t: T) => S>): EntityComboProxy {
        const { locator, route } = this.lineLocator(property);
        return new EntityComboProxy(locator, route);
    }

    entityDetail<S>(property: Quoted<(t: T) => S>): EntityDetailProxy {
        const { locator, route } = this.lineLocator(property);
        return new EntityDetailProxy(locator, route);
    }

    entityStrip<S>(property: Quoted<(t: T) => S>): EntityStripProxy {
        const { locator, route } = this.lineLocator(property);
        return new EntityStripProxy(locator, route);
    }

    entityRepeater<S>(property: Quoted<(t: T) => S>): EntityRepeaterProxy {
        const { locator, route } = this.lineLocator(property);
        return new EntityRepeaterProxy(locator, route);
    }

    entityTabRepeater<S>(property: Quoted<(t: T) => S>): EntityTabRepeaterProxy {
        const { locator, route } = this.lineLocator(property);
        return new EntityTabRepeaterProxy(locator, route);
    }

    entityTable<S>(property: Quoted<(t: T) => S>): EntityTableProxy {
        const { locator, route } = this.lineLocator(property);
        return new EntityTableProxy(locator, route);
    }

    entityCheckboxList<S>(property: Quoted<(t: T) => S>): EntityCheckboxListProxy {
        const { locator, route } = this.lineLocator(property);
        return new EntityCheckboxListProxy(locator, route);
    }

    /** Signum's `AutoLine` — the proxy that FITS the route's type (see BaseLineProxy.autoLine). */
    autoLine<S>(property: Quoted<(t: T) => S>): BaseLineProxy {
        const { locator, route } = this.lineLocator(property);
        return BaseLineProxy.autoLine(locator, route);
    }

    /** Read whatever the line at this route holds (Signum's `AutoLineValueAsync` getter). */
    value<S>(property: Quoted<(t: T) => S>): Promise<unknown> {
        return this.autoLine(property).getValueUntyped();
    }

    /** Write it (Signum's `AutoLineValueAsync` setter). */
    setValue<S>(property: Quoted<(t: T) => S>, value: unknown): Promise<void> {
        return this.autoLine(property).setValueUntyped(value);
    }

    // ---- Tabs --------------------------------------------------------------------------------------

    /** Signum's `SelectTabAsync(eventKey)` — click a react-bootstrap tab and wait for it to be active. */
    async selectTab(eventKey: string): Promise<this> {
        const tab = this.element.locator(`.nav-tabs .nav-item .nav-link[data-rr-ui-event-key='${eventKey}']`);
        await tab.click();
        await waitVisible(this.element.locator(".nav-tabs .nav-item .nav-link.active"));
        return this;
    }
}

/**
 * Every FIELD step from `from` (exclusive) down to `to` (INCLUSIVE) — one narrowing per rendered line (see
 * the header). `Item` / `LiteEntity` steps are skipped: they render no line of their own (a collection's
 * rows are addressed by the repeater / table proxy, and a Lite's entity is the same line).
 *
 * `toString()`, not `propertyString()`: the ROOT route has no property string (it throws), and the
 * container's route IS a root whenever the container is a page or a modal.
 */
function routeChain(from: PropertyRoute, to: PropertyRoute): PropertyRoute[] {
    const steps: PropertyRoute[] = [];
    const stop = from.toString();
    for (let r: PropertyRoute | undefined = to; r != null && r.toString() !== stop; r = r.parent)
        if (r.propertyRouteType === PropertyRouteType.FieldOrProperty || r.propertyRouteType === PropertyRouteType.Mixin)
            steps.unshift(r);
    return steps;
}
