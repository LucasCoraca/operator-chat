export interface ParsedBlock {
  type: 'text' | 'tool_use' | 'final_answer' | 'mode_transition';
  content: string; // Text content or tool name
  params?: Record<string, string>; // For tool_use
  partial: boolean;
}

export function parseAssistantMessage(
  text: string, 
  knownToolNames: string[]
): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  let currentIndex = 0;
  const len = text.length;

  // Track state
  let currentBlockType: 'tool_use' | 'final_answer' | null = null;
  let currentBlockStart = 0;
  let currentToolName = '';
  let currentParams: Record<string, string> = {};
  let currentParamName: string | null = null;
  let currentParamStart = 0;

  // Helper to check if string starts with a tag at current index
  const startsWith = (substr: string, offset: number) => {
    return text.startsWith(substr, offset);
  };

  while (currentIndex < len) {
    // 1. Check for Block Start (if not in a block)
    if (!currentBlockType) {
      // Use regex to find any tag opening (including hyphens for MCP tools)
      const tagMatch = text.slice(currentIndex).match(/^<([a-zA-Z0-9_-]+)\s*>/);
      if (tagMatch) {
        const tagName = tagMatch[1];
        if (tagName === 'final_answer') {
          currentBlockType = 'final_answer';
          currentBlockStart = currentIndex + tagMatch[0].length;
          currentIndex += tagMatch[0].length;
          continue;
        }
        if (tagName === 'compose_reply_mode') {
          // Handle self-closing mode transition tag <compose_reply_mode></compose_reply_mode>
          const closeTag = '</compose_reply_mode>';
          const closeIndex = text.indexOf(closeTag, currentIndex);
          if (closeIndex !== -1) {
            blocks.push({
              type: 'mode_transition',
              content: 'compose_reply_mode',
              partial: false
            });
            currentIndex = closeIndex + closeTag.length;
          } else {
            // Partial tag, skip past opening
            currentIndex += tagMatch[0].length;
          }
          continue;
        }
        if (knownToolNames.includes(tagName)) {
          currentBlockType = 'tool_use';
          currentToolName = tagName;
          currentParams = {};
          currentBlockStart = currentIndex + tagMatch[0].length;
          currentIndex += tagMatch[0].length;
          continue;
        }
      }

      // Treat as text/noise if not a known block start
      currentIndex++;
      continue;
    }

    // 2. Inside a Block
    if (currentBlockType === 'final_answer') {
      if (startsWith('</final_answer>', currentIndex)) {
        blocks.push({
          type: 'final_answer',
          content: text.slice(currentBlockStart, currentIndex).trim(),
          partial: false
        });
        currentBlockType = null;
        currentIndex += 15;
      } else {
        currentIndex++;
      }
      continue;
    }

    if (currentBlockType === 'tool_use') {
      // If inside a parameter, only look for its closing tag
      if (currentParamName) {
        const paramCloseTag = `</${currentParamName}>`;
        if (startsWith(paramCloseTag, currentIndex)) {
          // Found matching close tag
          const paramValue = text.slice(currentParamStart, currentIndex).trim();
          currentParams[currentParamName] = paramValue;
          currentParamName = null;
          currentIndex += paramCloseTag.length;
          continue;
        }
        // Accumulate content
        currentIndex++;
        continue;
      }

      // If NOT inside a parameter, look for tool close or new parameter
      const closeTag = `</${currentToolName}>`;
      if (startsWith(closeTag, currentIndex)) {
        blocks.push({
          type: 'tool_use',
          content: currentToolName,
          params: currentParams,
          partial: false
        });
        currentBlockType = null;
        currentIndex += closeTag.length;
        continue;
      }

      // Check for parameter start <param> (including hyphens)
      const nextTagMatch = text.slice(currentIndex).match(/^<([a-zA-Z0-9_-]+)\s*>/);
      if (nextTagMatch) {
        const paramName = nextTagMatch[1];
        // Verify it's not the tool tag itself
        if (paramName !== currentToolName) {
          currentParamName = paramName;
          currentParamStart = currentIndex + nextTagMatch[0].length;
          currentIndex += nextTagMatch[0].length;
          continue;
        }
      }
      
      // Accumulate whitespace/noise between params
      currentIndex++;
    }
  }

  // Handle Partial Blocks (End of Stream)
  if (currentBlockType === 'final_answer') {
    blocks.push({
      type: 'final_answer',
      content: text.slice(currentBlockStart).trim(),
      partial: true
    });
  } else if (currentBlockType === 'tool_use') {
    // If inside a param, save it first
    if (currentParamName) {
      currentParams[currentParamName] = text.slice(currentParamStart).trim();
    }
    blocks.push({
      type: 'tool_use',
      content: currentToolName,
      params: currentParams,
      partial: true
    });
  }

  return blocks;
}
