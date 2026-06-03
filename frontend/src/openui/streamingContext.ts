import { createContext } from 'react';

/**
 * True while the assistant message currently containing an OpenUI renderer is
 * still streaming. ChatInterface provides `true` only around the in-flight
 * reply so the renderer reveals progressively and heavy components (e.g. the
 * Video player) can defer mounting until the stream settles.
 *
 * Lives in its own module so both UIRenderer and the custom components can
 * import it without a circular dependency.
 */
export const UIStreamingContext = createContext(false);
