import type { SourceMapping } from '../domain/types';

export interface OverlayUrls {
  css: string;
  js: string;
}

export interface InstrumentationResult {
  /** The instrumented source with pinpoint ids and overlay references. */
  content: string;
  /** One mapping per instrumented element. */
  mappings: SourceMapping[];
}
