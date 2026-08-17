# Community Web providers

This package composes two independent Web capabilities:

- `community-brave` implements search through the official DeepSeek Harness
  `ctx.web` seam and its `web_search` tool.
- `community-tavily` implements the package's provider-neutral extraction seam,
  exposed to the model as `web_extract`.

`@deepseek-ai/dsh-web` and `@deepseek-ai/dsh-tool-web` remain the sole owners of
official search selection and its model contract. Tavily is not adapted as
`web_fetch`: its Extract API does not report the origin HTTP status required by
that upstream contract. The separate extraction seam keeps its URL/content
semantics honest and replaceable.

Credentials are references resolved for every operation and are never stored in
this package's settings. The default references are `BRAVE_API_KEY` and
`TAVILY_API_KEY`.
