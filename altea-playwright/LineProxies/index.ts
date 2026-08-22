// Importing this module registers EVERY line proxy's auto-line rule (see BaseLineProxy.autoLine), which is
// what makes `lineContainer.autoLine(...)` / `.value(...)` able to drive whatever the app rendered. The
// package's own index re-exports it, so an app that imports `@altea/altea-playwright` gets them all.
//
// Registration ORDER matters: a later `registerAutoLine` is tried FIRST, so the SPECIFIC rules (combo for a
// low-population reference, detail for an embedded, repeater / checkbox-list for a collection) must be
// imported AFTER the general ones (entity line, strip).
export * from "./BaseLineProxy";
export * from "./TextLineProxy";
export * from "./NumberLineProxy";
export * from "./DateTimeLineProxy";
export * from "./TimeLineProxy";
export * from "./CheckboxLineProxy";
export * from "./EnumLineProxy";
export * from "./EntityBaseProxy";
export * from "./EntityStripProxy";
export * from "./EntityLineProxy";
export * from "./EntityComboProxy";
export * from "./EntityDetailProxy";
export * from "./EntityRepeaterProxy";
export * from "./EntityTabRepeaterProxy";
export * from "./EntityTableProxy";
export * from "./EntityCheckboxListProxy";
export * from "./FileLineProxy";
