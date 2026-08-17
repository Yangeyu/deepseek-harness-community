import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { WebExtractRequest, WebExtractResult } from './extract.ts'

export const WEB_EXTRACT_TOOL_NAME = 'web_extract'
export const WEB_EXTRACT_TIMEOUT_MS = 45_000

const TRUNCATION_NOTICE = '\n\n(Content truncated. Extract a more specific URL for narrower content.)'

export interface WebExtractToolOptions {
  extract(request: WebExtractRequest, signal?: AbortSignal): Promise<WebExtractResult>
}

function renderedContent(result: WebExtractResult): string {
  return `Extracted ${result.url}\n\n${result.content}${result.truncated ? TRUNCATION_NOTICE : ''}`
}

function renderResult(result: WebExtractResult): ContentBlock[] {
  return [{ type: 'text', text: renderedContent(result) }]
}

/** Build the provider-neutral page extraction tool independently from Cordis composition. */
export function createWebExtractTool(options: WebExtractToolOptions): ToolDefinition {
  return defineTool({
    name: WEB_EXTRACT_TOOL_NAME,
    description: 'Extract readable Markdown from one public HTTP(S) URL. Use this after web_search when source snippets are insufficient.',
    parameters: {
      url: {
        type: 'string',
        required: true,
        description: 'The absolute HTTP(S) URL whose readable page content should be extracted.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          content: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => renderResult(value),
    },
    timeoutMs: WEB_EXTRACT_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const url = args.url.trim()
      if (url === '') throw new Error('url must be a non-empty string')
      return options.extract({ url }, exec.signal)
    },
    presentCall: args => ({
      card: 'generic',
      title: args.url,
      kind: 'read',
      rawInput: args.url,
    }),
  })
}
