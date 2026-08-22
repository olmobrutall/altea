import type { Locator, Page } from "@playwright/test";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import type { BaseEntity } from "@altea/altea/data/entity";
import { waitVisible, type AsyncScoped } from "../PlaywrightExtensions";
import { EntityButtonContainer } from "./EntityButtonContainer";
import { LineContainer } from "./LineContainer";

// Port of Signum.Playwright's Frames/FramePageProxy.cs — a whole ENTITY PAGE (`/view/Order/1`).
//
// C# gets `ILineContainer<T>` + `IEntityButtonContainer<T>` on one class through interfaces with extension
// methods; TypeScript has neither, so the page EXTENDS the button container and EXPOSES the line container
// as `.lines` (its `element` is the same node, so nothing else changes).
export class FramePageProxy<T extends BaseEntity> extends EntityButtonContainer implements AsyncScoped {

    readonly lines: LineContainer<T>;

    private constructor(readonly page: Page, readonly element: Locator, readonly route: PropertyRoute) {
        super();
        this.lines = new LineContainer<T>(element, route);
    }

    /** Signum's `OnDisposed` — what to await when the scope that owns this page unwinds. */
    onDisposed: (() => Promise<void>) | undefined;

    /** A page is a SCOPE like a modal (see PlaywrightExtensions' AsyncScoped), so `scoped(...)` and
     *  `await using` read the same whether the entity opened in place or in a modal. There is nothing to
     *  close, which is exactly Signum's FramePageProxy.DisposeAsync. */
    async [Symbol.asyncDispose](): Promise<void> {
        await this.onDisposed?.();
    }

    /** Signum's `FramePageProxy<T>.NewAsync(page)` — wait for the page's frame to be there. */
    static async create<T extends BaseEntity>(page: Page, rootType: Function): Promise<FramePageProxy<T>> {
        const element = page.locator(".normal-control").first();
        await waitVisible(element);
        const proxy = new FramePageProxy<T>(page, element, PropertyRoute.root(rootType));
        await waitVisible(proxy.mainControl);
        return proxy;
    }
}
