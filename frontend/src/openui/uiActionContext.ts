import { createContext } from 'react';

/**
 * Sends a message to the assistant on behalf of an OpenUI button.
 *
 * OpenUI buttons fire host-facing actions: a button with no explicit action (or
 * an @ToAssistant step) asks the host to continue the conversation with a given
 * message. ChatInterface provides this so UIRenderer can turn those clicks into
 * a real user message. null when no provider is mounted (clicks are then no-ops).
 */
export type SendToAssistant = (message: string) => void;

export const UISendToAssistantContext = createContext<SendToAssistant | null>(null);
