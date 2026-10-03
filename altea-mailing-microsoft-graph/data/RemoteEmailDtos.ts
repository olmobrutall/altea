/** The categorise request body. */
export interface ChangeCategoriesRequest {
    messageIds: string[];
    categoriesToAdd: string[];
    categoriesToRemove: string[];
}

/** One line of the bulk actions' NDJSON response. */
export interface EmailResult {
    id: string;
    error?: string;
}
