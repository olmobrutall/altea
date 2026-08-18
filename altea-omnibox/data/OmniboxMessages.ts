import { init } from "@altea/altea/data/reflection";
import { msg } from "@altea/altea/data/utils/localization";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";

// Port of Signum's `OmniboxMessage` enum (Signum.Omnibox/OmniboxUtils.cs) + the generated
// Signum.Omnibox.ts message keys. altea message containers are `{ Member: msg("Default") }` objects;
// `.niceToString(...)` formats {0}/{1} and prefers a loaded translation. Each C# `[Description("…")]`
// becomes the msg() argument; a bare `msg()` infers the English default from the member name.
export const OmniboxMessage = {
    No: msg("no"),
    NotFound: msg("[Not found]"),
    Omnibox_DatabaseAccess: msg("Searching between 'apostrophe' will make queries to the database"),
    Omnibox_Disambiguate: msg("With [Tab] you disambiguate you query"),
    Omnibox_Field: msg("Field"),
    Omnibox_Help: msg("Help"),
    Omnibox_OmniboxSyntaxGuide: msg("Omnibox Syntax Guide:"),
    Omnibox_MatchingOptions: msg("You can match results by (st)art, mid(dle) or (U)pper(C)ase"),
    Omnibox_Query: msg("Query"),
    Omnibox_Type: msg("Type"),
    Omnibox_UserChart: msg("UserChart"),
    Omnibox_UserQuery: msg("UserQuery"),
    Omnibox_Dashboard: msg("Dashboard"),
    Omnibox_Value: msg("Value"),
    Unknown: msg(),
    Yes: msg("yes"),
    Search: msg("Search..."),
};

// Port of Signum's `[AutoInit] static class OmniboxPermission`. Reuses altea-auth's ONE PermissionSymbol
// class/table — the quote-transformer rewrites `init()` into `init(PermissionSymbol,
// "OmniboxPermission.ViewOmnibox", …)`, registering it in the declared-symbols set that
// SymbolLogic.start(sb, PermissionSymbol) (already called by the auth module) seeds. So merely importing
// this module — OmniboxLogic does — is enough for it to be seeded and authorizable.
export namespace OmniboxPermission {
    export const ViewOmnibox: PermissionSymbol = init();
}
