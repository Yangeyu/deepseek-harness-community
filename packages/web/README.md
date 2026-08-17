# Community Web providers

This package composes two independent Web capabilities over one Tavily client:

- `community-tavily` implements search through the official DeepSeek Harness
  `ctx.web` seam and its `web_search` tool.
- `community-tavily` implements the package's provider-neutral extraction seam,
  exposed to the model as `web_extract`.

`@deepseek-ai/dsh-web` and `@deepseek-ai/dsh-tool-web` remain the sole owners of
official search selection and its model contract. Tavily is not adapted as
`web_fetch`: its Extract API does not report the origin HTTP status required by
that upstream contract. The separate extraction seam keeps its URL/content
semantics honest and replaceable.

Search and extraction share authentication, JSON transport, cancellation, and
error mapping without merging their request or result contracts. The credential
is resolved for every operation and is never stored in package settings. Its
default reference is `TAVILY_API_KEY`.
