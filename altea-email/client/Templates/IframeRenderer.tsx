import * as React from "react";

// Port of Signum.Mailing's Templates/IframeRenderer.tsx — render a message body's HTML in an <iframe>, so
// its styles cannot leak into the app's.
export interface IFrameRendererProps extends React.HTMLAttributes<HTMLIFrameElement> {
    html: string | null | undefined;
    manipulateDom?: (doc: Document) => void;
}

export default function IFrameRenderer({ html, manipulateDom, ...props }: IFrameRendererProps): React.JSX.Element {

    const iframe = React.useRef<HTMLIFrameElement>(null);

    React.useEffect(() => {
        const doc = iframe.current?.contentDocument;
        if (doc == null)
            return;

        doc.body.innerHTML = html ?? "";
        manipulateDom?.(doc);
    }, [html]);

    return <iframe {...props} ref={iframe}></iframe>;
}
