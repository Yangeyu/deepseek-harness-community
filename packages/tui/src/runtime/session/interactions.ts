import type { MuxFrame, RpcId } from '@deepseek-ai/dsh-host-apiproxy'

/** Answerable approval request delivered by the mux stream. */
export type ApprovalPrompt = Extract<MuxFrame, { type: 'approval/requested' }> & { rpcId: RpcId }

/** Answerable question batch delivered by the mux stream. */
export type QuestionPrompt = Extract<MuxFrame, { type: 'question/requested' }> & { rpcId: RpcId }

/** Authoritative Host notification that a pending terminal interaction is no longer answerable. */
export type InteractionResolution =
  | Extract<MuxFrame, { type: 'approval/resolved' }>
  | Extract<MuxFrame, { type: 'question/resolved' }>

export type SessionInteractionEvent =
  | { readonly type: 'approval'; readonly prompt: ApprovalPrompt }
  | { readonly type: 'questions'; readonly prompt: QuestionPrompt }
  | { readonly type: 'resolved'; readonly resolution: InteractionResolution }

export type SessionInteractionListener = (event: SessionInteractionEvent) => void
