import * as React from "react";
import AutoLineModal from "@altea/altea/client/AutoLineModal";
import { TextAreaLine } from "@altea/altea/client/Lines/TextAreaLine";
import { TypeReference } from "@altea/altea/data/reflection";

// The designer's "here is some generated snippet, copy it" dialog — Signum spells the same AutoLineModal
// options out at each of its call sites; there are four here, so they share this one.
export namespace CopyTextModal {
    export function show(title: React.ReactNode, text: string): Promise<unknown> {
        return AutoLineModal.show({
            type: new TypeReference({ typeName: "String" }),
            initialValue: text,
            customComponent: p => <TextAreaLine {...p} />,
            title,
            message: "Copy to clipboard: Ctrl+C, ESC",
        });
    }
}
