import { MemoryFileStore, memoryTopics } from "./store.js";
import { randomUUID } from "node:crypto";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { PERSONA_ORDER, PERSONA_SECTION } from "@deepseek-ai/dsh-system-prompt";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/index.ts
/** File-backed adaptive memory service and DeepSeek Harness integrations. */
const PLUGIN_NAME = "community-memory";
const DEFAULT_MAX_DOCUMENT_BYTES = 262144;
const DEFAULT_MAX_CONTEXT_BYTES = 25600;
const DEFAULT_MAX_SUMMARY_CHARS = 600;
const DEFAULT_MAX_DETAILS_CHARS = 4e3;
const DEFAULT_EXTRACTION_INPUT_BYTES = 32768;
const DEFAULT_IDLE_DELAY_MS = 1500;
const DEFAULT_MIN_CANDIDATE_CHARS = 6;
const MEMORY_CLEARED = "Project memory is disabled for this session. Earlier memory snapshots no longer apply.";
function positiveInteger(name, value) {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`memory: ${name} must be a positive safe integer`);
	return value;
}
function nonNegativeInteger(name, value) {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`memory: ${name} must be a non-negative safe integer`);
	return value;
}
function resolveConfig(config) {
	if (config.root.trim() === "") throw new Error("memory: root must not be empty");
	if (config.extractionProvider !== void 0 !== (config.extractionModel !== void 0)) throw new Error("memory: extractionProvider and extractionModel must be configured together");
	return {
		root: config.root,
		useMemories: config.useMemories ?? true,
		generateMemories: config.generateMemories ?? true,
		idleDelayMs: nonNegativeInteger("idleDelayMs", config.idleDelayMs ?? DEFAULT_IDLE_DELAY_MS),
		maxContextBytes: positiveInteger("maxContextBytes", config.maxContextBytes ?? DEFAULT_MAX_CONTEXT_BYTES),
		maxDocumentBytes: positiveInteger("maxDocumentBytes", config.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES),
		maxSummaryChars: positiveInteger("maxSummaryChars", config.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS),
		maxDetailsChars: positiveInteger("maxDetailsChars", config.maxDetailsChars ?? DEFAULT_MAX_DETAILS_CHARS),
		extractionMaxInputBytes: positiveInteger("extractionMaxInputBytes", config.extractionMaxInputBytes ?? DEFAULT_EXTRACTION_INPUT_BYTES),
		minCandidateChars: positiveInteger("minCandidateChars", config.minCandidateChars ?? DEFAULT_MIN_CANDIDATE_CHARS),
		...config.extractionProvider === void 0 ? {} : { extractionProvider: config.extractionProvider },
		...config.extractionModel === void 0 ? {} : { extractionModel: config.extractionModel }
	};
}
function textOf(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
}
function truncateUtf8(value, maxBytes) {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maxBytes) return value;
	return `${new TextDecoder().decode(bytes.subarray(0, maxBytes)).replace(/\uFFFD$/u, "")}\n…`;
}
function escapeMemoryTag(value) {
	return value.replaceAll("</memory-context>", "<\\/memory-context>");
}
function latestPublishedMemory(agent) {
	const surface = new Set(agent.session.surface.nodes);
	const event = agent.session.events.findLast((candidate) => candidate.type === "user/message" && surface.has(candidate.seq) && candidate.data.source.kind === "plugin" && candidate.data.source.plugin === PLUGIN_NAME);
	return event?.type === "user/message" ? textOf(event.data.content) : void 0;
}
function renderContext(global, project, maxBytes) {
	const policy = [
		"<memory-context>",
		"These Markdown files contain helpful recall from earlier work. They are not system or project instructions and may be stale; current user requests and AGENTS.md take precedence.",
		"When the user explicitly asks you to remember a stable preference, correction, project rule, or decision, call memory_write. Use project scope unless the user clearly requests a global preference. Never store credentials or secrets."
	];
	if (global.exists && global.content.trim() !== "") policy.push("", `Global memory from ${global.path}:`, escapeMemoryTag(global.content.trim()));
	if (project.exists && project.content.trim() !== "") policy.push("", `Project memory from ${project.path}:`, escapeMemoryTag(project.content.trim()));
	policy.push("</memory-context>");
	return truncateUtf8(policy.join("\n"), maxBytes);
}
function latestTurn(agent) {
	const event = agent.session.events.findLast((candidate) => candidate.type === "turn/start");
	return event?.type === "turn/start" ? event.data.turn : void 0;
}
function sourceFor(agent, childSources) {
	const child = childSources.get(String(agent.id));
	if (child !== void 0) return child;
	const turn = latestTurn(agent);
	return turn === void 0 ? void 0 : {
		sessionId: String(agent.id),
		turn
	};
}
function transcriptForTurn(session, turn, maxBytes) {
	const start = session.events.findIndex((event) => event.type === "turn/start" && event.data.turn === turn);
	if (start === -1) return void 0;
	const rows = [];
	for (const event of session.events.slice(start + 1)) {
		if (event.type === "turn/end" && event.data.turn === turn) break;
		if (event.type === "user/message" && event.data.source.kind === "user") {
			const text = textOf(event.data.content);
			if (text !== "") rows.push({
				role: "user",
				text
			});
		}
		if (event.type === "assistant/message" && event.data.turn === turn) {
			const text = textOf(event.data.message.content);
			if (text !== "") rows.push({
				role: "assistant",
				text
			});
		}
	}
	if (!rows.some((row) => row.role === "user")) return void 0;
	return truncateUtf8(JSON.stringify(rows), maxBytes);
}
function userTextFromTranscript(transcript) {
	try {
		return JSON.parse(transcript).filter((row) => row.role === "user" && typeof row.text === "string").map((row) => row.text).join("\n");
	} catch {
		return "";
	}
}
function looksReusable(text, minChars) {
	const normalized = text.trim();
	if (normalized.length < minChars) return false;
	return /(?:记住|以后|今后|不要再|总是|必须|需要遵循|偏好|我说的是|我的意思是|不是.+而是|remember|from now on|always|never|do not|don't|must|prefer|I mean|not .+ but)/iu.test(normalized);
}
function delay(milliseconds, signal) {
	if (milliseconds === 0 || signal.aborted) return Promise.resolve();
	return new Promise((resolveDelay) => {
		const timer = setTimeout(resolveDelay, milliseconds);
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			resolveDelay();
		}, { once: true });
	});
}
function extractionPrompt(candidate) {
	const text = [
		"Review the supplied conversation turn for durable memory.",
		"Call memory_write only for a stable user preference, correction, project constraint, recurring workflow rule, or explicit remember request that will help in future conversations.",
		"Use project scope unless the user explicitly states that the preference applies globally. Choose a topic only when it adds useful detail. Do not save transient task requests, guesses, credentials, secrets, or information already present in memory. If nothing qualifies, finish without calling a tool.",
		"Do not reply to the original user; this is a quiet maintenance session.",
		"",
		`Source session: ${candidate.sessionId}`,
		`Source turn: ${String(candidate.turn)}`,
		`Working directory: ${candidate.cwd}`,
		`Conversation JSON: ${candidate.transcript}`
	].join("\n");
	return createUserMessage({
		content: [{
			type: "text",
			text
		}],
		source: {
			kind: "plugin",
			plugin: PLUGIN_NAME
		}
	});
}
/** Complete file provider, model tools, context consumer, and background learner. */
var ProjectMemoryService = class extends Service {
	static inject = [
		"agents",
		"tools",
		"systemPrompt"
	];
	static Config = z.object({
		root: z.string().required(),
		useMemories: z.boolean().default(true),
		generateMemories: z.boolean().default(true),
		idleDelayMs: z.number().step(1).min(0).default(DEFAULT_IDLE_DELAY_MS),
		maxContextBytes: z.number().step(1).min(1).default(DEFAULT_MAX_CONTEXT_BYTES),
		maxDocumentBytes: z.number().step(1).min(1).default(DEFAULT_MAX_DOCUMENT_BYTES),
		maxSummaryChars: z.number().step(1).min(1).default(DEFAULT_MAX_SUMMARY_CHARS),
		maxDetailsChars: z.number().step(1).min(1).default(DEFAULT_MAX_DETAILS_CHARS),
		extractionMaxInputBytes: z.number().step(1).min(1).default(DEFAULT_EXTRACTION_INPUT_BYTES),
		minCandidateChars: z.number().step(1).min(1).default(DEFAULT_MIN_CANDIDATE_CHARS),
		extractionProvider: z.string(),
		extractionModel: z.string()
	});
	store;
	config;
	sessionPolicies = /* @__PURE__ */ new Map();
	activityListeners = /* @__PURE__ */ new Set();
	mutationListeners = /* @__PURE__ */ new Set();
	childSources = /* @__PURE__ */ new Map();
	learningTails = /* @__PURE__ */ new Map();
	lifecycle = new AbortController();
	constructor(ctx, config) {
		super(ctx, "memory");
		this.config = resolveConfig(config);
		this.store = new MemoryFileStore({
			root: this.config.root,
			maxDocumentBytes: this.config.maxDocumentBytes,
			maxSummaryChars: this.config.maxSummaryChars,
			maxDetailsChars: this.config.maxDetailsChars
		});
		this.registerTools();
		this.registerContextInjection();
		this.registerBackgroundLearning();
		ctx.effect(() => async () => {
			this.lifecycle.abort(/* @__PURE__ */ new Error("memory service disposed"));
			await Promise.allSettled(this.learningTails.values());
		});
	}
	/** Resolve the policy currently applied to one live or resumable session id. */
	policy(sessionId) {
		return sessionId === void 0 ? {
			useMemories: this.config.useMemories,
			generateMemories: this.config.generateMemories
		} : this.sessionPolicies.get(sessionId) ?? {
			useMemories: this.config.useMemories,
			generateMemories: this.config.generateMemories
		};
	}
	/** Replace current-session memory switches without changing deployment defaults. */
	setPolicy(sessionId, patch) {
		const current = this.policy(sessionId);
		const next = Object.freeze({
			...current,
			...patch
		});
		this.sessionPolicies.set(sessionId, next);
		return next;
	}
	/** Build the complete management view used by TUI and other in-process surfaces. */
	async overview(cwd, sessionId) {
		const [project, global, projectMemory, documents] = await Promise.all([
			this.store.project(cwd),
			this.store.read(cwd, "global"),
			this.store.read(cwd, "project"),
			this.store.list(cwd)
		]);
		return {
			project,
			policy: this.policy(sessionId),
			global,
			projectMemory,
			documents
		};
	}
	/** Read one Markdown document. */
	read(cwd, scope, topic) {
		return this.store.read(cwd, scope, topic);
	}
	/** Persist one memory and publish its reversible mutation. */
	async write(input, source) {
		const stored = await this.store.write(input);
		const mutation = this.toMutation("write", input.scope, input.summary, stored.files, source);
		if (stored.changed) {
			this.publishMutation(mutation);
			const project = await this.store.project(input.cwd);
			this.publishActivity({
				state: "updated",
				projectId: project.id,
				summary: mutation.summary
			});
		}
		return mutation;
	}
	/** Forget one memory and publish its reversible mutation. */
	async forget(input, source) {
		const stored = await this.store.forget(input);
		const mutation = this.toMutation("forget", input.scope, input.summary, stored.files, source);
		if (stored.changed) {
			this.publishMutation(mutation);
			const project = await this.store.project(input.cwd);
			this.publishActivity({
				state: "updated",
				projectId: project.id,
				summary: mutation.summary
			});
		}
		return mutation;
	}
	/** Restore or reapply a previously published mutation without publishing a new one. */
	restore(mutation, direction) {
		return this.store.restore(mutation.files, direction);
	}
	/** Observe quiet learner progress; the disposer removes exactly this callback. */
	onActivity(listener) {
		this.activityListeners.add(listener);
		return () => {
			this.activityListeners.delete(listener);
		};
	}
	/** Observe writes for integration with unified rewind checkpoints. */
	onMutation(listener) {
		this.mutationListeners.add(listener);
		return () => {
			this.mutationListeners.delete(listener);
		};
	}
	registerTools() {
		this.ctx.tools.register(defineTool({
			name: "memory_read",
			description: "Read the Markdown memory index or one topic file for the current project or global user scope. Use this when a loaded MEMORY.md entry points to a topic whose details are needed.",
			parameters: {
				scope: {
					type: "string",
					required: true,
					enum: ["project", "global"],
					description: "Project-local or global user memory."
				},
				topic: {
					type: "string",
					enum: [...memoryTopics],
					description: "Optional topic file; omit for MEMORY.md."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						scope: {
							type: "string",
							required: true
						},
						path: {
							type: "string",
							required: true
						},
						exists: {
							type: "boolean",
							required: true
						},
						content: {
							type: "string",
							required: true
						},
						bytes: {
							type: "number",
							required: true
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: value.exists ? value.content : `(no memory at ${value.path})`
				}]
			},
			execute: async (args, exec) => {
				const cwd = exec.agent?.session.header.cwd;
				if (cwd === void 0) throw new Error("memory_read requires an agent working directory");
				const document = await this.store.read(cwd, args.scope, args.topic);
				return {
					scope: document.scope,
					path: document.path,
					exists: document.exists,
					content: document.content,
					bytes: document.bytes
				};
			},
			presentCall: (args) => ({
				card: "generic",
				title: `Read ${args.scope} memory`,
				kind: "read",
				rawInput: args.topic
			})
		}));
		this.ctx.tools.register(defineTool({
			name: "memory_write",
			description: "Persist a durable user preference, correction, project rule, recurring workflow, or decision in Markdown memory. Call this when the user explicitly says to remember something, or when a correction is clearly reusable. Do not store transient requests, guesses, credentials, or secrets. Prefer project scope unless the user explicitly requests a global preference.",
			parameters: {
				scope: {
					type: "string",
					required: true,
					enum: ["project", "global"],
					description: "Project-local or global user memory."
				},
				summary: {
					type: "string",
					required: true,
					description: "One self-contained, durable fact written as concise prose."
				},
				topic: {
					type: "string",
					enum: [...memoryTopics],
					description: "Optional detail file: preferences, conventions, decisions, or debugging."
				},
				details: {
					type: "string",
					description: "Optional supporting detail stored in the selected topic file."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						changed: {
							type: "boolean",
							required: true
						},
						scope: {
							type: "string",
							required: true
						},
						summary: {
							type: "string",
							required: true
						},
						fileCount: {
							type: "number",
							required: true
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: value.changed ? `Remembered in ${value.scope} memory: ${value.summary}` : `Already remembered in ${value.scope} memory: ${value.summary}`
				}]
			},
			execute: async (args, exec) => {
				const agent = exec.agent;
				const cwd = agent?.session.header.cwd;
				if (agent === void 0 || cwd === void 0) throw new Error("memory_write requires an agent working directory");
				const source = sourceFor(agent, this.childSources);
				const mutation = await this.write({
					cwd,
					...args
				}, source);
				return {
					changed: mutation.files.length > 0,
					scope: mutation.scope,
					summary: mutation.summary,
					fileCount: mutation.files.length
				};
			},
			presentCall: (args) => ({
				card: "generic",
				title: `Remember ${args.scope} preference`,
				kind: "edit",
				rawInput: args.summary
			})
		}));
		this.ctx.tools.register(defineTool({
			name: "memory_forget",
			description: "Remove one exact summary from Markdown memory when the user asks to forget or correct it. Read memory first if the exact stored summary is uncertain.",
			parameters: {
				scope: {
					type: "string",
					required: true,
					enum: ["project", "global"]
				},
				summary: {
					type: "string",
					required: true,
					description: "Exact remembered summary to remove."
				},
				topic: {
					type: "string",
					enum: [...memoryTopics],
					description: "Topic file containing the detail, when one was used."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						changed: {
							type: "boolean",
							required: true
						},
						scope: {
							type: "string",
							required: true
						},
						summary: {
							type: "string",
							required: true
						},
						fileCount: {
							type: "number",
							required: true
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: value.changed ? `Forgot from ${value.scope} memory: ${value.summary}` : `No matching ${value.scope} memory: ${value.summary}`
				}]
			},
			execute: async (args, exec) => {
				const agent = exec.agent;
				const cwd = agent?.session.header.cwd;
				if (agent === void 0 || cwd === void 0) throw new Error("memory_forget requires an agent working directory");
				const source = sourceFor(agent, this.childSources);
				const mutation = await this.forget({
					cwd,
					...args
				}, source);
				return {
					changed: mutation.files.length > 0,
					scope: mutation.scope,
					summary: mutation.summary,
					fileCount: mutation.files.length
				};
			},
			presentCall: (args) => ({
				card: "generic",
				title: `Forget ${args.scope} memory`,
				kind: "edit",
				rawInput: args.summary
			})
		}));
	}
	registerContextInjection() {
		this.ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
			const decision = await next();
			if (decision.kind === "reject" || signal.aborted) return decision;
			const previous = latestPublishedMemory(agent);
			if (!this.policy(String(agent.id)).useMemories) {
				if (previous === void 0 || previous === MEMORY_CLEARED) return decision;
				return {
					kind: "enter",
					messages: [...decision.messages, createUserMessage({
						content: [{
							type: "text",
							text: MEMORY_CLEARED
						}],
						source: {
							kind: "plugin",
							plugin: PLUGIN_NAME
						}
					})]
				};
			}
			const cwd = agent.session.header.cwd;
			if (cwd === void 0) return decision;
			const [global, project] = await Promise.all([this.store.read(cwd, "global"), this.store.read(cwd, "project")]);
			signal.throwIfAborted();
			const text = renderContext(global, project, this.config.maxContextBytes);
			if (previous === text) return decision;
			return {
				kind: "enter",
				messages: [...decision.messages, createUserMessage({
					content: [{
						type: "text",
						text
					}],
					source: {
						kind: "plugin",
						plugin: PLUGIN_NAME,
						form: "snapshot",
						sections: [{
							name: "memory",
							text
						}]
					}
				})]
			};
		}, { prepend: true });
	}
	registerBackgroundLearning() {
		this.ctx.on("session/event", (session, event) => {
			if (event.type !== "turn/end" || !this.config.generateMemories) return;
			if (session.header.origin === "subagent") return;
			const agent = this.ctx.agents.get(session.id);
			if (agent === void 0 || !this.policy(String(session.id)).generateMemories) return;
			const transcript = transcriptForTurn(session, event.data.turn, this.config.extractionMaxInputBytes);
			if (transcript === void 0) return;
			if (!looksReusable(userTextFromTranscript(transcript), this.config.minCandidateChars)) return;
			this.enqueueLearning({
				agent,
				sessionId: String(session.id),
				turn: event.data.turn,
				cwd: session.header.cwd ?? process.cwd(),
				transcript
			});
		});
	}
	enqueueLearning(candidate) {
		const key = String(candidate.agent.id);
		const current = (this.learningTails.get(key) ?? Promise.resolve()).then(() => this.learnWhenIdle(candidate), () => this.learnWhenIdle(candidate));
		this.learningTails.set(key, current);
		current.finally(() => {
			if (this.learningTails.get(key) === current) this.learningTails.delete(key);
		}).catch(() => {});
	}
	async learnWhenIdle(candidate) {
		const signal = this.lifecycle.signal;
		if (signal.aborted) return;
		await candidate.agent.whenIdle();
		await delay(this.config.idleDelayMs, signal);
		if (signal.aborted || candidate.agent.status !== "idle") return;
		const project = await this.store.project(candidate.cwd);
		this.publishActivity({
			state: "learning",
			projectId: project.id,
			sourceSessionId: candidate.sessionId,
			sourceTurn: candidate.turn
		});
		try {
			await candidate.agent.runMaintenance((maintenanceSignal) => this.runLearningAgent(candidate, maintenanceSignal));
			this.publishActivity({ state: "idle" });
		} catch (error) {
			if (signal.aborted) return;
			const message = error instanceof Error ? error.message : String(error);
			this.ctx.logger.warn(`memory learning failed for session "${candidate.sessionId}" turn ${String(candidate.turn)}: ${message}`);
			this.publishActivity({
				state: "error",
				projectId: project.id,
				message
			});
		}
	}
	async runLearningAgent(candidate, signal) {
		signal.throwIfAborted();
		const sessionId = SessionId(`memory-${randomUUID()}`);
		const parentDepth = candidate.agent.session.header.delegationDepth ?? 0;
		const provider = this.config.extractionProvider ?? candidate.agent.options.provider;
		const model = this.config.extractionModel ?? candidate.agent.options.model;
		const handle = await this.ctx.agents.withInitiator(candidate.agent, () => this.ctx.agents.create({
			sessionId,
			meta: {
				cwd: candidate.cwd,
				parentSession: candidate.agent.id,
				origin: "subagent",
				delegationDepth: parentDepth + 1
			},
			agentOptions: {
				...provider === void 0 ? {} : { provider },
				...model === void 0 ? {} : { model },
				maxTokens: 900
			},
			signal,
			setup: (childCtx) => {
				childCtx.tools.presentAs("native");
				childCtx.tools.restrict({ allow: [
					"memory_read",
					"memory_write",
					"memory_forget"
				] });
				childCtx.systemPrompt.section({
					name: PERSONA_SECTION,
					order: PERSONA_ORDER,
					text: "You are a quiet memory maintenance agent. Extract only durable, user-supported memory and use the provided memory tools. Do not perform project work or answer the original user."
				});
			}
		}));
		this.childSources.set(String(sessionId), {
			sessionId: candidate.sessionId,
			turn: candidate.turn
		});
		this.setPolicy(String(sessionId), {
			useMemories: true,
			generateMemories: false
		});
		try {
			handle.agent.followup(extractionPrompt(candidate));
			await handle.agent.whenIdle();
		} finally {
			this.childSources.delete(String(sessionId));
			await handle.dispose();
		}
	}
	toMutation(operation, scope, summary, files, source) {
		return Object.freeze({
			id: randomUUID(),
			...source === void 0 ? {} : {
				sourceSessionId: source.sessionId,
				sourceTurn: source.turn
			},
			scope,
			summary,
			operation,
			files: [...files],
			createdAt: Date.now()
		});
	}
	publishActivity(activity) {
		for (const listener of this.activityListeners) try {
			listener(activity);
		} catch (error) {
			this.ctx.logger.warn(`memory activity listener failed: ${String(error)}`);
		}
	}
	publishMutation(mutation) {
		for (const listener of this.mutationListeners) try {
			listener(mutation);
		} catch (error) {
			this.ctx.logger.warn(`memory mutation listener failed: ${String(error)}`);
		}
	}
};
//#endregion
export { MemoryFileStore, ProjectMemoryService, ProjectMemoryService as default, memoryTopics };

//# sourceMappingURL=index.js.map