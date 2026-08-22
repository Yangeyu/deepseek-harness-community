# Bailian provider

`llm-bailian` is a first-class Alibaba Cloud Bailian Provider for the DeepSeek
Harness LLM seam. It implements the DashScope OpenAI-compatible HTTP and SSE
wire protocol directly; it does not depend on OpenAI SDK, pi-ai, or
`dsh-llm-pi-ai`.

The plugin owns one route, `bailian`, and one settings namespace,
`llm-bailian`. Consumers select `bailian/<model>` through `ctx.llm`; they do not
read provider settings or credentials.

The Provider stays in this repository as a private workspace package. The
published application exposes the same implementation through
`@vascent/dsh-tui/bailian`; it does not depend on TUI runtime or presentation
code. Its module boundary is independent, while release ownership remains at
the repository root.

```yaml
llm-bailian:
  baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
  models:
    deepseek-v4-pro-0813:
      contextWindow: 1000000
      maxOutputTokens: 393216
      maxTokensField: max_tokens
      input: [text]
      reasoning:
        defaultEffort: high
        efforts:
          off: { enableThinking: false }
          low: { enableThinking: true, reasoningEffort: low }
          high: { enableThinking: true, reasoningEffort: high }
          max: { enableThinking: true, reasoningEffort: max }
    qwen3.7-plus:
      name: Qwen3.7 Plus
      contextWindow: 1000000
      maxOutputTokens: 131072
      maxTokensField: max_completion_tokens
      input: [text, image]
      reasoning:
        defaultEffort: high
        efforts:
          off: { enableThinking: false }
          high: { enableThinking: true }
```

`DASHSCOPE_API_KEY` is the default credential reference. The key is resolved
through the Harness credential service, or the trusted launch environment when
that service is absent. It is never stored in provider settings.

Model IDs are dictionary keys, so private deployments and new models require
configuration rather than code branches. `contextWindow`, `maxOutputTokens`,
`maxTokensField`, and `input` describe the exact deployed model. Optional
`defaultMaxTokens` is the only field that creates a request default;
`maxOutputTokens` alone never adds a token parameter.

Reasoning effort entries explicitly describe their wire fields. A level may
set `enableThinking`, `reasoningEffort`, `thinkingBudget`, or a valid
combination. Unsupported efforts fail before a request is sent. This keeps
Qwen thinking toggles, DeepSeek reasoning levels, and future Bailian model
dialects data-driven.

The transport appends `/chat/completions` to `baseURL`, sends Harness
attribution headers, resolves durable image attachments into data URLs, and
maps provider reasoning, text, tool-call, usage, error, timeout, and cancellation
events into the standard `StreamChunk` contract.
