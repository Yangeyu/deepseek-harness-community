# Bailian provider

First-class Alibaba Cloud Bailian provider for DeepSeek Harness. It owns the
DashScope endpoint, credential contract, and OpenAI-compatible request policy.
The `llm-bailian` settings section declares the provider connection and the
models that route serves. `agent-default-model` independently selects one of
those registered models for new Agent sessions.

```yaml
llm-bailian:
  baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
  models:
    - id: deepseek-v4-pro-0813
      contextWindow: 1000000
      maxTokens: 393216
      input: [text]
      reasoning:
        defaultEffort: high
        efforts: [low, high, max]
    - id: qwen3.7-plus
      contextWindow: 1000000
      maxTokens: 131072
      input: [text, image]
      reasoning:
        defaultEffort: high
```

`baseURL` is the complete OpenAI-compatible API root. The provider uses it as
written apart from removing trailing slashes; it does not guess or append API
paths. `DASHSCOPE_API_KEY` is the default credential reference and secrets stay
in the Harness credential service or process environment.

Every model entry is explicit configuration rather than a code-owned preset.
`contextWindow`, `maxTokens`, and `input` are model capabilities consumed by
Harness. `maxTokens` is not silently applied as a request limit; a caller that
wants a smaller output cap supplies it on that request. The optional `name`
field changes only the display label.

The default Agent model is selected separately:

```yaml
agent-default-model:
  provider: bailian
  model: deepseek-v4-pro-0813
  reasoningEffort: max
```

A private or newly released model uses the same descriptor; no provider code
or package patch is required:

```yaml
llm-bailian:
  baseURL: https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
  models:
    - id: private-deployment-v7
      contextWindow: 200000
      maxTokens: 20000
      input: [text]
      reasoning:
        defaultEffort: max
        efforts: [low, high, max]
```

Every reasoning model uses Bailian's `enable_thinking` request parameter.
`off` is a real selectable effort: it sends `enable_thinking: false` and no
`reasoning_effort`. The optional `efforts` list contains only values accepted by
Bailian's `reasoning_effort` parameter; those values are sent unchanged. Omit
the list for an `enable_thinking`-only model. `thinkingBudget` maps directly to
Bailian's `thinking_budget`. `off` is automatically available for every
reasoning model because it is represented by `enable_thinking: false`, not by a
`reasoning_effort` value. Setting `reasoning: false`, or omitting `reasoning`,
declares a non-reasoning model.

The runtime settings schema includes every supported field and effort value, so
schema-backed configuration surfaces can provide completion and validation.
