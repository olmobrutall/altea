import { msg } from "@altea/altea/data/utils/localization";

// Port of Signum's `HtmlEditorMessage` enum (Signum/Entities/EnumMessages.cs).
//
// altea divergence: Signum declares these in CORE, because its enum lives in Signum.Entities and the
// framework's TSGenerator emits it there. altea has no reason to: a module owns its own messages (as
// ConcurrentUserMessage and ChatbotMessage do), and keeping them here means core carries no text for a
// module an application may never install.
export const HtmlEditorMessage = {
    Hyperlink: msg("Hyperlink"),
    EnterYourUrlHere: msg("Enter your url here..."),
    Bold: msg("Bold (Ctrl + B)"),
    Italic: msg("Italic (Ctrl + I)"),
    Underline: msg("Underline (Ctrl + U)"),
    Headings: msg("Headings"),
    UnorderedList: msg("Unordered list"),
    OrderedList: msg("Ordered list"),
    Quote: msg("Quote"),
    CodeBlock: msg("Code block"),
    Code: msg("Code"),

    // altea addition: Signum's ToolbarLinkButton hardcodes this one in English.
    InsertHyperlink: msg("Insert hyperlink"),
    RemoveLink: msg("Remove link"),
};
