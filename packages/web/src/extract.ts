export interface WebExtractRequest {
  url: string
}

export interface WebExtractResult {
  url: string
  content: string
  truncated: boolean
}

export interface WebExtractProvider {
  id: string
  available(): boolean
  extract(request: WebExtractRequest, signal?: AbortSignal): Promise<WebExtractResult>
}
