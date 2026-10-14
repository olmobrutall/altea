import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// altea's theme adds font sizes (`text-h3`, `text-display-6`) that tailwind-merge would otherwise read as
// colours, and so fail to see that `text-h3` and `text-sm` conflict.
const twMerge = extendTailwindMerge({
    extend: {
        theme: {
            text: ["h1", "h2", "h3", "h4", "h5", "h6",
                "display-1", "display-2", "display-3", "display-4", "display-5", "display-6", "display-7"],
        },
    },
});

/** Joins class lists and lets a later Tailwind class override an earlier conflicting one. */
export function cn(...inputs: ClassValue[]): string {
    return twMerge(clsx(inputs));
}
