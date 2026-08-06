import * as React from "react";
import { useLocation, useParams } from "react-router";
import { Finder } from "../Finder";
import type { FindOptions } from "../FindOptions";
import SearchControl, { type SearchControlHandler } from "./SearchControl";
import { getQueryNiceName } from "../Reflection";
import * as AppContext from "../AppContext";
import { QueryString } from "../QueryString";
import { useAPI, useForceUpdate } from "../Hooks";

// Full-page search (Signum's SearchControl/SearchPage): the element behind the /find/:queryName route.
// Parses the route param + query string into a FindOptions, loads the QueryToken, and renders a
// SearchControl. Trimmed vs Signum: no usePageUIState restore, and avoidChangeUrl is on (altea's
// AppContext.navigate is still a full-page reload — Signum's replace-in-history URL sync waits until
// AppContext routes through react-router history).
function SearchPage(): React.ReactElement {
  const params = useParams<{ queryName: string }>();
  const location = useLocation();
  const forceUpdate = useForceUpdate();
  const searchControl = React.useRef<SearchControlHandler | null | undefined>(undefined);

  const fo: FindOptions = Finder.parseFindOptionsPath(params.queryName!, QueryString.parse(location.search));
  const qt = useAPI(() => Finder.getQueryRoot(fo.queryName), [fo.queryName]);

  AppContext.useTitle(getQueryNiceName(params.queryName!));

  function onResize(): void {
    const containerDiv = searchControl.current?.searchControlLoaded?.containerDiv;
    if (containerDiv) {
      const marginTop = containerDiv.offsetTop;
      const maxHeight = window.innerHeight - (marginTop + SearchPage.Options.marginDown);
      containerDiv.style.maxHeight = Math.max(maxHeight, SearchPage.Options.minHeight) + "px";
    }
  }

  React.useEffect(() => {
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const setSearchControl = React.useCallback((sc: SearchControlHandler | null) => {
    searchControl.current = sc;
    onResize();
  }, []);

  if (!Finder.isFindable(fo.queryName, true))
    return <div id="divSearchPage"><h3 className="text-danger">Query “{params.queryName}” is not allowed</h3></div>;

  const qs = Finder.getSettings(fo.queryName);
  return (
    <div id="divSearchPage" className="sf-search-page">
      <h1 className="display-6 sf-query-title h3">{getQueryNiceName(fo.queryName)}</h1>
      {qt && <SearchControl ref={setSearchControl}
        defaultIncludeDefaultFilters={true}
        findOptions={fo}
        tag="SearchPage"
        throwIfNotFindable={true}
        showBarExtension={true}
        allowSelection={qs && qs.allowSelection}
        hideFullScreenButton={true}
        largeToolbarButtons={true}
        showGroupButton={true}
        showSystemTimeButton={true}
        showFooter={true}
        avoidChangeUrl={true}
        maxResultsHeight={"none"}
        enableAutoFocus={true}
        onHeighChanged={onResize}
        onPageTitleChanged={forceUpdate}
      />}
    </div>
  );
}

namespace SearchPage {
  export const Options = {
    marginDown: 90,
    minHeight: 240,
  };
}

export default SearchPage;
