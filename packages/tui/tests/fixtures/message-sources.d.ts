import type { ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'agent': { readonly kind: 'agent' } & ContextFormed
    'fixture': { readonly kind: 'fixture' } & ContextFormed
    'producer': { readonly kind: 'producer' } & ContextFormed
    'skills': { readonly kind: 'skills' } & ContextFormed
    'test': { readonly kind: 'test' } & ContextFormed
    'worker': { readonly kind: 'worker' } & ContextFormed
    'workspace': { readonly kind: 'workspace' } & ContextFormed
  }
}
