import * as React from "react";
import { AbortableRequest } from "@altea/altea/client/Services";
import * as AppContext from "@altea/altea/client/AppContext";
import { Typeahead, ErrorBoundary } from "@altea/altea/client/Components";
import type { TypeaheadController } from "@altea/altea/client/Components/Typeahead";
import type { HelpOmniboxResult, OmniboxResult } from "../data/OmniboxResults";
import { OmniboxResultTypeName } from "../data/OmniboxResults";
import { OmniboxMessage } from "../data/OmniboxMessages";
import { OmniboxClient } from "./OmniboxClient";
import "./Omnibox.css";

// Port of Signum's `OmniboxAutocomplete` (Signum.Omnibox/OmniboxAutocomplete.tsx): the navbar input.
// A Typeahead whose items come from `/api/omnibox` (one in-flight request, the previous aborted), where
//   Enter / click → run the result's navigateTo and push the URL,
//   Tab           → replace the input text with the result's canonical form (disambiguation),
//   minLength 0   → an empty box already shows the syntax guide.
// Help rows are non-selectable; the un-referenced ones act as section headers.
export interface OmniboxAutocompleteProps {
    inputAttrs?: React.InputHTMLAttributes<HTMLInputElement>;
}

export default function OmniboxAutocomplete(p: OmniboxAutocompleteProps): React.JSX.Element {

    const typeahead = React.useRef<TypeaheadController>(null);
    const abortRequest = React.useMemo(() => new AbortableRequest((ac: AbortSignal, query: string) => OmniboxClient.API.getResults(query, ac)), []);

    function handleOnSelect(result: OmniboxResult, e: React.KeyboardEvent<any> | React.MouseEvent<any>): string | null {
        abortRequest.abort();

        const ke = e as React.KeyboardEvent<any>;
        if (ke.key == "Tab") {
            if (result.resultTypeName == OmniboxResultTypeName.Help)
                return "";

            return OmniboxClient.toString(result);
        }

        const promise = OmniboxClient.navigateTo(result);
        if (promise) {
            void promise
                .then(url => {
                    if (url)
                        AppContext.pushOrOpenInTab(url, e);
                });
        }
        typeahead.current!.blur();

        return null;
    }

    const inputAttr = { placeholder: OmniboxMessage.Search.niceToString(), ...p.inputAttrs };

    return (
        <ErrorBoundary>
            <Typeahead ref={typeahead} getItems={str => abortRequest.getData(str)}
                renderItem={item => OmniboxClient.renderItem(item as OmniboxResult)}
                isHeader={item => (item as OmniboxResult).resultTypeName == OmniboxResultTypeName.Help && (item as HelpOmniboxResult).referencedTypeName == null}
                isDisabled={item => (item as OmniboxResult).resultTypeName == OmniboxResultTypeName.Help}
                onSelect={(item, e) => handleOnSelect(item as OmniboxResult, e)}
                inputAttrs={inputAttr}
                minLength={0}
                noResultsMessage={OmniboxMessage.NotFound.niceToString()}
            />
        </ErrorBoundary>
    );
}
