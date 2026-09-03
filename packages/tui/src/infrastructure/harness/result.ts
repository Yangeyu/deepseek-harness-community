export interface HarnessResult<T> {
  readonly result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } }
}

export function harnessValue<T>(response: HarnessResult<T>): T {
  if (response.result.ok) return response.result.value
  throw new Error(response.result.error.message)
}
