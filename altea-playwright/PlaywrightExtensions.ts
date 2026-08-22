import type { Locator, Page } from "@playwright/test";

// Port of Signum.Playwright's PlaywrightExtensions.cs — the small vocabulary every proxy is written in.
//
// It is MUCH shorter than Signum's 493 lines, and deliberately so: most of that file exists because the
// .NET Playwright binding has no `Locator.Or`, no soft assertions and no auto-waiting shorthands, so Signum
// hand-rolls `WaitVisibleAsync` / `WaitNotPresentAsync` / `IsPresentAsync` / `SafeSelectorPrefix` over
// `ILocator`. The JS binding auto-waits inside every action and ships `.or()` / `.filter()` / `waitFor()`,
// so only the genuinely altea-specific helpers survive here — the rest is used directly.
//
// What DOES survive is the part that is not about Playwright at all: the "capture the modal this click
// opened" dance and the "wait until the entity's change counter moved" dance, which are how Signum's proxies
// stay deterministic against a React app that renders asynchronously.

/** How long a `waitFor`-style helper waits before giving up. Signum's default is the same 30s. */
export const defaultTimeout = 30_000;

/** Signum's `ILocator.WaitVisibleAsync` (+ the optional scroll). */
export async function waitVisible(locator: Locator, options?: { scrollTo?: boolean; timeout?: number }): Promise<Locator> {
    await locator.waitFor({ state: "visible", timeout: options?.timeout ?? defaultTimeout });
    if (options?.scrollTo)
        await locator.scrollIntoViewIfNeeded();
    return locator;
}

/** Signum's `WaitPresentAsync` — in the DOM, visible or not. */
export async function waitPresent(locator: Locator, timeout = defaultTimeout): Promise<Locator> {
    await locator.waitFor({ state: "attached", timeout });
    return locator;
}

/** Signum's `WaitNoVisibleAsync`. */
export async function waitNotVisible(locator: Locator, timeout = defaultTimeout): Promise<void> {
    await locator.waitFor({ state: "hidden", timeout });
}

/** Signum's `WaitNotPresentAsync`. */
export async function waitNotPresent(locator: Locator, timeout = defaultTimeout): Promise<void> {
    await locator.waitFor({ state: "detached", timeout });
}

/** Signum's `IsPresentAsync` — present in the DOM (`IsVisible` is Playwright's own). */
export async function isPresent(locator: Locator): Promise<boolean> {
    return await locator.count() > 0;
}

/** Signum's `HasClassAsync`. */
export async function hasClass(locator: Locator, className: string): Promise<boolean> {
    const classes = await locator.getAttribute("class");
    return classes != null && classes.split(/\s+/).includes(className);
}

/** Signum's `WaitForClassOnAsync` / `WaitForClassOffAsync`. */
export async function waitForClass(locator: Locator, className: string, present: boolean, timeout = defaultTimeout): Promise<void> {
    await waitFor(async () => await hasClass(locator, className) === present,
        `class '${className}' to be ${present ? "present" : "absent"}`, timeout);
}

/**
 * Signum's `Page.WaitAsync(condition, description, timeout)` — poll until the condition holds, then throw
 * a message that says WHAT was being waited for (Playwright's own timeout message would only name a
 * selector, and half of these conditions are not about one element).
 */
