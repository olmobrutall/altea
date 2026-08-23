import { msg } from "@altea/altea/data/utils/localization";

// Port of Signum's `MarkdownMessage` (Signum/Entities/EnumMessages.cs) — the two labels the MarkdownLine's
// edit/preview toggle shows.
//
// ALTEA: Signum declares this enum in its CORE assembly, beside every other message container; here it lives
// in the module that owns the concept, exactly as `HtmlEditorMessage` does. Nothing outside this package
// reads it, and a message in core has to be translated by every application whether or not it installs the
// module.
export const MarkdownMessage = {
    Edit0: msg("Edit {0}"),
    Preview0: msg("Preview {0}"),
};
