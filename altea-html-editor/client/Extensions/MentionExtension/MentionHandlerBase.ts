import * as React from "react";

// Port of Signum.HtmlEditor's Extensions/MentionExtension/MentionHandlerBase.ts — verbatim.
export interface MentionItem {
    /** Unique identifier stored in data-mention-key (e.g. a lite key, a slug, an id). */
    key: string;
    /** Display text shown in the chip and in the dropdown. */
    text: string;
}

export interface MentionHandlerBase {
    /** Character that opens the typeahead, e.g. '@' or '#'. */
    trigger: string;

    /** Return ALL candidates; the plugin filters them client-side. */
    getItems(): Promise<MentionItem[]>;

    /** Optional: custom rendering for a row in the dropdown list. */
    renderOption?(item: MentionItem): React.ReactNode;
}

declare module "lexical" {
    export interface LexicalEditor {
        mentionHandler?: MentionHandlerBase;
    }
}
