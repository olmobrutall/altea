import type { Locator, Page } from "@playwright/test";
import { Lite } from "@altea/altea/data/lite";
import { Entity, type BaseEntity, type PrimaryKey, type Type } from "@altea/altea/data/entity";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { isPresent, scope, waitFor, waitNotPresent, waitVisible, type Scope } from "./PlaywrightExtensions";
import { cleanNameOf, queryKeyOf } from "./tokens";
import { SearchPageProxy } from "./Search/SearchPageProxy";
import { FramePageProxy } from "./Frames/FramePageProxy";

// Port of Signum.Playwright's BrowserProxy.cs — the entry point: log in, and navigate to the two kinds of
// page a test starts from (a search page, an entity page).
//
// An application subclasses it to name its base URL, exactly as Signum's docs say:
//
//     class EastwindBrowser extends BrowserProxy {
//         url(relative: string): string { return "http://localhost:5173/" + relative; }
//     }
//
// altea divergences:
//  - nothing is named by STRING: a search page takes the query's row TYPE, an entity page takes the entity
//    (or its lite, or its type + id), and both give back a proxy typed on it. Signum passes
//    `typeof(PersonEntity)` for the query and a `Lite<T>` for the page, but its `FramePageAsync<T>` still
//    needs the type argument spelled out.
//  - the LOGIN ROUTE is `auth/login` (altea's router), not Signum's `Auth/Login`, and the form's ids are
//    altea's (`#userName` / `#password` / the submit button) — see `login`.
//  - Signum's CDP "debug mode" (launch a real Chrome with a user-data-dir and connect over the debugging
//    port) is NOT ported: `@playwright/test` already has `--headed`, `--debug` and the UI mode, which is
//    what that machinery re-created for xUnit.
//  - navigation routes are altea's `find/<QueryKey>` / `view/<CleanName>/<id>` / `create/<CleanName>` —
//    the same shapes Signum uses, so only the base URL differs.
export class BrowserProxy {

    constructor(readonly page: Page) { }

    /** Override with the app's base URL. */
    url(relativeUrl: string): string {
        throw new Error(`BrowserProxy.url: override it, e.g. "http://localhost:5173/" + relativeUrl`
            + ` (asked for '${relativeUrl}')`);
    }

    // ---- Navigation --------------------------------------------------------------------------------

    /** Signum's `FindRoute(queryName)`. */
    findRoute(queryName: QueryName): string { return "find/" + queryKeyOf(queryName); }

    /** Signum's `NavigateRoute(type, id)`. */
    navigateRoute(type: Type<BaseEntity>, id?: PrimaryKey | null): string {
        return id == null ? `create/${cleanNameOf(type)}` : `view/${cleanNameOf(type)}/${id}`;
    }

    /**
     * Signum's `SearchPageAsync(queryName)` — open `/find/<Query>`. The query is named by the TYPE it
     * yields rows of (an entity, or a manual query's row model), which is what a query name IS in altea.
     */
    searchPage<T extends BaseEntity>(queryName: Type<T> & QueryName, options?: { waitInitialSearch?: boolean }): Scope<SearchPageProxy<T>> {
        return scope((async () => {
            await this.page.goto(this.url(this.findRoute(queryName)));
            return await SearchPageProxy.create<T>(this.page, queryName, options?.waitInitialSearch ?? true);
        })());
    }

    /**
     * Signum's `FramePageAsync<T>` — open an entity's page, by the entity itself, by a lite of it, or by
     * its type and id. Which one a test has in hand depends on how it arranged its data; all three name
     * the same page, and none of them names it by string.
     */
    framePage<T extends Entity>(entity: T): Scope<FramePageProxy<T>>;
    framePage<T extends Entity>(lite: Lite<T>): Scope<FramePageProxy<T>>;
    framePage<T extends Entity>(type: Type<T>, id: PrimaryKey): Scope<FramePageProxy<T>>;
    framePage<T extends Entity>(target: T | Lite<T> | Type<T>, id?: PrimaryKey): Scope<FramePageProxy<T>> {
        const { type, key } = resolveTarget<T>(target, id);
        return scope((async () => {
            await this.page.goto(this.url(this.navigateRoute(type, key)));
            return await FramePageProxy.create<T>(this.page, type);
        })());
    }

    /** Signum's parameterless `FramePageAsync<T>()` — the CREATE page of a type (`/create/<CleanName>`). */
    createPage<T extends Entity>(type: Type<T>): Scope<FramePageProxy<T>> {
        return scope((async () => {
            await this.page.goto(this.url(this.navigateRoute(type, null)));
            return await FramePageProxy.create<T>(this.page, type);
        })());
    }

    // ---- Authentication ----------------------------------------------------------------------------

    get loginDropdown(): Locator { return this.page.locator(".sf-login-dropdown").first(); }

    /** Signum's `GetCurrentUserAsync` — the name in the navbar, or null when nobody is logged in. */
    async currentUser(): Promise<string | null> {
        if (!await isPresent(this.loginDropdown))
            return null;
        return (await this.loginDropdown.innerText()).trim() || null;
    }

    /**
     * Signum's `LoginAsync`. altea's login page is `/auth/login` with `#userName` / `#password`; a dev
     * database can be configured with VITE_PASSWORD_IS_USERNAME, in which case the password field is not
     * rendered at all — so it is filled only when present (see eastwind's CLAUDE.md).
     */
    async login(userName: string, password: string): Promise<void> {
        if (await this.currentUser() === userName)
            return;

        await this.page.goto(this.url("auth/login"));

        const userInput = this.page.locator("#userName");
        await waitVisible(userInput);
        await userInput.fill(userName);

        const passwordInput = this.page.locator("#password");
        if (await isPresent(passwordInput))
            await passwordInput.fill(password);

        await this.page.locator("button[type=submit]").first().click();

        await waitFor(async () => await this.currentUser() != null, `'${userName}' to be logged in`);
    }

    /** Signum's `LogoutAsync`. */
    async logout(): Promise<void> {
        await this.loginDropdown.click();
        await this.page.locator("#sf-auth-logout, a:has-text('Logout')").first().click();
        await waitFor(async () => await this.currentUser() == null, "the user to be logged out");
    }

    /** Wait until every modal is gone — handy between test steps. */
    async waitNoModals(): Promise<void> {
        await waitNotPresent(this.page.locator(".modal.fade.show"));
    }
}

/** The type + id behind the three `framePage` overloads. */
function resolveTarget<T extends Entity>(target: T | Lite<T> | Type<T>, id?: PrimaryKey): { type: Type<T>; key: PrimaryKey } {
    if (target instanceof Lite) {
        if (target.id == null)
            throw new Error("BrowserProxy.framePage: the lite has no id — it was built from an unsaved entity.");
        return { type: target.entityType as Type<T>, key: target.id };
    }

    if (target instanceof Entity) {
        if (target.id == null)
            throw new Error(`BrowserProxy.framePage: this ${target.getType().name} is not saved, so it has no page.`);
        return { type: target.getType() as Type<T>, key: target.id };
    }

    if (id == null)
        throw new Error("BrowserProxy.framePage: an id is required when the page is named by TYPE."
            + " Use createPage(type) for the create page.");
    return { type: target, key: id };
}
