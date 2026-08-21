import * as React from "react";
import { DropdownButton, Dropdown } from "react-bootstrap";
import { Dic } from "@altea/altea/data/globals";
import { globalModules } from "./GlobalModules";
import { CopyTextModal } from "./CopyTextModal";
import { DynamicViewMessage } from "../../data/DynamicView";

// Port of Signum.Dynamic's View/ModulesHelp.tsx — the `modules` dropdown beside an expression editor: for
// each module in scope, a copy-pasteable snippet showing how it is normally used. It is documentation with
// a UI, and it is the main way a view author discovers the API.
//
// altea divergences:
//  - the snippets are rewritten for altea's API where it differs, and the entries for modules altea does not
//    have are gone: `moment` / `numbro` / `luxon` (→ `Temporal`), `TreeClient`, `WorkflowClient`. The keys
//    come from `globalModules`, so a module without a snippet still appears with an empty body — the same
//    behaviour Signum has for its own empty entries.
//  - `AutoLineModal` → the local `CopyTextModal` (see its header).
//  - Signum's `clientCode` variant documents the DynamicClient module (JavaScript executed at boot), which
//    is not ported; the parameter is gone with it.
export function ModulesHelp(p: { cleanName: string }): React.JSX.Element {

    const modules = helpByModule(p.cleanName);

    function handleModuleClick(name: string): void {
        void CopyTextModal.show(`modules.${name}`, modules[name] ?? "");
    }

    // Every module actually in scope, so the dropdown cannot drift from GlobalModules.
    const names = Dic.getKeys(globalModules);

    return (
        <DropdownButton id="modules_help_dropdown" variant="success" size="sm"
            title={DynamicViewMessage.ModulesHelp.niceToString()}>
            {names.map(name =>
                <Dropdown.Item style={{ paddingTop: "0", paddingBottom: "0" }} key={name}
                    onClick={() => handleModuleClick(name)}>{name}</Dropdown.Item>)}
        </DropdownButton>
    );
}

function helpByModule(cleanName: string): Record<string, string> {
    return {
        Temporal: `/* altea's date/time substrate — luxon and moment are not used (see CLAUDE.md) */
modules.Temporal.Now.plainDateISO();
modules.Temporal.PlainDate.from(ctx.value.orderDate).add({ days: 3 });
ctx.value.orderDate.until(ctx.value.requiredDate).days;
ctx.value.orderDate.toString(); /* ISO — always; formatting for display is a Line's job */`,

        React: `const [count, setCount] = modules.React.useState(0);

const element = modules.React.useRef(null);
/* Usage in code */
locals.element.current && locals.element.current.[Method Name];

modules.React.useEffect(() => {
  // do something here...
});`,

        Components: "",
        Globals: "",

        Navigator: `modules.Navigator.view(e);
modules.Navigator.API.fetchEntity("${cleanName}", id).then(entity => { /* do something here ... */ });
modules.Navigator.API.fetch(lite).then(entity => { /* do something here ... */ });`,

        Finder: `modules.Finder.find("${cleanName}");
modules.Finder.findMany("${cleanName}");
modules.Finder.fetchEntitiesLiteWithFilters("${cleanName}",
  [{ token: "...", operation: "...", value: "..." }],  /* filterOptions */
  [{ token: "...", orderType: "..." }],                /* orderOptions */
  1 /* count */);

/* An OPERATION is a string member name in altea, not an enum value:
   "EqualTo" | "DistinctTo" | "GreaterThan" | "GreaterThanOrEqual" | "LessThan" | "LessThanOrEqual" |
   "Contains" | "StartsWith" | "EndsWith" | "Like" | "NotContains" | "NotStartsWith" | "NotEndsWith" |
   "NotLike" | "IsIn" | "IsNotIn"
   An ORDER is "Ascending" | "Descending". */`,

        Reflection: `/* altea's display names are FLUENT statics on the entity class, not free functions:
   SomeEntity.niceName() / .nicePluralName() / .nicePropertyName(a => a.field) */
modules.Reflection.getTypeInfo(SomeEntity)?.getNiceName();
modules.Reflection.tryGetTypeInfo(SomeEntity)?.fields;`,

        Entities: `entity.toLite();
entity.isNew;
entity.isDirty();
/* NOTE altea has no compat accessors: it is entity.constructor (not .Type) and lite.entityType is a
   CONSTRUCTOR (not a string). See CLAUDE.md. */`,

        AuthClient: "modules.AuthClient.currentUser();",

        Operations: `modules.Operations.API.executeEntity(entity, SomeOperation.Save)
  .then(pack => /* do something here */);`,

        Constructor: `modules.Constructor.construct("${cleanName}").then(entity => { /* do something here */ });
modules.Constructor.constructPack("${cleanName}").then(pack => { /* do something here */ });`,

        Services: `modules.Services.ajaxGet({ url: '/api/your/route' })
  .then(result => /* do something here */)
  .then(() => locals.forceUpdate());

modules.Services.ajaxPost({ url: '/api/your/route' }, data)
  .then(result => /* do something here */)
  .then(() => locals.forceUpdate());`,

        AutoCompleteConfig: `new modules.AutoCompleteConfig.LiteAutocompleteConfig(
  (signal, subStr) => [/* your API call here */], /*requiresInitialLoad:*/ false, /*showType:*/ false)`,

        Hooks: `const forceUpdate = modules.Hooks.useForceUpdate();
const value = modules.Hooks.useAPI(signal => /* your API call */, [/*deps*/]);`,

        FontAwesomeIcon: `modules.React.createElement(modules.FontAwesomeIcon, { icon: "...", color: "..." })`,

        SelectorModal: `modules.SelectorModal.chooseElement(/*options:*/ [], /*config?*/ {})
.then(option => {
  if (!option)
    return undefined;
  /* do something here ... */
});`,
    };
}
