// @altea/altea-playwright — strongly-typed Playwright page objects for an altea UI.
//
// Port of Signum.Playwright (Signum's xUnit + Microsoft.Playwright test-support assembly). What a test
// writes against:
//
//     const b = new EastwindBrowser(page);                  // your BrowserProxy subclass (names the URL)
//     await b.loginAs(TestUser.Standard);
//
//     await b.searchPage(OrderEntity).scoped(async search => {
//         await search.filters.addFilterFor(o => o.customer.name, FilterOperation.Contains, "Maria");
//         await search.search();
//
//         await search.results.entityClickModal(0).scoped(async order => {
//             await order.lines.textBox(o => o.shipName).setValue("New name");
//             await order.execute(OrderOperation.Save);
//         });                                               // ← the modal closes here
//     });
//
// NOTHING IS NAMED BY STRING: the query is the row TYPE, a column is a property lambda, an operation is its
// SYMBOL, a filter's operation and value are the enum and the member's own type. See ./tokens.
//
// SIGNUM'S SCOPING IS PRESERVED. Its API is closure-oriented — `b.SearchPageAsync(...).Then(async persons =>
// { ... })`, where `Then` (Signum.Utilities' TaskExtensions) runs the body and DISPOSES the proxy in a
// `finally`, so the closure IS the open page / modal and leaving it closes the modal and waits for whatever
// opened it to re-render. Every navigation returns a `Scope` — a thenable carrying `.scoped(body)`, which
// IS that function, one for one (`scoped(source, body)` is the free-function form). Every scoped proxy also
// implements `Symbol.asyncDispose`, so the same thing reads as `await using order = await line.createModal(
// OrderEntity)` for anyone who prefers the declaration form.
//
// The whole design rests on two attributes altea's React renders (identically to Signum's): every LINE
// carries `data-property-path` + `data-changes`, and every frame / search carries `data-main-entity` /
// `data-refresh-count` / `data-search-count`. That is what lets a proxy address a control by its PROPERTY
// ROUTE and wait for a real re-render instead of sleeping.
//
// NOT ported from Signum.Playwright (each is a module altea does not have, or a Playwright feature that
// makes the C# machinery unnecessary — the closure scoping IS ported, see above):
//  - `SignumPlaywrightTestClass`'s CDP debug mode — the suite owns the launch, so `headless: false` covers it.
//  - `HtmlLineProxy`, `GuidBoxLineProxy`, `ColorLineProxy`'s picker, `EntityListProxy` (altea has no
//    EntityList line — see CLAUDE.md's altea-dynamic notes), `EnumCheckBoxListProxy`, `MultiValueLineProxy`.
//  - `Toolbar/ToolbarSidebarProxy` (altea-toolbar's sidebar) and `Search/SearchValueLineProxy` /
//    `ColumnEditorProxy` / `ContextMenuProxy` — the panel-level proxies; the underlying selectors are the
//    same, so they are small additions when a test needs them.
export * from "./PlaywrightExtensions";
export * from "./tokens";
export * from "./liteKeys";
export * from "./BrowserProxy";
export * from "./Frames/LineContainer";
export * from "./Frames/EntityButtonContainer";
export * from "./Frames/FramePageProxy";
export * from "./Frames/FrameModalProxy";
export * from "./ModalProxies/ModalProxy";
export * from "./Search/SearchPageProxy";
export * from "./Search/SearchModalProxy";
export * from "./Search/SearchControlProxy";
export * from "./Search/ResultTableProxy";
export * from "./Search/FiltersProxy";
export * from "./Search/QueryTokenBuilderProxy";
export * from "./Search/PaginationSelectorProxy";
export * from "./LineProxies/index";