export async function waitFor(condition: () => Promise<boolean>, description: string, timeout = defaultTimeout): Promise<void> {
    const deadline = Date.now() + timeout;
    for (;;) {
        if (await condition())
            return;
        if (Date.now() > deadline)
            throw new Error(`Timeout after ${timeout}ms waiting for ${description}`);
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

/** As {@link waitFor}, but for a value: poll until it is non-null and return it. */
export async function waitValue<T>(get: () => Promise<T | null | undefined>, description: string, timeout = defaultTimeout): Promise<T> {
    let last: T | null | undefined;
    await waitFor(async () => (last = await get()) != null, description, timeout);
    return last!;
}

// ---- Modal capture -------------------------------------------------------------------------------------

/**
 * Signum's `CaptureOnClickAsync`: click something that OPENS A MODAL and return a locator bound to THAT
 * modal.
 *
 * Why not just `.modal`: several modals can be open at once (a search modal that opens an entity modal that
 * opens a selector), and React mounts the new one asynchronously — so "the last modal" is a race. Signum's
 * trick, kept verbatim: the TEST stamps each captured modal with a `data-capture-index` of its own (the app
 * renders no such attribute), so the locator addresses the modal this click produced however many open or
 * close afterwards.
 */
export async function captureOnClick(button: Locator): Promise<Locator> {
    return await captureModal(button.page(), () => button.click());
}

/** As {@link captureOnClick}, for an action that is not a plain click (Signum's CaptureModalAsync). */
export async function captureModal(page: Page, action: () => Promise<void>): Promise<Locator> {
    const maxIndex = () => page.evaluate(() => {
        let max = 0;
        document.querySelectorAll(".modal.fade.show[data-capture-index]")
            .forEach(el => { max = Math.max(max, parseInt(el.getAttribute("data-capture-index")!, 10)); });
        return max;
    });

    const before = await maxIndex();

    await action();

    // The new modal is the visible one this test has not stamped yet.
    await page.waitForSelector(".modal.fade.show:not([data-capture-index])", { timeout: defaultTimeout });

    const nextIndex = Math.max(before, await maxIndex()) + 1;

    await page.evaluate(index => {
        document.querySelector(".modal.fade.show:not([data-capture-index])")
            ?.setAttribute("data-capture-index", String(index));
    }, nextIndex);

    return page.locator(`.modal.fade.show[data-capture-index='${nextIndex}']`);
}

// ---- Change tracking -----------------------------------------------------------------------------------

/**
 * Signum's `GetChangesAsync` / `WaitNewChangesAsync`: every altea LINE renders `data-changes`, a counter
 * its React state bumps on each re-render (LineBase.baseHtmlAttributes — identical in both frameworks). A
 * proxy that mutates the entity waits for that number to MOVE before returning, which is what makes
 * `await line.setValue(x); await other.setValue(y)` deterministic without sleeps.
 */
export async function getChanges(element: Locator): Promise<string> {
    const attr = await element.getAttribute("data-changes");
    if (attr == null)
        throw new Error("data-changes attribute not found — is this locator the LINE element"
            + " (the one carrying data-property-path)?");
    return attr;
}

export async function waitNewChanges(element: Locator, previous: string, timeout = defaultTimeout): Promise<void> {
    await waitFor(async () => await element.getAttribute("data-changes") !== previous,
        "the line's data-changes to move", timeout);
}

/** Run `action`, then wait until the line's change counter has moved (Signum's `WaitChangesAsync`). */
export async function waitChanges(element: Locator, action: () => Promise<void>): Promise<void> {
    const previous = await getChanges(element);
    await action();
    await waitNewChanges(element, previous);
}

// ---- Scopes (Signum's `Task.Then`) ---------------------------------------------------------------------

/**
 * A proxy whose LIFETIME is a scope: a modal that has to be closed, a page whose frame has to settle.
 *
 * This is the shape behind Signum's central idiom. A Signum test reads
 *
 *     await b.SearchPageAsync(typeof(PersonEntity)).Then(async persons => {
 *         await persons.Results.EntityClickAsync<PersonEntity>(1).Then(async john => {
 *             await john.ConstructFromAsync(OrderOperation.CreateOrderFromCustomer, "create").Then(async order => { … });
 *         });
 *     });
 *
 * — the CLOSURE is the open page / modal, and `Then`'s `finally` disposes it (Signum.Utilities'
 * TaskExtensions.Then + each proxy's `DisposeAsync`). That is preserved here in the two ways TypeScript
 * offers: {@link scoped} (the direct translation of `Then`) and `await using`, since every scoped proxy
 * implements `Symbol.asyncDispose`.
 */
export interface AsyncScoped {
    [Symbol.asyncDispose](): Promise<void>;
    /** Signum's `IDisposableException.OnException` — told before the scope unwinds, so a proxy can decide
     *  not to close (leaving the failure on screen). */
    onException?(error: unknown): void;
}

/**
 * Signum's `Task<T>.Then(async t => …)`: await the proxy, run the body inside its scope, and DISPOSE it on
 * the way out — closing the modal, and waiting for whatever opened it to re-render. The body's result flows
 * on, so scopes chain exactly as they do in C#:
 *
 *     const lite = await scoped(browser.searchPage("Order"), async search =>
 *         await scoped(search.results.entityClickModal(0, OrderEntity), async order => {
 *             await order.lines.textBox(o => o.shipName).setValue("New");
 *             await order.execute(OrderOperation.Save);
 *             return await order.entityInfo();
 *         }));
 */
export async function scoped<T extends AsyncScoped, R>(source: T | Promise<T>, body: (proxy: T) => Promise<R>): Promise<R> {
    const value = await source;
    try {
        return await body(value);
    } catch (e) {
        value.onException?.(e);
        throw e;
    } finally {
        await value[Symbol.asyncDispose]();
    }
}
