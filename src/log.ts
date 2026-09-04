// Bridge for the layering migration: prompts/terminal.ts is the real module, and
// the files still at src/*.ts import the writer from here. Deleted in Phase 7,
// once every caller sits in a layer directory that imports it directly.
export * from './prompts/terminal.js';
