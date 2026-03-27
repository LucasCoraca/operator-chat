export interface ParsedBlock {
    type: 'text' | 'tool_use' | 'final_answer' | 'mode_transition';
    content: string;
    params?: Record<string, string>;
    partial: boolean;
}
export declare function parseAssistantMessage(text: string, knownToolNames: string[]): ParsedBlock[];
//# sourceMappingURL=xml-parser.d.ts.map