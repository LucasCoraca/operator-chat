import React, { useState } from 'react';

interface CodeBlockProps {
  inline?: boolean;
  className?: string;
  children?: React.ReactNode;
  node?: any;
  [key: string]: any;
}

interface PreBlockProps {
  children?: React.ReactNode;
  node?: any;
  [key: string]: any;
}

export const PreBlock: React.FC<PreBlockProps> = ({ children, node, ...props }) => {
  const [copied, setCopied] = useState(false);

  // Fallback copy function for when navigator.clipboard is not available
  const copyToClipboardFallback = (text: string) => {
    try {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.top = '0';
      textArea.style.left = '0';
      textArea.style.width = '2px';
      textArea.style.height = '2px';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      return true;
    } catch (error) {
      console.error('Fallback copy failed:', error);
      return false;
    }
  };

  // Modern copy function using Clipboard API with fallback
  const copyToClipboard = async (text: string) => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      } else {
        return copyToClipboardFallback(text);
      }
    } catch (error) {
      console.error('Clipboard API failed, trying fallback:', error);
      return copyToClipboardFallback(text);
    }
  };

  // Extract the code element from children
  const codeElement = React.Children.toArray(children).find(
    child => React.isValidElement(child) && child.type === 'code'
  ) as React.ReactElement | undefined;

  // Extract language from multiple sources
  // 1. From node.children[0].properties.className (react-markdown passes it here)
  // 2. From codeElement props (className like "language-python")
  // 3. From node.data.meta (metadata)
  // 4. From node.value (the raw code block content)
  let language = 'text';
  
  // Try to get language from node.children[0].properties.className
  // react-markdown passes the className as an array: ["language-cpp"]
  if (node?.children?.[0]?.properties?.className) {
    const classNameArray = node.children[0].properties.className;
    if (Array.isArray(classNameArray)) {
      const className = classNameArray.join(' ');
      const match = /language-(\w+)/.exec(className);
      if (match) {
        language = match[1];
      }
    } else if (typeof classNameArray === 'string') {
      const match = /language-(\w+)/.exec(classNameArray);
      if (match) {
        language = match[1];
      }
    }
  }
  
  // Try to get language from node.lang (this is the standard way react-markdown passes it)
  if (language === 'text' && node?.lang) {
    language = node.lang;
  }
  
  // Try to get language from node.data.meta (e.g., "cpp" or "cpp showLineNumbers")
  if (language === 'text' && node?.data?.meta) {
    const meta = node.data.meta;
    const metaMatch = meta.match(/(\w+)/);
    if (metaMatch) {
      language = metaMatch[1];
    }
  }
  
  // Try to get language from className (e.g., "language-python")
  if (language === 'text') {
    const className = codeElement?.props.className || props.className || '';
    const match = /language-(\w+)/.exec(className);
    if (match) {
      language = match[1];
    }
  }
  
  // Try to get language from node.value (the raw code block starts with ```language)
  if (language === 'text' && node?.value) {
    const valueMatch = node.value.match(/^```(\w+)/);
    if (valueMatch) {
      language = valueMatch[1];
    }
  }

  const handleCopy = async () => {
    const text = codeElement 
      ? String(codeElement.props.children).replace(/\n$/, '')
      : String(children);
    
    const success = await copyToClipboard(text);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (!codeElement) {
    return (
      <div className="rounded-xl overflow-hidden border border-white/10 bg-[#0d0d0d] shadow-lg my-4">
        <div className="bg-[#1a1a1a] px-4 py-2 text-xs text-zinc-400 flex justify-between items-center border-b border-white/5">
          <span className="font-mono">{language}</span>
          <button
            onClick={handleCopy}
            className="hover:text-zinc-100 flex items-center gap-1.5 transition-colors"
          >
            {copied ? (
              <>
                <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span>Copied!</span>
              </>
            ) : (
              <>
                <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                <span>Copy code</span>
              </>
            )}
          </button>
        </div>
        <div className="p-4">
          <pre className="m-0 font-mono text-[13px] leading-relaxed text-zinc-300 whitespace-pre-wrap break-words overflow-x-auto">{children}</pre>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl overflow-hidden border border-white/10 bg-[#0d0d0d] shadow-lg my-4">
      <div className="bg-[#1a1a1a] px-4 py-2 text-xs text-zinc-400 flex justify-between items-center border-b border-white/5">
        <span className="font-mono">{language}</span>
        <button
          onClick={handleCopy}
          className="hover:text-zinc-100 flex items-center gap-1.5 transition-colors"
        >
          {copied ? (
            <>
              <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span>Copied!</span>
            </>
          ) : (
            <>
              <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              <span>Copy code</span>
            </>
          )}
        </button>
      </div>
      <div className="p-4">
        <pre className="m-0 font-mono text-[13px] leading-relaxed text-zinc-300 overflow-x-auto">
          <code className="bg-transparent text-zinc-300 p-0">{codeElement.props.children}</code>
        </pre>
      </div>
    </div>
  );
};

const CodeBlock: React.FC<CodeBlockProps> = ({ inline, className, children, ...props }) => {
  if (inline) {
    return (
      <code className="bg-surface-200 px-1.5 py-0.5 rounded text-sm" {...props}>
        {children}
      </code>
    );
  }

  return (
    <code className={className} {...props}>
      {children}
    </code>
  );
};

export default CodeBlock;
