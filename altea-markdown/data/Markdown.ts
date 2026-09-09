import { setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { msg } from "@altea/altea/data/utils/localization";

// The two labels the MarkdownLine's edit/preview toggle shows. Declared in the module that owns the
// concept, exactly as `HtmlEditorMessage` is — a message in core has to be translated by every application
// whether or not it installs the module.
//
// Port of Signum's MarkdownMessage — see docs/port/Markdown.md.
export const MarkdownMessage = {
    Edit0: msg("Edit {0}"),
    Preview0: msg("Preview {0}"),
};

setDefaultDatabaseSchema("markdown");
