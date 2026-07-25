// Documents are addressable as MCP resources at evidencelens://document/{id}.
// Discovery and resolution live in server.ts; this file is a placeholder
// for future per-resource-type handlers (e.g. trials, recalls).
export const RESOURCE_TYPES = ["document"] as const;
