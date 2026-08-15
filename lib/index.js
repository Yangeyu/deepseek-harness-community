import { InProcessApiClient, toFetchHandler } from "@deepseek-ai/dsh-host-apiproxy";
import { CombinedAutocompleteProvider, Container, Editor, Key, Markdown, ProcessTerminal, SelectList, Text, TuiMainScreen, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, rmdir, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { highlight, supportsLanguage } from "cli-highlight";
import { diffLines } from "diff";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
//#region src/submission.ts
function userMessageRpcId(entry) {
	const event = entry.event;
	if (event.type !== "user/message" || event.data.source.kind !== "user") return void 0;
	return "rpcId" in event.data.source ? event.data.source.rpcId : void 0;
}
/** Reconciles optimistic prompts with durable user-message events. */
var SubmissionTracker = class {
	nextKey = 0;
	pending = [];
	observedRpcIds = /* @__PURE__ */ new Set();
	/** Return an immutable-by-convention state snapshot for the renderer. */
	get snapshot() {
		return [...this.pending];
	}
	/** Publish a prompt before its Host request settles. */
	start(text, mode, running) {
		const intent = mode === "steer" ? "steering" : running ? "queueing" : "working";
		const submission = {
			key: ++this.nextKey,
			text,
			mode,
			intent
		};
		this.pending = [...this.pending, submission];
		return submission;
	}
	/** Attach the echoed RPC identity or retire an already durable prompt. */
	accept(key, rpcId) {
		this.pending = this.observedRpcIds.has(rpcId) ? this.pending.filter((item) => item.key !== key) : this.pending.map((item) => item.key === key ? {
			...item,
			rpcId
		} : item);
		this.pruneObservedRpcIds();
	}
	/** Remove a prompt whose Host request failed. */
	reject(key) {
		this.pending = this.pending.filter((item) => item.key !== key);
		this.pruneObservedRpcIds();
	}
	/** Reconcile prompts represented by durable user-message events. */
	observeEvents(entries) {
		for (const entry of entries) this.observe(userMessageRpcId(entry));
		this.reconcile();
	}
	/** Drop terminal-local state when switching sessions. */
	reset() {
		this.pending = [];
		this.observedRpcIds.clear();
	}
	observe(rpcId) {
		if (rpcId === void 0) return;
		if (this.pending.some((item) => item.rpcId === void 0 || item.rpcId === rpcId)) this.observedRpcIds.add(rpcId);
	}
	reconcile() {
		this.pending = this.pending.filter((item) => item.rpcId === void 0 || !this.observedRpcIds.has(item.rpcId));
		this.pruneObservedRpcIds();
	}
	pruneObservedRpcIds() {
		if (this.pending.some((item) => item.rpcId === void 0)) return;
		const active = new Set(this.pending.flatMap((item) => item.rpcId === void 0 ? [] : [item.rpcId]));
		for (const rpcId of this.observedRpcIds) if (!active.has(rpcId)) this.observedRpcIds.delete(rpcId);
	}
};
//#endregion
//#region src/controller.ts
function valueOf(response) {
	if (response.result.ok) return response.result.value;
	throw new Error(response.result.error.message);
}
function terminalTimeZone() {
	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	return zone.trim() === "" ? void 0 : zone;
}
function abortableDelay(milliseconds, signal) {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, milliseconds);
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		}, { once: true });
	});
}
/** Session and stream coordinator over the transport-neutral Harness API. */
var HarnessController = class {
	api;
	sink;
	historyMessages;
	abort = new AbortController();
	state;
	resyncTask;
	generation = 0;
	projectionSeqs = {};
	submissions = new SubmissionTracker();
	constructor(api, sink, cwd, historyMessages) {
		this.api = api;
		this.sink = sink;
		this.historyMessages = historyMessages;
		this.state = {
			sessionId: void 0,
			cwd,
			running: false,
			connected: false,
			events: [],
			queue: [],
			pendingSubmissions: [],
			models: void 0,
			projections: {},
			notice: void 0,
			error: void 0
		};
	}
	/** Current immutable-by-convention state snapshot. */
	get current() {
		return this.state;
	}
	/** Create or resume the initial session, then attach both event streams. */
	async start(resumeSessionId) {
		await this.openSession(resumeSessionId);
		this.runMuxLoop();
		this.runHostLoop();
	}
	/** Stop stream reads and reject further controller work. */
	dispose() {
		this.abort.abort();
	}
	/** Publish a transient terminal-only notice. */
	notice(message) {
		this.patch({
			notice: message,
			error: void 0
		});
	}
	/** List resumable session rows for a terminal selector. */
	async sessions() {
		return valueOf(await this.api.sessions.list({})).items;
	}
	/** Switch the terminal to a fresh session in the current working directory. */
	async newSession() {
		await this.openSession();
	}
	/** Clear the visible conversation immediately, then attach a fresh session. */
	async clearSession() {
		await this.openSession(void 0, true);
	}
	/** Switch the terminal to an existing persisted or live session. */
	async resume(sessionId) {
		await this.openSession(sessionId);
	}
	/** Fork to the boundary before the checkpointed turn, then open and return the replacement session. */
	async rewind(preview, onPhase) {
		const source = this.requireSession();
		if (String(source) !== preview.sessionId) throw new Error("the active session changed before rewind");
		onPhase?.("forking");
		let target;
		if (preview.previousTurnEndSeq === void 0) {
			target = valueOf(await this.api.sessions.create({ cwd: this.state.cwd })).sessionId;
			const selection = this.state.models?.current;
			if (selection !== void 0) valueOf(await this.api.sessions.selectModel({
				sessionId: target,
				provider: selection.provider,
				model: selection.model,
				...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }
			}));
		} else target = valueOf(await this.api.sessions.fork({
			sessionId: source,
			atSeq: preview.previousTurnEndSeq
		})).sessionId;
		onPhase?.("opening");
		await this.openSession(String(target));
		return target;
	}
	/** Submit ordinary text using the caller-selected queue placement. */
	async prompt(text, mode) {
		const sessionId = this.requireSession();
		const generation = this.generation;
		const pending = this.submissions.start(text, mode, this.state.running);
		this.patch({
			pendingSubmissions: this.submissions.snapshot,
			notice: void 0,
			error: void 0
		});
		const rejectPending = () => {
			if (generation !== this.generation || sessionId !== this.state.sessionId) return;
			this.submissions.reject(pending.key);
			this.patch({ pendingSubmissions: this.submissions.snapshot });
		};
		const clientTimeZone = terminalTimeZone();
		let response;
		try {
			response = await this.api.sessions.prompt({
				sessionId,
				mode,
				content: [{
					type: "text",
					text
				}],
				...clientTimeZone === void 0 ? {} : { clientTimeZone }
			});
		} catch (error) {
			rejectPending();
			throw error;
		}
		if (!response.result.ok) {
			rejectPending();
			throw new Error(response.result.error.message);
		}
		if (generation !== this.generation || sessionId !== this.state.sessionId) return;
		this.submissions.accept(pending.key, response.rpcId);
		this.patch({ pendingSubmissions: this.submissions.snapshot });
		const accepted = response.result.value;
		if (accepted.command?.text !== void 0) this.notice(accepted.command.text);
	}
	/** Cancel the active turn while preserving pending queued work. */
	async cancel() {
		valueOf(await this.api.sessions.cancel({ sessionId: this.requireSession() }));
	}
	/** Refresh the model directory used by the selector and status line. */
	async refreshModels() {
		const models = valueOf(await this.api.sessions.models({ sessionId: this.requireSession() }));
		this.patch({ models });
		return models;
	}
	/** Select an exact model route for subsequent steps. */
	async selectModel(selection) {
		const selected = valueOf(await this.api.sessions.selectModel({
			sessionId: this.requireSession(),
			provider: selection.provider,
			model: selection.model,
			...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }
		})).selected;
		const models = this.state.models;
		this.patch({ models: models === void 0 ? void 0 : {
			...models,
			current: selected
		} });
	}
	/** Answer one approval request through the response leg of the RPC protocol. */
	async answerApproval(prompt, outcome) {
		await this.respond(prompt.rpcId, {
			sessionId: prompt.sessionId,
			approvalId: prompt.approvalId,
			outcome
		});
	}
	/** Answer a complete question batch through the response leg of the RPC protocol. */
	async answerQuestions(prompt, answers) {
		await this.respond(prompt.rpcId, {
			sessionId: prompt.sessionId,
			answer: { answers }
		});
	}
	/** Cancel a question batch without manufacturing an answer. */
	async cancelQuestions(prompt) {
		const response = {
			type: "client-response",
			rpcId: prompt.rpcId,
			result: {
				ok: false,
				error: {
					code: "cancelled",
					message: "the user cancelled the question",
					details: {}
				}
			}
		};
		const receipt = await this.api.respond(response);
		if (!receipt.accepted) throw new Error(`question cancellation was ${receipt.reason}`);
	}
	async respond(rpcId, value) {
		const response = {
			type: "client-response",
			rpcId,
			result: {
				ok: true,
				value
			}
		};
		const receipt = await this.api.respond(response);
		if (!receipt.accepted) throw new Error(`interaction response was ${receipt.reason}`);
	}
	requireSession() {
		const sessionId = this.state.sessionId;
		if (sessionId === void 0) throw new Error("no terminal session is active");
		return sessionId;
	}
	async openSession(resumeSessionId, clearImmediately = false) {
		const previousState = this.state;
		const previousProjectionSeqs = this.projectionSeqs;
		const generation = ++this.generation;
		if (clearImmediately) {
			this.state = this.emptySessionState(previousState.cwd, previousState.connected);
			this.projectionSeqs = {};
			this.emit();
		}
		try {
			const host = valueOf(await this.api.host.describe({}));
			let cwd = previousState.cwd || host.cwd;
			let requested;
			if (resumeSessionId !== void 0) {
				const summary = valueOf(await this.api.sessions.list({})).items.find((item) => String(item.sessionId) === resumeSessionId);
				if (summary === void 0) throw new Error(`session "${resumeSessionId}" was not found`);
				requested = summary.sessionId;
				cwd = summary.cwd ?? host.cwd;
			}
			const created = valueOf(await this.api.sessions.create({
				cwd,
				...requested === void 0 ? {} : { sessionId: requested }
			}));
			if (generation !== this.generation) return;
			this.submissions.reset();
			this.state = {
				...this.emptySessionState(cwd, this.state.connected),
				sessionId: created.sessionId
			};
			this.emit();
			this.projectionSeqs = {};
			await Promise.all([this.resync(), this.refreshModels().catch(() => void 0)]);
		} catch (error) {
			if (clearImmediately && generation === this.generation) {
				this.state = previousState;
				this.projectionSeqs = previousProjectionSeqs;
				this.emit();
			}
			throw error;
		}
	}
	async resync() {
		const sessionId = this.requireSession();
		const generation = this.generation;
		if (this.resyncTask?.generation === generation) return this.resyncTask.promise;
		const promise = (async () => {
			const page = valueOf(await this.api.sessions.history({
				sessionId,
				maxMessages: this.historyMessages
			}));
			if (generation !== this.generation || sessionId !== this.state.sessionId) return;
			const projections = page.projections === void 0 ? this.state.projections : this.mergeProjectionBaseline(page.projections.asOfSeq, page.projections.values);
			this.submissions.observeEvents(page.events);
			this.patch({
				events: page.events,
				pendingSubmissions: this.submissions.snapshot,
				projections,
				error: void 0
			});
		})().finally(() => {
			if (this.resyncTask?.promise === promise) this.resyncTask = void 0;
		});
		this.resyncTask = {
			generation,
			promise
		};
		return promise;
	}
	async runMuxLoop() {
		while (!this.abort.signal.aborted) {
			try {
				for await (const request of this.api.events.mux({}, this.abort.signal)) await this.handleMux(request);
			} catch (error) {
				if (this.abort.signal.aborted) return;
				this.patch({
					connected: false,
					error: `event stream disconnected: ${String(error)}`
				});
			}
			if (this.abort.signal.aborted) return;
			await abortableDelay(500, this.abort.signal);
			await this.resync().catch(() => void 0);
		}
	}
	async runHostLoop() {
		while (!this.abort.signal.aborted) {
			try {
				for await (const request of this.api.events.host({}, this.abort.signal)) this.handleHost(request.payload);
			} catch (error) {
				if (this.abort.signal.aborted) return;
				this.patch({ error: `host stream disconnected: ${String(error)}` });
			}
			if (this.abort.signal.aborted) return;
			await abortableDelay(500, this.abort.signal);
		}
	}
	async handleMux(request) {
		const frame = request.payload;
		if (frame.type === "stream/error") {
			this.patch({ error: frame.error.message });
			return;
		}
		if (frame.type === "approval/requested") {
			this.sink.requestApproval({
				...frame,
				rpcId: request.rpcId
			});
			return;
		}
		if (frame.type === "question/requested") {
			this.sink.requestQuestions({
				...frame,
				rpcId: request.rpcId
			});
			return;
		}
		if (frame.sessionId !== this.state.sessionId) return;
		this.patch({ connected: true });
		switch (frame.type) {
			case "session/event":
				await this.appendEvent({
					event: frame.event,
					...frame.view === void 0 ? {} : { view: frame.view }
				});
				return;
			case "session/subscribed": {
				const last = this.state.events.at(-1)?.event.seq ?? -1;
				if (frame.lastSeq !== last) await this.resync();
				return;
			}
			case "session/queue":
				this.patch({
					queue: frame.items,
					pendingSubmissions: this.submissions.snapshot
				});
				return;
			case "session/projection":
				this.applyProjection(frame.key, frame.value, frame.seq);
				return;
			case "session/jobs":
			case "approval/resolved":
			case "question/resolved": return;
		}
	}
	handleHost(frame) {
		if (frame.type === "stream/error") {
			this.patch({ error: frame.error.message });
			return;
		}
		if (!("sessionId" in frame) || frame.sessionId !== this.state.sessionId) return;
		if (frame.type === "host/session-status") this.patch({
			running: frame.running,
			connected: true
		});
		if (frame.type === "host/agent-error") this.patch({ error: frame.message });
	}
	async appendEvent(entry) {
		this.submissions.observeEvents([entry]);
		const currentLast = this.state.events.at(-1)?.event.seq;
		if (currentLast !== void 0 && entry.event.seq <= currentLast) {
			const pendingSubmissions = this.submissions.snapshot;
			if (pendingSubmissions.length !== this.state.pendingSubmissions.length) this.patch({ pendingSubmissions });
			return;
		}
		if (currentLast !== void 0 && entry.event.seq !== currentLast + 1) {
			await this.resync();
			return;
		}
		this.patch({
			events: [...this.state.events, entry],
			pendingSubmissions: this.submissions.snapshot,
			error: void 0
		});
	}
	mergeProjectionBaseline(asOfSeq, baseline) {
		const values = { ...this.state.projections };
		const keys = /* @__PURE__ */ new Set([...Object.keys(values), ...Object.keys(baseline)]);
		for (const key of keys) {
			if ((this.projectionSeqs[key] ?? -1) > asOfSeq) continue;
			if (Object.hasOwn(baseline, key)) values[key] = baseline[key];
			else delete values[key];
			this.projectionSeqs[key] = asOfSeq;
		}
		return values;
	}
	applyProjection(key, value, seq) {
		if ((this.projectionSeqs[key] ?? -1) >= seq) return;
		this.projectionSeqs[key] = seq;
		this.patch({ projections: {
			...this.state.projections,
			[key]: value
		} });
	}
	emptySessionState(cwd, connected) {
		return {
			sessionId: void 0,
			cwd,
			running: false,
			connected,
			events: [],
			queue: [],
			pendingSubmissions: [],
			models: void 0,
			projections: {},
			notice: void 0,
			error: void 0
		};
	}
	patch(change) {
		this.state = {
			...this.state,
			...change
		};
		this.emit();
	}
	emit() {
		this.sink.render(this.state);
	}
};
//#endregion
//#region src/text.ts
/** Remove terminal control sequences from untrusted model, tool, and user text. */
function sanitizeTerminalText(value) {
	return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");
}
/** Render an unknown value as bounded, terminal-safe text. */
function displayUnknown(value) {
	if (typeof value === "string") return sanitizeTerminalText(value);
	try {
		return sanitizeTerminalText(JSON.stringify(value, null, 2));
	} catch {
		return sanitizeTerminalText(String(value));
	}
}
//#endregion
//#region src/dialogs.ts
/** Keyboard selector with a title and optional explanatory line. */
var ChoiceDialog = class {
	title;
	detail;
	list;
	constructor(title, items, theme, onSelect, onCancel, detail) {
		this.title = new Text(theme.bold(sanitizeTerminalText(title)), 1, 0);
		this.detail = detail === void 0 ? void 0 : new Text(theme.dim(sanitizeTerminalText(detail)), 1, 0);
		this.list = new SelectList(items, 10, theme.select);
		this.list.onSelect = onSelect;
		this.list.onCancel = onCancel;
	}
	handleInput(data) {
		this.list.handleInput(data);
	}
	invalidate() {
		this.title.invalidate();
		this.detail?.invalidate();
		this.list.invalidate();
	}
	render(width) {
		return [
			...this.title.render(width),
			...this.detail?.render(width) ?? [],
			"",
			...this.list.render(width)
		];
	}
};
function effortChoices(row) {
	const reasoning = row.model.reasoning;
	if (reasoning === void 0) return [];
	return [...reasoning.defaultEffort === void 0 ? [{
		id: void 0,
		name: "Provider default"
	}] : [], ...reasoning.efforts.map((effort) => ({
		id: effort.id,
		name: effort.name,
		...effort.description === void 0 ? {} : { description: effort.description }
	}))];
}
/** Codex-style two-stage model and reasoning-effort selector. */
var ModelDialog = class {
	models;
	theme;
	onSelect;
	onCancel;
	rows;
	index;
	stage = "model";
	effortIndex = 0;
	constructor(models, theme, onSelect, onCancel) {
		this.models = models;
		this.theme = theme;
		this.onSelect = onSelect;
		this.onCancel = onCancel;
		this.rows = models.groups.flatMap((group) => group.models.map((model) => ({
			providerId: group.id,
			providerName: group.name,
			model
		})));
		const current = this.rows.findIndex((row) => row.providerId === models.current.provider && row.model.id === models.current.model);
		this.index = Math.max(0, current);
	}
	handleInput(data) {
		if (matchesKey(data, Key.up)) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.move(1);
			return;
		}
		if (/^[1-9]$/.test(data)) {
			const selected = Number(data) - 1;
			if (this.stage === "model") {
				if (selected < this.rows.length) this.index = selected;
			} else if (selected < this.currentEfforts().length) this.effortIndex = selected;
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.confirm();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			if (this.stage === "effort") this.stage = "model";
			else this.onCancel();
			return;
		}
		if (matchesKey(data, Key.ctrl("c"))) this.onCancel();
	}
	invalidate() {}
	render(width) {
		return this.stage === "model" ? this.renderModels(width) : this.renderEfforts(width);
	}
	renderModels(width) {
		const lines = [
			this.theme.bold("Select Model and Effort"),
			this.theme.dim("Choose a model. The selection also becomes the default for new sessions."),
			""
		];
		if (this.rows.length === 0) lines.push(this.theme.warning("No models are currently available."));
		for (const [index, row] of this.rows.entries()) {
			const cursor = index === this.index ? this.theme.accent("›") : " ";
			const currentLabel = row.providerId === this.models.current.provider && row.model.id === this.models.current.model ? this.theme.dim(" (current)") : "";
			const description = row.model.description ?? row.providerName;
			lines.push(truncateToWidth(`${cursor} ${index + 1}. ${index === this.index ? this.theme.bold(row.model.name) : row.model.name}${currentLabel}${description === "" ? "" : `  ${this.theme.dim(description)}`}`, width));
		}
		for (const failure of this.models.failures) lines.push("", truncateToWidth(this.theme.warning(`${failure.name}: ${failure.message}`), width));
		lines.push("", this.theme.dim("Press enter to continue or esc to go back"));
		return lines;
	}
	renderEfforts(width) {
		const row = this.rows[this.index];
		const choices = this.currentEfforts();
		const lines = [
			this.theme.bold("Select Reasoning Effort"),
			this.theme.dim(row?.model.name ?? ""),
			""
		];
		for (const [index, choice] of choices.entries()) {
			const cursor = index === this.effortIndex ? this.theme.accent("›") : " ";
			const currentLabel = row?.providerId === this.models.current.provider && row.model.id === this.models.current.model && choice.id === this.models.current.reasoningEffort ? this.theme.dim(" (current)") : "";
			lines.push(truncateToWidth(`${cursor} ${index + 1}. ${index === this.effortIndex ? this.theme.bold(choice.name) : choice.name}${currentLabel}${choice.description === void 0 ? "" : `  ${this.theme.dim(choice.description)}`}`, width));
		}
		lines.push("", this.theme.dim("Press enter to confirm or esc to go back"));
		return lines;
	}
	move(offset) {
		if (this.stage === "model") {
			this.index = Math.max(0, Math.min(Math.max(0, this.rows.length - 1), this.index + offset));
			return;
		}
		this.effortIndex = Math.max(0, Math.min(Math.max(0, this.currentEfforts().length - 1), this.effortIndex + offset));
	}
	confirm() {
		const row = this.rows[this.index];
		if (row === void 0) return;
		const choices = effortChoices(row);
		if (this.stage === "model" && choices.length > 1) {
			const initial = row.providerId === this.models.current.provider && row.model.id === this.models.current.model ? this.models.current.reasoningEffort : row.model.reasoning?.defaultEffort;
			this.effortIndex = Math.max(0, choices.findIndex((choice) => choice.id === initial));
			this.stage = "effort";
			return;
		}
		const choice = choices[this.effortIndex] ?? choices[0];
		this.onSelect({
			provider: row.providerId,
			model: row.model.id,
			...choice?.id === void 0 ? {} : { reasoningEffort: choice.id }
		});
	}
	currentEfforts() {
		const row = this.rows[this.index];
		return row === void 0 ? [] : effortChoices(row);
	}
};
/** Composer-anchored memory policy and Markdown document browser. */
var MemoryDialog = class {
	overview;
	visibleRows;
	theme;
	onPolicy;
	onCancel;
	index = 0;
	document;
	documentOffset = 0;
	policy;
	documents;
	constructor(overview, visibleRows, theme, onPolicy, onCancel) {
		this.overview = overview;
		this.visibleRows = visibleRows;
		this.theme = theme;
		this.onPolicy = onPolicy;
		this.onCancel = onCancel;
		this.policy = overview.policy;
		const byPath = /* @__PURE__ */ new Map();
		for (const document of [
			overview.projectMemory,
			overview.global,
			...overview.documents
		]) byPath.set(document.path, document);
		this.documents = [...byPath.values()];
	}
	handleInput(data) {
		if (this.document !== void 0) {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
				this.document = void 0;
				this.documentOffset = 0;
				return;
			}
			const page = this.documentPageRows();
			if (matchesKey(data, Key.up)) this.moveDocument(-1);
			if (matchesKey(data, Key.down)) this.moveDocument(1);
			if (matchesKey(data, Key.pageUp)) this.moveDocument(-page);
			if (matchesKey(data, Key.pageDown)) this.moveDocument(page);
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.index = Math.max(0, this.index - 1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.index = Math.min(this.documents.length + 1, this.index + 1);
			return;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
			if (this.index === 0) {
				this.policy = {
					...this.policy,
					useMemories: !this.policy.useMemories
				};
				this.onPolicy(this.policy);
				return;
			}
			if (this.index === 1) {
				this.policy = {
					...this.policy,
					generateMemories: !this.policy.generateMemories
				};
				this.onPolicy(this.policy);
				return;
			}
			this.document = this.documents[this.index - 2];
			this.documentOffset = 0;
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) this.onCancel();
	}
	invalidate() {}
	render(width) {
		return this.document === void 0 ? this.renderList(width) : this.renderDocument(width, this.document);
	}
	renderList(width) {
		const lines = [
			this.theme.bold("Memories"),
			this.theme.dim(`Project · ${this.overview.project.id}`),
			"",
			this.toggleLine(0, "Use memories in this session", this.policy.useMemories),
			this.toggleLine(1, "Learn from this session", this.policy.generateMemories),
			""
		];
		for (const [offset, document] of this.documents.entries()) {
			const index = offset + 2;
			const cursor = index === this.index ? this.theme.accent("›") : " ";
			const label = document.scope === "project" ? document.topic === void 0 ? "Project memory" : `Project · ${document.topic}` : document.topic === void 0 ? "Global memory" : `Global · ${document.topic}`;
			const status = document.exists ? `${document.bytes} bytes` : "not created";
			lines.push(truncateToWidth(`${cursor} ${index === this.index ? this.theme.bold(label) : label}  ${this.theme.dim(status)}`, width));
		}
		lines.push("", this.theme.dim("↑/↓ select · Enter toggle/open · Esc close"));
		return lines;
	}
	renderDocument(width, document) {
		const body = document.exists && document.content.trim() !== "" ? sanitizeTerminalText(document.content).split("\n") : ["(empty memory document)"];
		const page = this.documentPageRows();
		const maximum = Math.max(0, body.length - page);
		this.documentOffset = Math.max(0, Math.min(maximum, this.documentOffset));
		const visible = body.slice(this.documentOffset, this.documentOffset + page);
		const range = body.length <= page ? "" : ` · ${this.documentOffset + 1}-${Math.min(body.length, this.documentOffset + page)}/${body.length}`;
		return [
			this.theme.bold(document.scope === "project" ? "Project memory" : "Global memory"),
			truncateToWidth(this.theme.dim(document.path), width),
			"",
			...visible.flatMap((line) => wrapTextWithAnsi(line, width)),
			"",
			this.theme.dim(`↑/↓ scroll · PageUp/PageDown page · Esc back${range}`)
		];
	}
	toggleLine(index, label, enabled) {
		return `${this.index === index ? this.theme.accent("›") : " "} ${this.index === index ? this.theme.bold(label) : label}  ${enabled ? this.theme.success("on") : this.theme.dim("off")}`;
	}
	moveDocument(offset) {
		const lines = this.document?.content.split("\n").length ?? 1;
		this.documentOffset = Math.max(0, Math.min(Math.max(0, lines - this.documentPageRows()), this.documentOffset + offset));
	}
	documentPageRows() {
		return Math.max(3, this.visibleRows() - 8);
	}
};
/** Bounded keyboard selector for process-local turn checkpoints. */
var RewindCheckpointDialog = class {
	visibleRows;
	theme;
	onSelect;
	onCancel;
	summaries;
	index;
	inspectionError;
	constructor(summaries, selectedCheckpointId, visibleRows, theme, onSelect, onCancel) {
		this.visibleRows = visibleRows;
		this.theme = theme;
		this.onSelect = onSelect;
		this.onCancel = onCancel;
		this.summaries = summaries;
		const selected = selectedCheckpointId === void 0 ? summaries.length - 1 : summaries.findIndex((summary) => summary.checkpointId === selectedCheckpointId);
		this.index = Math.max(0, selected);
	}
	/** Replace asynchronously inspected rows without moving the current selection. */
	setSummaries(summaries) {
		const selectedId = this.summaries[this.index]?.checkpointId;
		this.summaries = summaries;
		const selected = selectedId === void 0 ? summaries.length - 1 : summaries.findIndex((summary) => summary.checkpointId === selectedId);
		this.index = selected === -1 ? Math.max(0, summaries.length - 1) : Math.max(0, selected);
		this.inspectionError = void 0;
	}
	/** Keep selection usable when optional workspace-count inspection fails. */
	setInspectionError(message) {
		this.inspectionError = message;
	}
	handleInput(data) {
		if (matchesKey(data, Key.up)) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.move(1);
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.move(-this.maxVisibleItems());
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.move(this.maxVisibleItems());
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const selected = this.summaries[this.index];
			if (selected !== void 0) this.onSelect(selected);
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) this.onCancel();
	}
	invalidate() {}
	render(width) {
		const maxVisible = this.maxVisibleItems();
		const start = Math.max(0, Math.min(this.summaries.length - maxVisible, this.index - Math.floor(maxVisible / 2)));
		const end = Math.min(this.summaries.length, start + maxVisible);
		const lines = [
			this.theme.bold("Rewind"),
			this.theme.dim("Restore the workspace and conversation to the point before…"),
			""
		];
		if (start > 0) lines.push(this.theme.dim(`  ↑ ${start} more above`), "");
		for (let row = start; row < end; row += 1) {
			const summary = this.summaries[row];
			if (summary === void 0) continue;
			const selected = row === this.index;
			const cursor = selected ? this.theme.accent("›") : " ";
			const prompt = sanitizeTerminalText(summary.prompt).replaceAll("\n", " ");
			const fileStatus = summary.turnChangedFiles === void 0 ? "Checking workspace changes…" : summary.turnChangedFiles === 0 ? "No code changes" : `${summary.turnChangedFiles} changed file${summary.turnChangedFiles === 1 ? "" : "s"} this turn`;
			const memoryStatus = (summary.memoryUpdates ?? 0) === 0 ? "" : ` · ${summary.memoryUpdates} memory update${summary.memoryUpdates === 1 ? "" : "s"}`;
			lines.push(truncateToWidth(`${cursor} ${selected ? this.theme.bold(prompt) : prompt}`, width));
			lines.push(truncateToWidth(`    ${this.theme.dim(`${fileStatus}${memoryStatus}`)}`, width), "");
		}
		if (end < this.summaries.length) lines.push(this.theme.dim(`  ↓ ${this.summaries.length - end} more below`), "");
		if (this.inspectionError !== void 0) lines.push(truncateToWidth(this.theme.warning(`Workspace status unavailable: ${this.inspectionError}`), width));
		lines.push(this.theme.dim("↑/↓ select · Enter continue · Esc cancel"));
		return lines;
	}
	move(offset) {
		this.index = Math.max(0, Math.min(this.summaries.length - 1, this.index + offset));
	}
	maxVisibleItems() {
		return Math.max(1, Math.min(6, Math.floor((this.visibleRows() - 8) / 3)));
	}
};
function relativeAge(time) {
	const seconds = Math.max(0, Math.floor((Date.now() - time) / 1e3));
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}
/** Claude Code-style confirmation for the unified workspace and conversation rewind. */
var RewindDialog = class {
	preview;
	theme;
	onConfirm;
	onCancel;
	selected = 0;
	constructor(preview, theme, onConfirm, onCancel) {
		this.preview = preview;
		this.theme = theme;
		this.onConfirm = onConfirm;
		this.onCancel = onCancel;
	}
	handleInput(data) {
		if (matchesKey(data, Key.up)) {
			this.selected = 0;
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, Key.tab)) {
			this.selected = 1;
			return;
		}
		if (data === "1" || data === "2") {
			this.selected = Number(data) - 1;
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (this.selected === 0) this.onConfirm();
			else this.onCancel();
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) this.onCancel();
	}
	invalidate() {}
	render(width) {
		const prompt = sanitizeTerminalText(this.preview.prompt).replaceAll("\n", " ");
		const changed = this.preview.files.length;
		const memoryUpdates = this.preview.memoryMutations?.length ?? 0;
		const confirmation = wrapTextWithAnsi(this.theme.dim("Confirm you want to restore the workspace, memory, and conversation to the point before you sent this message:"), width);
		const promptLines = wrapTextWithAnsi(prompt, Math.max(1, width - 2));
		const impact = wrapTextWithAnsi(this.theme.dim(changed === 0 ? "The code will be unchanged." : `${changed} changed file${changed === 1 ? "" : "s"} will be restored.`), width);
		const memoryImpact = memoryUpdates === 0 ? [] : wrapTextWithAnsi(this.theme.dim(`${memoryUpdates} memory update${memoryUpdates === 1 ? "" : "s"} will be reverted.`), width);
		const lines = [
			this.theme.bold("Rewind"),
			"",
			...confirmation,
			"",
			...promptLines.map((line) => `${this.theme.dim("│")} ${this.theme.bold(line)}`),
			`${this.theme.dim("│")} ${this.theme.dim(`(${relativeAge(this.preview.createdAt)})`)}`,
			"",
			this.theme.dim("The conversation will be forked."),
			...impact,
			...memoryImpact,
			""
		];
		const restore = `${this.selected === 0 ? "›" : " "} 1. Restore workspace, memory, and conversation`;
		const cancel = `${this.selected === 1 ? "›" : " "} 2. Never mind`;
		lines.push(this.selected === 0 ? this.theme.accent(restore) : restore, this.selected === 1 ? this.theme.accent(cancel) : cancel, "", this.theme.dim("↑/↓ select · Enter confirm · Esc back"));
		return lines.map((line) => truncateToWidth(line, width));
	}
};
/** Multi-select question dialog: Space toggles and Enter submits. */
var MultiSelectDialog = class {
	title;
	items;
	theme;
	onSubmit;
	onCustom;
	onCancel;
	index = 0;
	selected = /* @__PURE__ */ new Set();
	constructor(title, items, theme, onSubmit, onCustom, onCancel) {
		this.title = title;
		this.items = items;
		this.theme = theme;
		this.onSubmit = onSubmit;
		this.onCustom = onCustom;
		this.onCancel = onCancel;
	}
	handleInput(data) {
		if (matchesKey(data, Key.up)) {
			this.index = Math.max(0, this.index - 1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.index = Math.min(this.items.length, this.index + 1);
			return;
		}
		if (matchesKey(data, Key.space)) {
			const item = this.items[this.index];
			if (item === void 0) {
				this.onCustom([...this.selected]);
				return;
			}
			if (this.selected.has(item.value)) this.selected.delete(item.value);
			else this.selected.add(item.value);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (this.index === this.items.length) {
				this.onCustom([...this.selected]);
				return;
			}
			if (this.selected.size === 0) {
				const item = this.items[this.index];
				if (item !== void 0) this.selected.add(item.value);
			}
			if (this.selected.size > 0) this.onSubmit([...this.selected]);
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) this.onCancel();
	}
	invalidate() {}
	render(width) {
		const lines = [this.theme.bold(sanitizeTerminalText(this.title)), this.theme.dim("Space toggle · Enter confirm")];
		for (const [index, item] of this.items.entries()) {
			const cursor = index === this.index ? this.theme.accent("›") : " ";
			const checked = this.selected.has(item.value) ? this.theme.success("[x]") : "[ ]";
			lines.push(truncateToWidth(`${cursor} ${checked} ${sanitizeTerminalText(item.label)}`, width));
			if (item.description !== void 0) lines.push(truncateToWidth(`      ${this.theme.dim(sanitizeTerminalText(item.description))}`, width));
		}
		const customCursor = this.index === this.items.length ? this.theme.accent("›") : " ";
		lines.push(truncateToWidth(`${customCursor} [ ] Other…`, width));
		return lines;
	}
};
/** One-line custom-answer overlay backed by pi-tui's IME-aware editor. */
var TextInputDialog = class {
	title;
	theme;
	onCancel;
	editor;
	constructor(tui, title, theme, onSubmit, onCancel) {
		this.title = title;
		this.theme = theme;
		this.onCancel = onCancel;
		this.editor = new Editor(tui, theme.editor, {
			paddingX: 0,
			autocompleteMaxVisible: 5
		});
		this.editor.onSubmit = onSubmit;
	}
	get focused() {
		return this.editor.focused;
	}
	set focused(value) {
		this.editor.focused = value;
	}
	handleInput(data) {
		if (matchesKey(data, Key.escape)) {
			this.onCancel();
			return;
		}
		this.editor.handleInput(data);
	}
	invalidate() {
		this.editor.invalidate();
	}
	render(width) {
		return [
			this.theme.bold(sanitizeTerminalText(this.title)),
			"",
			...this.editor.render(width)
		];
	}
};
//#endregion
//#region src/theme.ts
function ansi(enabled, open, close) {
	return enabled ? (text) => `\u001b[${open}m${text}\u001b[${close}m` : (text) => text;
}
function ansiSequence(enabled, open, close) {
	return enabled ? (text) => `\u001b[${open}m${text}\u001b[${close}m` : (text) => text;
}
/** Build the complete color-disabled or standard-ANSI theme. */
function createTheme(enabled) {
	const accent = ansi(enabled, 36, 39);
	const assistant = ansi(enabled, 34, 39);
	const bold = ansi(enabled, 1, 22);
	const dim = ansi(enabled, 2, 22);
	const diffAdded = ansiSequence(enabled, "48;2;12;48;28", "49");
	const diffRemoved = ansiSequence(enabled, "48;2;58;23;31", "49");
	const error = ansi(enabled, 31, 39);
	const reasoning = ansi(enabled, 90, 39);
	const success = ansi(enabled, 32, 39);
	const underline = ansi(enabled, 4, 24);
	const warning = ansi(enabled, 33, 39);
	const user = ansi(enabled, 97, 39);
	const userBlock = ansiSequence(enabled, "48;2;36;42;58", "49");
	const reverse = ansi(enabled, 7, 27);
	const hover = (text) => bold(accent(text));
	const select = {
		selectedPrefix: accent,
		selectedText: reverse,
		description: dim,
		scrollInfo: dim,
		noMatch: warning
	};
	return {
		accent,
		assistant,
		bold,
		dim,
		diffAdded,
		diffRemoved,
		error,
		hover,
		reasoning,
		success,
		underline,
		user,
		userBlock,
		warning,
		select,
		editor: {
			borderColor: dim,
			selectList: select
		},
		markdown: {
			heading: (text) => bold(accent(text)),
			link: accent,
			linkUrl: dim,
			code: warning,
			codeBlock: warning,
			codeBlockBorder: (text) => {
				const language = text.startsWith("```") ? text.slice(3) : "";
				return language === "" ? "" : dim(`  ${language}`);
			},
			quote: dim,
			quoteBorder: dim,
			hr: dim,
			listBullet: accent,
			bold,
			italic: ansi(enabled, 3, 23),
			strikethrough: ansi(enabled, 9, 29),
			underline: ansi(enabled, 4, 24)
		}
	};
}
//#endregion
//#region src/stats.ts
/** Compact token count using the same thresholds as the Harness Web composer. */
function formatTokens(value) {
	const scaled = (number) => number >= 100 ? String(Math.round(number)) : String(Math.round(number * 10) / 10);
	if (value < 1e3) return String(value);
	if (value < 1e6) return `${scaled(value / 1e3)}K`;
	return `${scaled(value / 1e6)}M`;
}
/** Compact duration using the same rounding as the Harness Web composer. */
function formatDuration(milliseconds) {
	const seconds = milliseconds / 1e3;
	if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`;
	const whole = Math.round(seconds);
	return `${Math.floor(whole / 60)}m${whole % 60}s`;
}
/** Decode throughput using the same precision as Harness Web. */
function formatTokensPerSecond(value) {
	const clamped = Math.max(0, value);
	return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
}
/** Sum the disjoint prompt-side billing buckets. */
function billedInputTokens(usage) {
	return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}
/** Cache-read share of all billed input, rounded like Harness Web. */
function cacheHitPercent(usage) {
	const denominator = billedInputTokens(usage);
	return denominator === 0 ? null : Math.round(usage.cacheReadTokens / denominator * 100);
}
function statsGroups(stats) {
	if (stats === void 0 || stats.steps === 0) return [];
	const groups = [`${stats.turns} turns · ${stats.steps} steps`];
	const durations = [];
	if (stats.llmMs > 0) durations.push(`LLM ${formatDuration(stats.llmMs)}`);
	if (stats.toolMs > 0) durations.push(`Tool call ${formatDuration(stats.toolMs)}`);
	if (durations.length > 0) groups.push(durations.join(" · "));
	const speeds = [];
	if (stats.ttftSteps > 0) speeds.push(`TTFT avg ${formatDuration(stats.ttftMs / stats.ttftSteps)}`);
	if (stats.decodeMs > 0) speeds.push(`${formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1e3))} tok/s`);
	if (speeds.length > 0) groups.push(speeds.join(" · "));
	return groups;
}
function usageGroups(usage) {
	if (usage === void 0) return [];
	const input = billedInputTokens(usage);
	if (input === 0 && usage.outputTokens === 0) return [];
	const groups = [];
	const hit = cacheHitPercent(usage);
	if (hit !== null) groups.push(`Cache hit ${hit}%`);
	groups.push(`Input ${formatTokens(input)} tok · Output ${formatTokens(usage.outputTokens)} tok`);
	return groups;
}
function contextGroup(pressure) {
	const used = pressure?.projectedTokens ?? pressure?.pressureTokens;
	const capacity = pressure?.contextWindow;
	if (used === void 0 || capacity === void 0) return void 0;
	return `Context ${Math.min(100, Math.round(used / capacity * 100))}% · ~${formatTokens(used)} / ${formatTokens(capacity)}`;
}
/** Web-equivalent whole-session statistics adapted to one terminal line. */
function composerStats(projections) {
	const groups = [...statsGroups(projections.sessionStats), ...usageGroups(projections.tokenUsage)];
	const context = contextGroup(projections.contextPressure);
	if (context !== void 0) groups.push(context);
	return groups.join(" | ");
}
//#endregion
//#region src/diff-location.ts
/** Resolve absolute line numbers for applied diff hunks against the live workspace. */
/** Find a unique hunk after-image and return its one-based file line. */
function locateHunkStart(fileText, newText) {
	if (newText === "") return void 0;
	const normalizedFile = fileText.replaceAll("\r\n", "\n");
	const normalizedHunk = newText.replaceAll("\r\n", "\n");
	const first = normalizedFile.indexOf(normalizedHunk);
	if (first < 0 || normalizedFile.indexOf(normalizedHunk, first + 1) >= 0) return void 0;
	return normalizedFile.slice(0, first).split("\n").length;
}
/** Cache asynchronous workspace lookups so rendering never performs filesystem I/O. */
var DiffLineLocator = class {
	sessionId;
	attempted = /* @__PURE__ */ new Set();
	starts = /* @__PURE__ */ new Map();
	/** Current immutable-by-convention lookup table. */
	get current() {
		return this.starts;
	}
	/** Resolve newly arrived applied diffs and notify the caller when display data improves. */
	resolve(state, onChange) {
		const sessionId = state.sessionId === void 0 ? void 0 : String(state.sessionId);
		if (sessionId !== this.sessionId) {
			this.sessionId = sessionId;
			this.attempted.clear();
			this.starts.clear();
		}
		for (const entry of state.events) {
			if (entry.event.type !== "tool/result" || entry.view?.for !== "result" || entry.view.view.card !== "diff") continue;
			const source = entry.event.data.message.source;
			if (source.kind !== "tool") continue;
			const attemptKey = `${sessionId ?? ""}:${entry.event.seq}`;
			if (this.attempted.has(attemptKey)) continue;
			this.attempted.add(attemptKey);
			const cardKey = `${String(source.callId)}:diff`;
			const diffs = entry.view.view.diffs;
			const generation = this.sessionId;
			Promise.all(diffs.map(async (diff) => {
				if (diff.oldText === null) return 1;
				try {
					const path = isAbsolute(diff.path) ? diff.path : resolve(state.cwd, diff.path);
					return locateHunkStart(await readFile(path, "utf8"), diff.newText);
				} catch (error) {
					if (error.code === "ENOENT") return void 0;
					return;
				}
			})).then((resolved) => {
				if (generation !== this.sessionId || resolved.every((value) => value === void 0)) return;
				this.starts.set(cardKey, resolved);
				onChange();
			});
		}
	}
};
//#endregion
//#region src/diff.ts
/** Claude Code-style terminal projection for Harness file-diff render intent. */
function contentLines(text) {
	if (text === "") return [];
	return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}
function operationName(title, diffs) {
	if (/^(?:edit|update)\b/i.test(title)) return "Update";
	if (/^write\b/i.test(title)) return diffs.every((diff) => diff.oldText === null) ? "Write" : "Update";
	if (/^(?:delete|remove)\b/i.test(title)) return "Delete";
	const firstWord = title.trim().split(/\s+/, 1)[0];
	return firstWord === void 0 || firstWord === "" ? "Update" : firstWord;
}
function pushHunk(lines, diff, start) {
	let added = 0;
	let removed = 0;
	let oldNumber = start;
	let newNumber = start;
	if (diff.oldText === null) {
		newNumber = 1;
		for (const text of contentLines(diff.newText)) {
			lines.push({
				kind: "add",
				path: diff.path,
				text,
				number: newNumber
			});
			newNumber = (newNumber ?? 0) + 1;
			added += 1;
		}
		return {
			added,
			removed
		};
	}
	for (const change of diffLines(diff.oldText, diff.newText)) for (const text of contentLines(change.value)) if (change.removed === true) {
		lines.push({
			kind: "del",
			path: diff.path,
			text,
			number: oldNumber
		});
		if (oldNumber !== void 0) oldNumber += 1;
		removed += 1;
	} else if (change.added === true) {
		lines.push({
			kind: "add",
			path: diff.path,
			text,
			number: newNumber
		});
		if (newNumber !== void 0) newNumber += 1;
		added += 1;
	} else {
		lines.push({
			kind: "context",
			path: diff.path,
			text,
			number: newNumber
		});
		if (oldNumber !== void 0) oldNumber += 1;
		if (newNumber !== void 0) newNumber += 1;
	}
	return {
		added,
		removed
	};
}
/** Build exact changed rows while retaining the contextual lines supplied by Harness. */
function buildDiffDisplay(title, diffs, starts = []) {
	const paths = new Set(diffs.map((diff) => diff.path));
	const lines = [];
	let previousPath;
	let added = 0;
	let removed = 0;
	for (const [index, diff] of diffs.entries()) {
		if (paths.size > 1 && diff.path !== previousPath) lines.push({
			kind: "file",
			path: diff.path,
			text: diff.path
		});
		else if (diff.path === previousPath) lines.push({
			kind: "gap",
			path: diff.path,
			text: "⋯"
		});
		previousPath = diff.path;
		const counts = pushHunk(lines, diff, starts[index]);
		added += counts.added;
		removed += counts.removed;
	}
	return {
		operation: operationName(title, diffs),
		target: paths.size === 1 ? diffs[0]?.path ?? "" : `${paths.size} files`,
		lines,
		added,
		removed,
		files: paths.size
	};
}
const LANGUAGE_BY_EXTENSION = {
	c: "c",
	cc: "cpp",
	cpp: "cpp",
	css: "css",
	go: "go",
	h: "c",
	html: "html",
	java: "java",
	js: "javascript",
	json: "json",
	jsx: "javascript",
	md: "markdown",
	py: "python",
	rb: "ruby",
	rs: "rust",
	sh: "bash",
	sql: "sql",
	ts: "typescript",
	tsx: "typescript",
	xml: "xml",
	yaml: "yaml",
	yml: "yaml"
};
function syntaxTheme(theme) {
	return {
		keyword: theme.error,
		built_in: theme.accent,
		type: theme.accent,
		literal: theme.accent,
		number: theme.warning,
		regexp: theme.error,
		string: theme.warning,
		symbol: theme.warning,
		class: theme.accent,
		function: theme.success,
		title: theme.bold,
		comment: theme.reasoning,
		doctag: theme.reasoning,
		meta: theme.reasoning,
		tag: theme.accent,
		name: theme.accent,
		attr: theme.success,
		variable: theme.warning
	};
}
/** Apply extension-selected terminal syntax colors without trusting file text as ANSI. */
function highlightDiffText(text, path, theme) {
	const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	const language = LANGUAGE_BY_EXTENSION[extension];
	if (language === void 0 || !supportsLanguage(language)) return text;
	return highlight(text, {
		language,
		ignoreIllegals: true,
		theme: syntaxTheme(theme)
	});
}
/** Human-readable Claude-style changed-line summary. */
function diffSummary(added, removed) {
	const parts = [];
	if (added > 0) parts.push(`Added ${added} line${added === 1 ? "" : "s"}`);
	if (removed > 0) parts.push(`removed ${removed} line${removed === 1 ? "" : "s"}`);
	return parts.length === 0 ? "No textual changes" : parts.join(", ");
}
//#endregion
//#region src/transcript.ts
function stepKey(turn, step) {
	return `${turn}:${step}`;
}
function messageText(content, reasoning) {
	return content.filter((block) => block.type === "text" || reasoning && block.type === "reasoning").map((block) => block.type === "reasoning" ? `> ${block.text ?? ""}` : block.text ?? "").join("\n");
}
function reasoningText(content) {
	return content.filter((block) => block.type === "reasoning").map((block) => block.text ?? "").join("\n");
}
function callTitle(name, view) {
	if (view === void 0) return name;
	if (view.card === "terminal") return `$ ${view.title}`;
	return view.title;
}
function boundedLines(value, limit) {
	const lines = sanitizeTerminalText(value).split("\n");
	if (lines.length <= limit) return lines.join("\n");
	const head = Math.max(1, Math.ceil(limit / 2));
	const tail = Math.max(1, Math.floor(limit / 2));
	return [
		...lines.slice(0, head),
		`… ${lines.length - head - tail} lines hidden …`,
		...lines.slice(-tail)
	].join("\n");
}
function rawResultText(entry) {
	if (entry.event.type !== "tool/result") return "";
	const result = entry.event.data.message.content[0];
	if (result?.type !== "tool-result") return "";
	return messageText(result.content, true);
}
function resultTitle(view) {
	return view?.title;
}
function resultBody(view, fallback, limit) {
	if (view === void 0) return boundedLines(fallback, limit);
	switch (view.card) {
		case "terminal": {
			const status = view.signal !== void 0 ? `[${view.signal}]` : view.exitCode === void 0 ? "" : `[exit ${view.exitCode}]`;
			return boundedLines([view.output ?? "", status].filter(Boolean).join("\n"), limit);
		}
		case "diff": return boundedLines(view.diffs.flatMap((diff) => [
			`--- ${diff.path}`,
			`+++ ${diff.path}`,
			...diff.oldText === null ? [] : diff.oldText.split("\n").map((line) => `- ${line}`),
			...diff.newText.split("\n").map((line) => `+ ${line}`)
		]).join("\n"), limit);
		case "search":
			if (view.shape === "paths") return boundedLines([...view.paths, ...view.truncated ? [`… ${view.total - view.paths.length} more results …`] : []].join("\n"), limit);
			return boundedLines(view.files.flatMap((file) => [file.path, ...file.matches.map((match) => `  ${match.lineNumber}: ${match.line}`)]).join("\n"), limit);
		case "read": return boundedLines(view.lines.map((line) => `${String(line.number).padStart(4)}  ${line.text}`).join("\n"), limit);
		case "web":
			if (view.kind === "fetch") return boundedLines(`${view.statusCode} ${view.url}${view.truncated ? "\n… content truncated …" : ""}`, limit);
			return boundedLines([
				view.answer ?? "",
				...view.sources.map((source) => `- ${source.title ?? source.url} — ${source.url}`),
				...view.truncated ? ["… sources truncated …"] : []
			].filter(Boolean).join("\n"), limit);
		case "generic": return boundedLines(view.content === void 0 ? fallback : messageText(view.content, true), limit);
	}
}
function rowsFromState(state, theme, showReasoning, showDetails, maxToolOutputLines) {
	const rows = [];
	const finalSteps = /* @__PURE__ */ new Set();
	const results = /* @__PURE__ */ new Map();
	for (const entry of state.events) {
		const event = entry.event;
		if (event.type === "assistant/message") finalSteps.add(stepKey(event.data.turn, event.data.step));
		if (event.type === "tool/result") results.set(String(event.data.message.source.callId), entry);
	}
	const partials = /* @__PURE__ */ new Map();
	for (const entry of state.events) {
		const event = entry.event;
		switch (event.type) {
			case "user/message": {
				if (event.surfaceOp !== "append") break;
				const human = event.data.source.kind === "user";
				if (!human && !showDetails) break;
				const text = messageText(event.data.content, showReasoning);
				if (text.trim() === "") break;
				rows.push({
					...human ? { prompt: true } : {
						label: "Context",
						labelPaint: theme.dim
					},
					body: text,
					markdown: human,
					dim: !human
				});
				break;
			}
			case "assistant/chunk": {
				const key = stepKey(event.data.turn, event.data.step);
				if (finalSteps.has(key)) break;
				const chunk = event.data.chunk;
				if (chunk.type !== "text-delta" && chunk.type !== "reasoning-delta") break;
				let partial = partials.get(key);
				if (partial === void 0) {
					partial = {
						textIndex: void 0,
						thinkingIndex: void 0,
						text: "",
						reasoning: ""
					};
					partials.set(key, partial);
				}
				if (chunk.type === "reasoning-delta") {
					if (!showReasoning) break;
					partial.reasoning += chunk.text;
					if (partial.thinkingIndex === void 0) {
						partial.thinkingIndex = rows.length;
						rows.push({});
					}
					rows[partial.thinkingIndex] = { thinking: {
						key: `${key}:thinking`,
						text: partial.reasoning,
						streaming: true
					} };
					break;
				}
				partial.text += chunk.text;
				if (partial.textIndex === void 0) {
					partial.textIndex = rows.length;
					rows.push({});
				}
				rows[partial.textIndex] = {
					body: partial.text,
					markdown: true
				};
				break;
			}
			case "assistant/message": {
				if (event.surfaceOp !== "append") {
					rows.push({
						label: "Context",
						labelPaint: theme.dim,
						body: "Earlier model context was compacted.",
						dim: true
					});
					break;
				}
				const reasoning = reasoningText(event.data.message.content);
				if (showReasoning && reasoning.trim() !== "") rows.push({ thinking: {
					key: `${stepKey(event.data.turn, event.data.step)}:thinking`,
					text: reasoning,
					streaming: false
				} });
				const text = messageText(event.data.message.content, false);
				if (text.trim() !== "") rows.push({
					body: text,
					markdown: true
				});
				break;
			}
			case "tool/call": {
				const callView = entry.view?.for === "call" ? entry.view.view : void 0;
				const result = results.get(String(event.data.callId));
				const resultView = result?.view?.for === "result" ? result.view.view : void 0;
				const failed = result?.event.type === "tool/result" && result.event.data.error !== void 0;
				const title = resultTitle(resultView) ?? callTitle(event.data.name, callView);
				const diffView = resultView?.card === "diff" ? resultView : result === void 0 && callView?.card === "diff" ? callView : void 0;
				if (!failed && diffView !== void 0 && diffView.diffs.length > 0) {
					rows.push({ diff: {
						key: `${String(event.data.callId)}:diff`,
						title: sanitizeTerminalText(title),
						settled: result !== void 0,
						diffs: diffView.diffs
					} });
					break;
				}
				const body = result === void 0 ? showDetails ? displayUnknown(event.data.arguments) : void 0 : showDetails ? resultBody(resultView, rawResultText(result), maxToolOutputLines) : void 0;
				rows.push({
					label: `${result === void 0 ? "○" : failed ? "×" : "●"} ${sanitizeTerminalText(title)}`,
					labelPaint: result === void 0 ? theme.warning : failed ? theme.error : theme.success,
					...body === void 0 || body === "" ? {} : {
						body,
						dim: true
					}
				});
				break;
			}
			case "turn/end": if (event.data.reason.kind === "error") rows.push({
				label: "Error",
				labelPaint: theme.error,
				body: event.data.reason.error.message
			});
			else if (event.data.reason.kind === "max-tokens") rows.push({
				label: "Notice",
				labelPaint: theme.warning,
				body: "The response reached the model output limit. Send “continue” to proceed."
			});
		}
	}
	const visibleQueueRpcIds = /* @__PURE__ */ new Set();
	for (const item of state.queue) {
		if (item.placement === "context") continue;
		const body = messageText(item.message.content, false);
		if (body.trim() === "") continue;
		const source = item.message.source;
		if (source.kind === "user" && "rpcId" in source) visibleQueueRpcIds.add(String(source.rpcId));
		rows.push({
			prompt: true,
			body,
			promptStatus: item.placement === "steering" ? "Steering next step…" : "Queued"
		});
	}
	let localWorking = false;
	for (const submission of state.pendingSubmissions) {
		if (submission.rpcId !== void 0 && visibleQueueRpcIds.has(String(submission.rpcId))) continue;
		if (submission.intent === "working") localWorking = true;
		rows.push({
			prompt: true,
			body: submission.text,
			...submission.intent === "queueing" ? { promptStatus: "Queueing…" } : submission.intent === "steering" ? { promptStatus: "Steering…" } : {}
		});
	}
	if (state.notice !== void 0) rows.push({
		label: "Notice",
		labelPaint: theme.accent,
		body: state.notice
	});
	if (state.error !== void 0) rows.push({
		label: "Error",
		labelPaint: theme.error,
		body: state.error
	});
	if (localWorking || state.running) rows.push({ activity: true });
	return rows;
}
/** Scrollback-first transcript component rebuilt from the current API event window. */
var TranscriptComponent = class {
	theme;
	showReasoning;
	maxToolOutputLines;
	thinkingMaxLines;
	state;
	showDetails = false;
	expandedThinking = /* @__PURE__ */ new Set();
	collapsedDiffs = /* @__PURE__ */ new Set();
	followingThinking = /* @__PURE__ */ new Set();
	blockOffsets = /* @__PURE__ */ new Map();
	blockMaxOffsets = /* @__PURE__ */ new Map();
	blockHits = [];
	hoveredBlockKey;
	diffLineStarts = /* @__PURE__ */ new Map();
	activityFrame = "·";
	activityElapsedSeconds = 0;
	constructor(state, theme, showReasoning, maxToolOutputLines, thinkingMaxLines = 8) {
		this.theme = theme;
		this.showReasoning = showReasoning;
		this.maxToolOutputLines = maxToolOutputLines;
		this.thinkingMaxLines = thinkingMaxLines;
		this.state = state;
	}
	setState(state) {
		if (state.sessionId !== this.state.sessionId) {
			this.expandedThinking.clear();
			this.collapsedDiffs.clear();
			this.followingThinking.clear();
			this.blockOffsets.clear();
			this.blockMaxOffsets.clear();
			this.hoveredBlockKey = void 0;
		}
		this.state = state;
	}
	setDetails(show) {
		this.showDetails = show;
	}
	/** Update the one application-owned activity indicator shown for a running turn. */
	setActivity(frame, elapsedSeconds) {
		this.activityFrame = frame;
		this.activityElapsedSeconds = Math.max(0, Math.floor(elapsedSeconds));
	}
	/** Supply asynchronously resolved absolute file-line starts for diff cards. */
	setDiffLineStarts(starts) {
		this.diffLineStarts = starts;
	}
	invalidate() {}
	/** Apply one pointer action to the block rendered at a transcript-relative row. */
	handlePointer(line, action) {
		const hit = this.blockHits.find((candidate) => line >= candidate.firstLine && line <= candidate.lastLine);
		if (action === "move") {
			const next = hit?.titleLine === line ? hit.key : void 0;
			if (next === this.hoveredBlockKey) return false;
			this.hoveredBlockKey = next;
			return true;
		}
		if (action === "click") {
			if (hit === void 0 || hit.titleLine !== line) return false;
			this.hoveredBlockKey = hit.key;
			if (hit.kind === "thinking") {
				if (this.expandedThinking.delete(hit.key)) {
					this.followingThinking.delete(hit.key);
					this.blockOffsets.delete(hit.key);
				} else {
					this.expandedThinking.add(hit.key);
					this.followingThinking.add(hit.key);
				}
			} else if (!this.collapsedDiffs.delete(hit.key)) {
				this.collapsedDiffs.add(hit.key);
				this.blockOffsets.delete(hit.key);
			}
			return true;
		}
		if (hit === void 0 || hit.kind === "thinking" && !this.expandedThinking.has(hit.key) || hit.kind === "diff" && this.collapsedDiffs.has(hit.key)) return false;
		return this.scrollBlock(hit.key, action === "wheel-up" ? -3 : 3, hit.kind === "thinking");
	}
	render(width) {
		const safeWidth = Math.max(1, width);
		const lines = [];
		const rows = rowsFromState(this.state, this.theme, this.showReasoning, this.showDetails, this.maxToolOutputLines);
		this.blockHits = [];
		for (const [index, row] of rows.entries()) {
			if (index > 0) lines.push("");
			if (row.activity) {
				lines.push([this.theme.accent(this.activityFrame), this.theme.dim(` Working (${this.activityElapsedSeconds}s · esc to interrupt)`)].join(""));
				continue;
			}
			if (row.thinking !== void 0) {
				this.pushBlock(lines, this.renderThinking(row.thinking, safeWidth), row.thinking.key, "thinking");
				continue;
			}
			if (row.diff !== void 0) {
				this.pushBlock(lines, this.renderDiff(row.diff, safeWidth), row.diff.key, "diff");
				continue;
			}
			if (row.prompt && row.body !== void 0) {
				lines.push(...this.renderPromptBlock(row.body, row.promptStatus, safeWidth));
				continue;
			}
			if (row.label !== void 0) lines.push(truncateToWidth((row.labelPaint ?? ((text) => text))(row.label), safeWidth));
			if (row.body === void 0 || row.body === "") continue;
			const body = sanitizeTerminalText(row.body);
			if (row.markdown) {
				const markdown = new Markdown(body, 0, 0, this.theme.markdown, row.dim ? { color: this.theme.dim } : void 0);
				lines.push(...markdown.render(safeWidth));
			} else {
				const styled = row.dim ? this.theme.dim(body) : body;
				lines.push(...wrapTextWithAnsi(styled, safeWidth));
			}
		}
		if (this.hoveredBlockKey !== void 0 && !this.blockHits.some((hit) => hit.key === this.hoveredBlockKey)) this.hoveredBlockKey = void 0;
		return lines;
	}
	renderPromptBlock(body, status, width) {
		const paintLine = (line) => {
			const clipped = truncateToWidth(line, width, "…");
			const padding = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
			return this.theme.userBlock(`${clipped}${padding}`);
		};
		const lines = [paintLine(" ".repeat(width))];
		let firstLine = true;
		for (const sourceLine of sanitizeTerminalText(body).split("\n")) {
			const wrapped = wrapTextWithAnsi(sourceLine, Math.max(1, width - 4));
			for (const wrappedLine of wrapped.length === 0 ? [""] : wrapped) {
				const marker = firstLine ? "› " : "  ";
				lines.push(paintLine(` ${this.theme.user(`${marker}${wrappedLine}`)} `));
				firstLine = false;
			}
		}
		if (status !== void 0) lines.push(paintLine(`   ${this.theme.dim(this.theme.user(status))} `));
		lines.push(paintLine(" ".repeat(width)));
		return lines;
	}
	pushBlock(lines, rendered, key, kind) {
		const titleLine = lines.length;
		lines.push(...rendered);
		this.blockHits.push({
			key,
			kind,
			titleLine,
			firstLine: titleLine,
			lastLine: lines.length - 1
		});
	}
	renderThinking(thinking, width) {
		const expanded = this.expandedThinking.has(thinking.key);
		const marker = expanded ? "▾" : "▸";
		const label = thinking.streaming ? "Thinking…" : "Thought";
		if (!expanded) return [this.renderBlockTitle(`${marker} ${label}`, thinking.key, width, this.theme.reasoning)];
		const contentWidth = Math.max(1, width - 2);
		const content = new Markdown(sanitizeTerminalText(thinking.text), 0, 0, this.theme.markdown, { color: this.theme.reasoning }).render(contentWidth);
		const { offset, maxOffset } = this.resolveBlockOffset(thinking.key, content.length, this.thinkingMaxLines, thinking.streaming && this.followingThinking.has(thinking.key));
		const visible = content.slice(offset, offset + this.thinkingMaxLines);
		const range = maxOffset === 0 ? "" : ` · ${offset + 1}-${Math.min(content.length, offset + this.thinkingMaxLines)}/${content.length}`;
		return [this.renderBlockTitle(`${marker} ${label}${range}`, thinking.key, width, this.theme.reasoning), ...visible.map((line) => truncateToWidth(`${this.theme.reasoning("│")} ${line}`, width))];
	}
	renderDiff(diff, width) {
		const model = buildDiffDisplay(diff.title, diff.diffs, this.diffLineStarts.get(diff.key) ?? []);
		const collapsed = this.collapsedDiffs.has(diff.key);
		const title = this.renderDiffTitle(model.operation, model.target, diff.settled, collapsed, diff.key, width);
		if (collapsed) return [title];
		const { offset } = this.resolveBlockOffset(diff.key, model.lines.length, this.maxToolOutputLines, false);
		const visible = model.lines.slice(offset, offset + this.maxToolOutputLines);
		const numberWidth = Math.max(2, ...model.lines.map((line) => String(line.number ?? "").length));
		return [
			title,
			truncateToWidth(this.theme.dim(`  └ ${diffSummary(model.added, model.removed)}`), width),
			...visible.map((line) => this.renderDiffLine(line, width, numberWidth))
		];
	}
	renderDiffTitle(operation, target, settled, collapsed, key, width) {
		const marker = collapsed ? "▸ " : "";
		const cleanOperation = sanitizeTerminalText(operation);
		const cleanTarget = sanitizeTerminalText(target);
		const status = settled ? "●" : "○";
		const plain = `${marker}${status} ${cleanOperation}(${cleanTarget})`;
		if (this.hoveredBlockKey === key) return this.theme.hover(truncateToWidth(plain, width, "…"));
		return truncateToWidth([
			marker,
			(settled ? this.theme.success : this.theme.warning)(status),
			` ${this.theme.assistant(cleanOperation)}(`,
			this.theme.underline(cleanTarget),
			")"
		].join(""), width, "…");
	}
	renderDiffLine(line, width, numberWidth) {
		switch (line.kind) {
			case "file": return truncateToWidth(this.theme.bold(`  ${sanitizeTerminalText(line.text)}`), width);
			case "gap": return truncateToWidth(this.theme.dim("  ⋯"), width);
			case "context": {
				const prefix = this.theme.dim(`${String(line.number ?? "").padStart(numberWidth)}   `);
				const code = highlightDiffText(sanitizeTerminalText(line.text), line.path, this.theme);
				return truncateToWidth(`${prefix}${code}`, width, "…");
			}
			case "del": {
				const prefix = this.theme.error(`${String(line.number ?? "").padStart(numberWidth)} - `);
				const code = highlightDiffText(sanitizeTerminalText(line.text), line.path, this.theme);
				return this.theme.diffRemoved(truncateToWidth(`${prefix}${code}`, width, "…", true));
			}
			case "add": {
				const prefix = this.theme.success(`${String(line.number ?? "").padStart(numberWidth)} + `);
				const code = highlightDiffText(sanitizeTerminalText(line.text), line.path, this.theme);
				return this.theme.diffAdded(truncateToWidth(`${prefix}${code}`, width, "…", true));
			}
		}
	}
	renderBlockTitle(title, key, width, paint) {
		const text = truncateToWidth(sanitizeTerminalText(title), width, "…");
		return this.hoveredBlockKey === key ? this.theme.hover(text) : paint(text);
	}
	resolveBlockOffset(key, lines, limit, follow) {
		const maxOffset = Math.max(0, lines - limit);
		this.blockMaxOffsets.set(key, maxOffset);
		const offset = follow ? maxOffset : Math.max(0, Math.min(maxOffset, this.blockOffsets.get(key) ?? 0));
		this.blockOffsets.set(key, offset);
		return {
			offset,
			maxOffset
		};
	}
	scrollBlock(key, delta, thinking) {
		const maxOffset = this.blockMaxOffsets.get(key) ?? 0;
		const current = this.blockOffsets.get(key) ?? 0;
		const next = Math.max(0, Math.min(maxOffset, current + delta));
		if (next === current) return false;
		this.blockOffsets.set(key, next);
		if (thinking) {
			if (next === maxOffset && delta > 0) this.followingThinking.add(key);
			else if (delta < 0) this.followingThinking.delete(key);
		}
		return true;
	}
};
//#endregion
//#region src/layout.ts
/** Main-screen layout with a fixed composer and an application-owned transcript viewport. */
var ComposerAnchoredLayout = class extends Container {
	header;
	transcript;
	status;
	editor;
	footer;
	viewportRows;
	composerOverride;
	transcriptTop;
	renderedTranscriptTop = 0;
	renderedTranscriptRows = 0;
	renderedTranscriptScreenRow = 0;
	maxTranscriptTop = 0;
	transcriptPageRows = 1;
	constructor(header, transcript, status, editor, footer, viewportRows) {
		super();
		this.header = header;
		this.transcript = transcript;
		this.status = status;
		this.editor = editor;
		this.footer = footer;
		this.viewportRows = viewportRows;
		this.addChild(header);
		this.addChild(transcript);
		this.addChild(status);
		this.addChild(editor);
		this.addChild(footer);
	}
	/** Whether new transcript output remains pinned to the bottom edge. */
	get followsTranscriptTail() {
		return this.transcriptTop === void 0;
	}
	render(width) {
		const header = this.header.render(width);
		const transcript = this.transcript.render(width);
		const composer = this.renderComposer(width);
		const fixedRows = header.length + 1 + composer.length;
		const availableRows = Math.max(0, this.viewportRows() - fixedRows);
		this.transcriptPageRows = Math.max(1, availableRows);
		this.maxTranscriptTop = Math.max(0, transcript.length - availableRows);
		const requestedTop = this.transcriptTop ?? this.maxTranscriptTop;
		const top = Math.max(0, Math.min(this.maxTranscriptTop, requestedTop));
		if (this.transcriptTop !== void 0 && top === this.maxTranscriptTop) this.transcriptTop = void 0;
		this.renderedTranscriptTop = top;
		const visible = transcript.slice(top, top + availableRows);
		this.renderedTranscriptRows = visible.length;
		this.renderedTranscriptScreenRow = header.length + 1;
		const gap = Math.max(0, availableRows - visible.length);
		return [
			...header,
			"",
			...visible,
			...Array(gap).fill(""),
			...composer
		];
	}
	/** Replace the editor area with an inline modal surface, or restore the editor. */
	setComposerOverride(component) {
		if (this.composerOverride !== void 0) this.removeChild(this.composerOverride);
		this.composerOverride = component;
		if (component !== void 0) this.addChild(component);
	}
	/** Move the transcript viewport by rendered lines; positive values move toward newer output. */
	scrollTranscript(delta) {
		const current = this.transcriptTop ?? this.maxTranscriptTop;
		const next = Math.max(0, Math.min(this.maxTranscriptTop, current + delta));
		const normalized = next === this.maxTranscriptTop ? void 0 : next;
		if (normalized === this.transcriptTop) return false;
		this.transcriptTop = normalized;
		return true;
	}
	/** Move one transcript page while keeping one context line visible. */
	pageTranscript(direction) {
		return this.scrollTranscript(direction * Math.max(1, this.transcriptPageRows - 1));
	}
	/** Resume automatic tail following after viewing older output. */
	followTranscript() {
		if (this.transcriptTop === void 0) return false;
		this.transcriptTop = void 0;
		return true;
	}
	/** Map one terminal row to the corresponding full-transcript rendered line. */
	transcriptRowAt(screenRow, viewportTop) {
		const relative = viewportTop + screenRow - this.renderedTranscriptScreenRow;
		if (relative < 0 || relative >= this.renderedTranscriptRows) return -1;
		return this.renderedTranscriptTop + relative;
	}
	renderComposer(width) {
		if (this.composerOverride !== void 0) return this.composerOverride.render(width);
		return [
			...this.status.render(width),
			...this.editor.render(width),
			...this.footer.render(width)
		];
	}
};
//#endregion
//#region src/mouse.ts
/** Enable SGR mouse coordinates and pointer-motion reports on the main screen. */
const ENABLE_MOUSE_TRACKING = "\x1B[?1000h\x1B[?1003h\x1B[?1006h";
/** Restore normal terminal-owned pointer behavior. */
const DISABLE_MOUSE_TRACKING = "\x1B[?1006l\x1B[?1003l\x1B[?1000l";
/** Decode an SGR mouse report, leaving all keyboard input untouched. */
function parseMouseReport(data) {
	const match = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
	if (match === null) return void 0;
	return {
		button: Number.parseInt(match[1] ?? "", 10),
		x: Number.parseInt(match[2] ?? "", 10) - 1,
		y: Number.parseInt(match[3] ?? "", 10) - 1,
		release: match[4] === "m"
	};
}
//#endregion
//#region src/app.ts
const DOUBLE_ESCAPE_MS = 600;
const COMMANDS = [
	{
		name: "help",
		description: "Show terminal commands"
	},
	{
		name: "clear",
		description: "Clear the conversation and start a new session"
	},
	{
		name: "new",
		description: "Create a new session"
	},
	{
		name: "resume",
		description: "Switch to another session",
		argumentHint: "[session-id]"
	},
	{
		name: "model",
		description: "Select model and provider",
		argumentHint: "[provider/model]"
	},
	{
		name: "details",
		description: "Toggle expanded tool output"
	},
	{
		name: "status",
		description: "Show current session status"
	},
	{
		name: "memories",
		description: "Manage project memory and session learning"
	},
	{
		name: "rewind",
		description: "Open the workspace and conversation checkpoint history"
	},
	{
		name: "exit",
		description: "Exit the terminal client"
	}
];
function sessionDescription(session) {
	return session.cwd ?? String(session.sessionId);
}
function questionTitle(question) {
	return [question.header, question.question].filter(Boolean).join(" · ");
}
/** Main-screen pi-tui application for one in-process Harness API client. */
var TuiApplication = class {
	config;
	runtime;
	checkpoints;
	memory;
	terminal = new ProcessTerminal();
	tui;
	theme;
	controller;
	header;
	status = new Text("", 0, 0);
	footer = new Text("", 0, 0);
	editor;
	transcript;
	diffLineLocator = new DiffLineLocator();
	layout;
	removeInputListener;
	spinner;
	spinnerFrame = 0;
	workingStartedAt;
	workingSessionId = void 0;
	showDetails = false;
	lastEscapeAt = 0;
	rewindArmTimer;
	disposed = false;
	exiting = false;
	interactionActive = false;
	composerModalActive = false;
	rewindProgress;
	rewindSummaries;
	rewindCheckpointDialog;
	rewindSurfaceGeneration = 0;
	memoryActivity = { state: "idle" };
	removeMemoryActivity;
	interactionQueue = [];
	autocompleteCwd;
	constructor(api, config, runtime, checkpoints, memory) {
		this.config = config;
		this.runtime = runtime;
		this.checkpoints = checkpoints;
		this.memory = memory;
		this.theme = createTheme(config.color);
		this.tui = new TuiMainScreen(this.terminal, config.showHardwareCursor);
		const initial = {
			sessionId: void 0,
			cwd: config.cwd,
			running: false,
			connected: false,
			events: [],
			queue: [],
			pendingSubmissions: [],
			models: void 0,
			projections: {},
			notice: void 0,
			error: void 0
		};
		this.controller = new HarnessController(api, this, config.cwd, config.historyMessages);
		this.header = new Text("", 0, 0);
		this.transcript = new TranscriptComponent(initial, this.theme, config.showReasoning, config.maxToolOutputLines, config.thinkingMaxLines);
		this.editor = new Editor(this.tui, this.theme.editor, {
			paddingX: 1,
			autocompleteMaxVisible: 10
		});
		this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(COMMANDS, config.cwd));
		this.autocompleteCwd = config.cwd;
		this.editor.onSubmit = (text) => {
			this.editor.addToHistory(text);
			this.submit(text);
		};
		this.layout = new ComposerAnchoredLayout(this.header, this.transcript, this.status, this.editor, this.footer, () => this.terminal.rows);
		this.tui.addChild(this.layout);
		this.tui.setFocus(this.editor);
		this.removeMemoryActivity = this.memory.onActivity((activity) => {
			if (this.disposed) return;
			this.memoryActivity = activity;
			this.updateStatus(this.controller.current);
			this.tui.requestRender();
		});
	}
	/** Start raw-mode rendering and bind or resume the configured session. */
	async start() {
		if (!this.runtime.stdin.isTTY || !this.runtime.stdout.isTTY) throw new Error("deepseek-harness-tui requires an interactive TTY");
		this.terminal.setTitle(this.config.title);
		this.removeInputListener = this.tui.addInputListener((data) => this.handleGlobalInput(data));
		this.tui.start();
		this.terminal.write(ENABLE_MOUSE_TRACKING);
		await this.controller.start(this.config.sessionId);
	}
	/** Restore the terminal and stop controller streams. Idempotent. */
	async dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.controller.dispose();
		if (this.spinner !== void 0) clearInterval(this.spinner);
		if (this.rewindArmTimer !== void 0) clearTimeout(this.rewindArmTimer);
		this.removeMemoryActivity();
		this.terminal.write(DISABLE_MOUSE_TRACKING);
		this.removeInputListener?.();
		this.tui.stop();
		await this.terminal.drainInput(250, 30);
	}
	render(state) {
		if (this.disposed) return;
		this.transcript.setState(state);
		this.diffLineLocator.resolve(state, () => {
			if (this.disposed || this.controller.current.sessionId !== state.sessionId) return;
			this.transcript.setDiffLineStarts(this.diffLineLocator.current);
			this.tui.requestRender();
		});
		this.transcript.setDiffLineStarts(this.diffLineLocator.current);
		this.header.setText([this.theme.bold(this.theme.accent(`✦ ${this.config.title}`)), this.theme.dim(`${state.cwd}${state.sessionId === void 0 ? "" : ` · ${String(state.sessionId)}`}`)].join("\n"));
		this.updateStatus(state);
		const selection = state.models?.current;
		const model = selection === void 0 ? "model unavailable" : `${selection.provider}/${selection.model}${selection.reasoningEffort === void 0 ? "" : ` · ${selection.reasoningEffort}`}`;
		const stats = composerStats(state.projections);
		const controls = state.running || state.pendingSubmissions.some((submission) => submission.intent === "working") ? "Enter steer · Alt+Enter queue · Esc cancel" : "Ctrl+O details · Shift+Tab effort · /help";
		this.footer.setText([this.theme.dim(`${model} · ${controls}`), ...stats === "" ? [] : [this.theme.dim(stats)]].join("\n"));
		if (state.cwd !== this.autocompleteCwd) {
			this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(COMMANDS, state.cwd));
			this.autocompleteCwd = state.cwd;
		}
		this.tui.requestRender();
	}
	requestApproval(prompt) {
		this.enqueueInteraction(() => this.showApproval(prompt));
	}
	requestQuestions(prompt) {
		this.enqueueInteraction(() => this.showQuestion(prompt, 0, []));
	}
	updateStatus(state) {
		const history = this.layout.followsTranscriptTail ? "" : " · Viewing history · PageDown to follow";
		if (state.running || state.pendingSubmissions.some((submission) => submission.intent === "working")) {
			if (this.workingStartedAt === void 0 || this.workingSessionId !== state.sessionId) {
				this.workingStartedAt = Date.now();
				this.workingSessionId = state.sessionId;
			}
			if (this.spinner === void 0) this.spinner = setInterval(() => {
				this.spinnerFrame += 1;
				this.updateStatus(this.controller.current);
				this.tui.requestRender();
			}, 160);
			const frames = [
				"·",
				"✢",
				"✳",
				"✦"
			];
			const glyph = frames[this.spinnerFrame % frames.length] ?? "·";
			this.transcript.setActivity(glyph, (Date.now() - this.workingStartedAt) / 1e3);
			this.status.setText(history === "" ? "" : this.theme.dim(history.slice(3)));
			return;
		}
		this.workingStartedAt = void 0;
		this.workingSessionId = void 0;
		if (this.memoryActivity.state === "learning") {
			if (this.spinner === void 0) this.spinner = setInterval(() => {
				this.spinnerFrame += 1;
				this.updateStatus(this.controller.current);
				this.tui.requestRender();
			}, 160);
			const frames = [
				"·",
				"✢",
				"✳",
				"✦"
			];
			const glyph = frames[this.spinnerFrame % frames.length] ?? "·";
			this.status.setText(this.theme.accent(`${glyph} Learning project memory…${history}`));
			return;
		}
		if (this.spinner !== void 0) {
			clearInterval(this.spinner);
			this.spinner = void 0;
		}
		if (this.lastEscapeAt !== 0) {
			this.status.setText(this.theme.warning(`Press Esc again to open rewind checkpoints${history}`));
			return;
		}
		if (this.memoryActivity.state === "error") {
			this.status.setText(this.theme.warning(`Memory learning failed: ${this.memoryActivity.message}${history}`));
			return;
		}
		this.status.setText(state.connected ? this.theme.dim(`Ready · Enter send · ↑/↓ history · Esc Esc rewind${history}`) : this.theme.warning(`Connecting…${history}`));
	}
	handleGlobalInput(data) {
		const mouse = parseMouseReport(data);
		if (mouse !== void 0) {
			this.handleMouse(mouse);
			return { consume: true };
		}
		if (this.composerModalActive) return void 0;
		const escape = matchesKey(data, Key.escape);
		if (!escape && this.lastEscapeAt !== 0) this.disarmRewind();
		if (matchesKey(data, Key.ctrl("c"))) {
			if (this.controller.current.running) this.runAction(() => this.controller.cancel());
			else this.requestExit(0);
			return { consume: true };
		}
		if (matchesKey(data, Key.alt(Key.enter))) {
			this.submitEditor("queue");
			return { consume: true };
		}
		if (this.editor.getExpandedText() === "" && matchesKey(data, Key.pageUp)) {
			if (this.layout.pageTranscript(-1)) {
				this.updateStatus(this.controller.current);
				this.tui.requestRender();
			}
			return { consume: true };
		}
		if (this.editor.getExpandedText() === "" && matchesKey(data, Key.pageDown)) {
			if (this.layout.pageTranscript(1)) {
				this.updateStatus(this.controller.current);
				this.tui.requestRender();
			}
			return { consume: true };
		}
		if (matchesKey(data, Key.ctrl("o"))) {
			this.showDetails = !this.showDetails;
			this.transcript.setDetails(this.showDetails);
			this.tui.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, Key.shift(Key.tab))) {
			this.cycleReasoningEffort();
			return { consume: true };
		}
		if (escape && !this.tui.hasOverlay()) {
			if (this.controller.current.running) {
				this.runAction(() => this.controller.cancel());
				return { consume: true };
			}
			if (this.editor.getExpandedText() === "") {
				const now = Date.now();
				if (now - this.lastEscapeAt <= DOUBLE_ESCAPE_MS) {
					this.disarmRewind();
					this.requestRewind();
				} else this.armRewind(now);
				return { consume: true };
			}
		}
	}
	handleMouse(mouse) {
		const blocked = this.composerModalActive || this.tui.hasOverlay();
		const renderState = this.tui.captureRenderState();
		const transcriptLine = blocked ? -1 : this.layout.transcriptRowAt(mouse.y, renderState.previousViewportTop);
		let changed = this.transcript.handlePointer(transcriptLine, "move");
		if (!blocked && (mouse.button & 64) !== 0) {
			const direction = (mouse.button & 1) === 0 ? -1 : 1;
			const blockScrolled = this.transcript.handlePointer(transcriptLine, direction < 0 ? "wheel-up" : "wheel-down");
			changed = blockScrolled || changed;
			if (!blockScrolled) changed = this.layout.scrollTranscript(direction * 3) || changed;
		} else if (!blocked && mouse.button === 0 && !mouse.release) changed = this.transcript.handlePointer(transcriptLine, "click") || changed;
		if (changed) {
			this.updateStatus(this.controller.current);
			this.tui.requestRender();
		}
	}
	async submitEditor(mode) {
		const text = this.editor.getExpandedText();
		if (text.trim() === "") return;
		this.editor.setText("");
		this.editor.addToHistory(text);
		await this.submit(text, mode);
	}
	async submit(value, forcedMode) {
		const text = value.trim();
		if (text === "") return;
		try {
			if (text.startsWith("/") && await this.handleCommand(text)) return;
			const mode = forcedMode ?? (this.controller.current.running ? "steer" : "queue");
			this.layout.followTranscript();
			await this.controller.prompt(value, mode);
		} catch (error) {
			if (this.editor.getExpandedText() === "") this.editor.setText(value);
			this.controller.notice(error instanceof Error ? error.message : String(error));
		}
	}
	async handleCommand(text) {
		const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
		if (match === null) return false;
		const command = match[1]?.toLowerCase();
		const argument = match[2]?.trim() ?? "";
		switch (command) {
			case "help":
				this.controller.notice([
					"/clear · clear conversation and start a new session",
					"/new · new session",
					"/resume [id] · switch session",
					"/model [provider/model] · select model",
					"/details · expand or collapse tool output",
					"/status · current session details",
					"/memories · manage memory and session learning",
					"/rewind · select a workspace and conversation checkpoint",
					"/exit · leave the TUI"
				].join("\n"));
				return true;
			case "clear":
				this.layout.followTranscript();
				await this.controller.clearSession();
				return true;
			case "new":
				await this.controller.newSession();
				return true;
			case "resume":
				if (argument !== "") await this.controller.resume(argument);
				else await this.openSessionSelector();
				return true;
			case "model":
				if (argument !== "") await this.selectNamedModel(argument);
				else await this.openModelSelector();
				return true;
			case "details":
				this.showDetails = !this.showDetails;
				this.transcript.setDetails(this.showDetails);
				this.tui.requestRender();
				return true;
			case "status": {
				const state = this.controller.current;
				this.controller.notice([
					`Session: ${state.sessionId === void 0 ? "none" : String(state.sessionId)}`,
					`Directory: ${state.cwd}`,
					`State: ${state.running ? "running" : "idle"}`,
					`Stream: ${state.connected ? "connected" : "reconnecting"}`,
					`Queued: ${state.queue.length}`
				].join("\n"));
				return true;
			}
			case "memories":
			case "memory":
				await this.openMemoryDialog();
				return true;
			case "rewind":
				this.requestRewind();
				return true;
			case "exit":
			case "quit":
				await this.requestExit(0);
				return true;
			default: return false;
		}
	}
	requestRewind() {
		this.disarmRewind();
		this.runAction(() => this.openRewind());
	}
	async openRewind() {
		if (this.tui.hasOverlay() || this.composerModalActive) return;
		const sessionId = this.controller.current.sessionId;
		if (sessionId === void 0) throw new Error("no terminal session is active");
		const surfaceGeneration = ++this.rewindSurfaceGeneration;
		this.rewindSummaries = this.checkpoints.list(String(sessionId));
		this.showRewindCheckpointList();
		this.checkpoints.describe(String(sessionId)).then((summaries) => {
			if (surfaceGeneration !== this.rewindSurfaceGeneration || this.controller.current.sessionId !== sessionId || this.rewindSummaries === void 0) return;
			this.rewindSummaries = summaries;
			this.rewindCheckpointDialog?.setSummaries(summaries);
			this.tui.requestRender();
		}).catch((error) => {
			if (surfaceGeneration !== this.rewindSurfaceGeneration) return;
			this.rewindCheckpointDialog?.setInspectionError(error instanceof Error ? error.message : String(error));
			this.tui.requestRender();
		});
	}
	showRewindCheckpointList(selectedCheckpointId) {
		const summaries = this.rewindSummaries;
		if (summaries === void 0) return;
		const dialog = new RewindCheckpointDialog(summaries, selectedCheckpointId, () => this.terminal.rows, this.theme, (summary) => {
			this.openRewindPreview(summary);
		}, () => this.closeRewindSurface());
		this.rewindCheckpointDialog = dialog;
		this.rewindProgress = void 0;
		this.composerModalActive = true;
		this.layout.setComposerOverride(dialog);
		this.tui.setFocus(dialog);
		this.tui.requestRender();
	}
	async openRewindPreview(summary) {
		const sessionId = this.controller.current.sessionId;
		if (sessionId === void 0 || String(sessionId) !== summary.sessionId) {
			this.closeRewindSurface();
			this.controller.notice("The active session changed before the checkpoint could be inspected.");
			return;
		}
		this.showRewindProgress("Preparing selected checkpoint…");
		let preview;
		try {
			preview = await this.checkpoints.preview(String(sessionId), summary.checkpointId);
		} catch (error) {
			this.closeRewindSurface();
			this.controller.notice(error instanceof Error ? error.message : String(error));
			return;
		}
		const dialog = new RewindDialog(preview, this.theme, () => {
			this.showRewindProgress("Restoring workspace checkpoint…");
			this.performRewind(preview);
		}, () => this.showRewindCheckpointList(summary.checkpointId));
		this.rewindCheckpointDialog = void 0;
		this.layout.setComposerOverride(dialog);
		this.tui.setFocus(dialog);
		this.tui.requestRender();
	}
	async performRewind(preview) {
		try {
			const rollback = await this.checkpoints.restore(preview);
			const revertedMemories = [];
			let targetSessionId;
			try {
				for (const mutation of [...preview.memoryMutations ?? []].reverse()) {
					await this.memory.restore(mutation, "before");
					revertedMemories.push(mutation);
				}
				targetSessionId = String(await this.controller.rewind(preview, (phase) => {
					this.showRewindProgress(phase === "forking" ? "Rewinding conversation…" : "Reloading rewound session…");
				}));
			} catch (error) {
				this.showRewindProgress("Rewind failed; restoring the current workspace and memory…");
				const rollbackFailures = [];
				for (const mutation of [...revertedMemories].reverse()) try {
					await this.memory.restore(mutation, "after");
				} catch (rollbackError) {
					rollbackFailures.push(rollbackError);
				}
				try {
					await rollback();
				} catch (rollbackError) {
					rollbackFailures.push(rollbackError);
				}
				if (rollbackFailures.length > 0) throw new Error(`rewind failed (${String(error)}) and rollback also failed (${rollbackFailures.map(String).join("; ")})`);
				throw error;
			}
			this.checkpoints.continueFrom(preview, targetSessionId);
			this.editor.setText(preview.prompt);
		} catch (error) {
			this.controller.notice(error instanceof Error ? error.message : String(error));
		} finally {
			this.closeRewindSurface();
		}
	}
	showRewindProgress(message) {
		if (this.rewindProgress === void 0) this.rewindProgress = new Text("", 1, 0);
		this.composerModalActive = true;
		this.rewindCheckpointDialog = void 0;
		this.layout.setComposerOverride(this.rewindProgress);
		this.tui.setFocus(null);
		this.rewindProgress.setText([
			this.theme.bold("Rewind"),
			this.theme.accent(`✦ ${message}`),
			this.theme.dim("Workspace, memory, and conversation rollback are applied as one operation.")
		].join("\n"));
		this.tui.requestRender();
	}
	closeRewindSurface() {
		this.rewindSurfaceGeneration += 1;
		this.layout.setComposerOverride(void 0);
		this.rewindProgress = void 0;
		this.rewindSummaries = void 0;
		this.rewindCheckpointDialog = void 0;
		this.composerModalActive = false;
		this.tui.setFocus(this.editor);
		this.tui.requestRender();
	}
	armRewind(now) {
		if (this.rewindArmTimer !== void 0) clearTimeout(this.rewindArmTimer);
		this.lastEscapeAt = now;
		this.updateStatus(this.controller.current);
		this.tui.requestRender();
		this.rewindArmTimer = setTimeout(() => {
			this.rewindArmTimer = void 0;
			this.lastEscapeAt = 0;
			if (this.disposed) return;
			this.updateStatus(this.controller.current);
			this.tui.requestRender();
		}, DOUBLE_ESCAPE_MS);
	}
	disarmRewind() {
		if (this.rewindArmTimer !== void 0) clearTimeout(this.rewindArmTimer);
		this.rewindArmTimer = void 0;
		if (this.lastEscapeAt === 0) return;
		this.lastEscapeAt = 0;
		if (this.disposed) return;
		this.updateStatus(this.controller.current);
		this.tui.requestRender();
	}
	async openSessionSelector() {
		if (this.tui.hasOverlay() || this.composerModalActive) return;
		const sessions = await this.controller.sessions();
		const current = this.controller.current.sessionId;
		const items = sessions.filter((session) => session.sessionId !== current).map((session) => ({
			value: String(session.sessionId),
			label: String(session.sessionId),
			description: sessionDescription(session)
		}));
		if (items.length === 0) {
			this.controller.notice("No other sessions are available.");
			return;
		}
		let handle;
		const close = () => {
			handle.hide();
		};
		const dialog = new ChoiceDialog("Resume session", items, this.theme, (item) => {
			close();
			this.runAction(() => this.controller.resume(item.value));
		}, close);
		handle = this.tui.showOverlay(dialog, {
			width: "85%",
			maxHeight: "80%",
			margin: 1
		});
	}
	async openModelSelector() {
		if (this.tui.hasOverlay() || this.composerModalActive) return;
		const models = await this.controller.refreshModels();
		const close = () => {
			this.layout.setComposerOverride(void 0);
			this.composerModalActive = false;
			this.tui.setFocus(this.editor);
			this.tui.requestRender();
		};
		const dialog = new ModelDialog(models, this.theme, (selected) => {
			close();
			this.runAction(() => this.controller.selectModel(selected));
		}, close);
		this.composerModalActive = true;
		this.layout.setComposerOverride(dialog);
		this.tui.setFocus(dialog);
		this.tui.requestRender();
	}
	async openMemoryDialog() {
		if (this.tui.hasOverlay() || this.composerModalActive) return;
		const state = this.controller.current;
		if (state.sessionId === void 0) throw new Error("no terminal session is active");
		const sessionId = String(state.sessionId);
		const overview = await this.memory.overview(state.cwd, sessionId);
		const close = () => {
			this.layout.setComposerOverride(void 0);
			this.composerModalActive = false;
			this.tui.setFocus(this.editor);
			this.tui.requestRender();
		};
		const dialog = new MemoryDialog(overview, () => this.terminal.rows, this.theme, (policy) => {
			this.memory.setPolicy(sessionId, policy);
		}, close);
		this.composerModalActive = true;
		this.layout.setComposerOverride(dialog);
		this.tui.setFocus(dialog);
		this.tui.requestRender();
	}
	async selectNamedModel(name) {
		const matches = (await this.controller.refreshModels()).groups.flatMap((group) => group.models.filter((model) => `${group.id}/${model.id}` === name || model.id === name).map((model) => ({
			provider: group.id,
			model: model.id
		})));
		if (matches.length !== 1) throw new Error(matches.length === 0 ? `model "${name}" was not found` : `model "${name}" is ambiguous; use provider/model`);
		await this.controller.selectModel(matches[0]);
	}
	async cycleReasoningEffort() {
		const models = this.controller.current.models ?? await this.controller.refreshModels();
		const current = models.current;
		const efforts = (models.groups.find((group) => group.id === current.provider)?.models.find((candidate) => candidate.id === current.model))?.reasoning?.efforts;
		if (efforts === void 0 || efforts.length === 0) {
			this.controller.notice("The current model does not expose selectable reasoning efforts.");
			return;
		}
		const values = [void 0, ...efforts.map((effort) => effort.id)];
		const next = values[(values.indexOf(current.reasoningEffort) + 1) % values.length];
		await this.controller.selectModel({
			provider: current.provider,
			model: current.model,
			...next === void 0 ? {} : { reasoningEffort: next }
		});
	}
	enqueueInteraction(job) {
		this.interactionQueue.push(job);
		this.startNextInteraction();
	}
	startNextInteraction() {
		if (this.interactionActive) return;
		const next = this.interactionQueue.shift();
		if (next === void 0) return;
		this.interactionActive = true;
		next();
	}
	completeInteraction() {
		this.interactionActive = false;
		this.startNextInteraction();
	}
	showApproval(prompt) {
		let handle;
		const settle = (outcome) => {
			handle.hide();
			this.runAction(() => this.controller.answerApproval(prompt, outcome)).finally(() => this.completeInteraction());
		};
		const dialog = new ChoiceDialog(`Allow ${sanitizeTerminalText(prompt.toolName)}?`, [{
			value: "allowed-once",
			label: "Allow once",
			...prompt.reason === void 0 ? {} : { description: prompt.reason }
		}, {
			value: "rejected",
			label: "Reject"
		}], this.theme, (item) => settle(item.value === "allowed-once" ? "allowed-once" : "rejected"), () => settle("rejected"), prompt.reason);
		handle = this.tui.showOverlay(dialog, {
			width: "80%",
			maxHeight: "70%",
			margin: 1
		});
	}
	showQuestion(prompt, index, answers) {
		const question = prompt.questions[index];
		if (question === void 0) {
			this.runAction(() => this.controller.answerQuestions(prompt, answers)).finally(() => this.completeInteraction());
			return;
		}
		let handle;
		const close = () => {
			handle.hide();
		};
		const next = (answer) => {
			close();
			this.showQuestion(prompt, index + 1, [...answers, answer]);
		};
		const cancel = () => {
			close();
			this.runAction(() => this.controller.cancelQuestions(prompt)).finally(() => this.completeInteraction());
		};
		const custom = (selected) => {
			close();
			let inputHandle;
			const input = new TextInputDialog(this.tui, `${questionTitle(question)} · Other`, this.theme, (text) => {
				if (text.trim() === "") return;
				inputHandle.hide();
				this.showQuestion(prompt, index + 1, [...answers, {
					id: question.id,
					selected,
					custom: text
				}]);
			}, () => {
				inputHandle.hide();
				cancel();
			});
			inputHandle = this.tui.showOverlay(input, {
				width: "85%",
				maxHeight: "70%",
				margin: 1
			});
		};
		const options = (question.options ?? []).map((option) => ({
			value: option.label,
			label: option.label,
			...option.description === void 0 ? {} : { description: option.description }
		}));
		if (question.multiSelect) {
			const dialog = new MultiSelectDialog(questionTitle(question), options, this.theme, (selected) => next({
				id: question.id,
				selected
			}), custom, cancel);
			handle = this.tui.showOverlay(dialog, {
				width: "85%",
				maxHeight: "80%",
				margin: 1
			});
			return;
		}
		if (options.length === 0) {
			handle = this.tui.showOverlay(new TextInputDialog(this.tui, questionTitle(question), this.theme, (text) => {
				if (text.trim() === "") return;
				next({
					id: question.id,
					selected: [],
					custom: text
				});
			}, cancel), {
				width: "85%",
				maxHeight: "70%",
				margin: 1
			});
			return;
		}
		const customValue = "__dsh_tui_custom__";
		const dialog = new ChoiceDialog(questionTitle(question), [...options, {
			value: customValue,
			label: "Other…"
		}], this.theme, (item) => item.value === customValue ? custom([]) : next({
			id: question.id,
			selected: [item.value]
		}), cancel, question.detail);
		handle = this.tui.showOverlay(dialog, {
			width: "85%",
			maxHeight: "80%",
			margin: 1
		});
	}
	async runAction(action) {
		try {
			await action();
		} catch (error) {
			this.controller.notice(error instanceof Error ? error.message : String(error));
		}
	}
	async requestExit(code) {
		if (this.exiting) return;
		this.exiting = true;
		await this.dispose();
		this.runtime.exit(code);
	}
};
//#endregion
//#region src/checkpoint.ts
const GIT_MAX_OUTPUT_BYTES = 16777216;
function runGit(root, args, extraEnv) {
	return new Promise((resolveOutput, reject) => {
		execFile("git", [
			"-C",
			root,
			...args
		], {
			encoding: "utf8",
			env: {
				...process.env,
				...extraEnv
			},
			maxBuffer: GIT_MAX_OUTPUT_BYTES
		}, (error, stdout, stderr) => {
			if (error === null) {
				resolveOutput(stdout);
				return;
			}
			const detail = stderr.trim();
			reject(new Error(detail === "" ? error.message : detail));
		});
	});
}
async function repositoryRoot(cwd) {
	const root = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
	if (root === "") throw new Error(`directory is not inside a Git worktree: ${cwd}`);
	return realpath(root);
}
async function captureTree(root) {
	const temporary = await mkdtemp(join(tmpdir(), "dsh-rewind-index-"));
	const env = { GIT_INDEX_FILE: join(temporary, "index") };
	try {
		await runGit(root, ["read-tree", (await runGit(root, ["write-tree"])).trim()], env);
		await runGit(root, [
			"add",
			"-A",
			"--",
			"."
		], env);
		return (await runGit(root, ["write-tree"], env)).trim();
	} finally {
		await rm(temporary, {
			recursive: true,
			force: true
		});
	}
}
function parseNulList(output) {
	return output.split("\0").filter((value) => value !== "");
}
async function changedFiles(root, before, after) {
	const [namesOutput, statsOutput] = await Promise.all([runGit(root, [
		"diff",
		"--name-only",
		"-z",
		"--no-renames",
		before,
		after
	]), runGit(root, [
		"diff",
		"--numstat",
		"-z",
		"--no-renames",
		before,
		after
	])]);
	const stats = /* @__PURE__ */ new Map();
	for (const record of parseNulList(statsOutput)) {
		const first = record.indexOf("	");
		const second = first === -1 ? -1 : record.indexOf("	", first + 1);
		if (first === -1 || second === -1) continue;
		const addedRaw = record.slice(0, first);
		const removedRaw = record.slice(first + 1, second);
		stats.set(record.slice(second + 1), {
			...addedRaw === "-" ? {} : { added: Number.parseInt(addedRaw, 10) },
			...removedRaw === "-" ? {} : { removed: Number.parseInt(removedRaw, 10) }
		});
	}
	return parseNulList(namesOutput).map((path) => ({
		path,
		...stats.get(path)
	}));
}
function worktreePath(root, path) {
	const absolute = resolve(root, path);
	const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
	if (!absolute.startsWith(prefix) || relative(root, absolute).startsWith(`..${sep}`)) throw new Error(`checkpoint contains an invalid worktree path: ${path}`);
	return absolute;
}
async function optionalLstat(path) {
	try {
		return await lstat(path);
	} catch (error) {
		if (error.code === "ENOENT") return void 0;
		throw error;
	}
}
async function removeEmptyParents(root, start) {
	let current = start;
	while (current !== root && current.startsWith(`${root}${sep}`)) {
		try {
			await rmdir(current);
		} catch (error) {
			if ([
				"ENOTEMPTY",
				"EEXIST",
				"ENOENT"
			].includes(error.code ?? "")) return;
			throw error;
		}
		current = dirname(current);
	}
}
async function replaceFromStage(root, stage, path) {
	const source = worktreePath(stage, path);
	const destination = worktreePath(root, path);
	const [sourceInfo, destinationInfo] = await Promise.all([optionalLstat(source), optionalLstat(destination)]);
	if (sourceInfo === void 0) {
		if (destinationInfo?.isDirectory()) throw new Error(`cannot remove directory while restoring file path: ${path}`);
		await rm(destination, { force: true });
		await removeEmptyParents(root, dirname(destination));
		return;
	}
	if (sourceInfo.isDirectory() || destinationInfo?.isDirectory()) throw new Error(`submodules or file/directory replacements are not supported by rewind: ${path}`);
	await mkdir(dirname(destination), { recursive: true });
	const temporary = join(dirname(destination), `.dsh-rewind-${randomUUID()}`);
	try {
		if (sourceInfo.isSymbolicLink()) await symlink(await readlink(source), temporary);
		else if (sourceInfo.isFile()) {
			await copyFile(source, temporary, constants.COPYFILE_FICLONE);
			await chmod(temporary, Number(sourceInfo.mode) & 511);
		} else throw new Error(`unsupported checkpoint entry type: ${path}`);
		try {
			await rename(temporary, destination);
		} catch (error) {
			if (!["EEXIST", "EPERM"].includes(error.code ?? "")) throw error;
			await rm(destination, { force: true });
			await rename(temporary, destination);
		}
	} finally {
		await rm(temporary, { force: true });
	}
}
async function applyTree(root, targetTree, expectedTree) {
	const actualTree = await captureTree(root);
	if (actualTree !== expectedTree) throw new Error("workspace changed after the rewind preview; open the preview again");
	const changes = await changedFiles(root, targetTree, actualTree);
	const temporary = await mkdtemp(join(tmpdir(), "dsh-rewind-tree-"));
	const index = join(temporary, "index");
	const stage = join(temporary, "worktree");
	try {
		await mkdir(stage);
		const env = { GIT_INDEX_FILE: index };
		await runGit(root, ["read-tree", targetTree], env);
		await runGit(root, [
			"checkout-index",
			"--all",
			"--force",
			`--prefix=${stage}${sep}`
		], env);
		for (const change of changes) await replaceFromStage(root, stage, change.path);
	} finally {
		await rm(temporary, {
			recursive: true,
			force: true
		});
	}
	if (await captureTree(root) !== targetTree) throw new Error("workspace did not match the checkpoint after restore");
}
function promptText(messages) {
	const prompt = messages.find((message) => message.source.kind === "user");
	if (prompt === void 0) return void 0;
	const text = prompt.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
	return text.trim() === "" ? void 0 : text;
}
/** Bounded in-memory turn history backed by detached Git worktree trees. */
var WorkspaceCheckpointStore = class {
	historyLimit;
	checkpoints = /* @__PURE__ */ new Map();
	failures = /* @__PURE__ */ new Map();
	constructor(historyLimit) {
		this.historyLimit = historyLimit;
		if (!Number.isInteger(historyLimit) || historyLimit < 1) throw new Error("checkpoint history limit must be a positive integer");
	}
	/** Capture the current worktree before one user-authored turn enters its first step. */
	async capture(input) {
		const existing = this.checkpoints.get(input.sessionId) ?? [];
		if (existing.at(-1)?.turn === input.turn) return;
		const root = await repositoryRoot(input.cwd);
		const tree = await captureTree(root);
		const next = [...existing, {
			id: randomUUID(),
			...input,
			createdAt: Date.now(),
			root,
			tree,
			memoryMutations: []
		}];
		this.checkpoints.set(input.sessionId, next.slice(-this.historyLimit));
		this.failures.delete(input.sessionId);
	}
	/** Remember a non-fatal capture failure for the next rewind request. */
	fail(sessionId, error) {
		this.failures.set(sessionId, error instanceof Error ? error.message : String(error));
	}
	/** Return newest-last checkpoint rows without reading the live worktree. */
	list(sessionId) {
		return this.requireCheckpoints(sessionId).map((checkpoint) => ({
			checkpointId: checkpoint.id,
			sessionId,
			turn: checkpoint.turn,
			prompt: checkpoint.prompt,
			createdAt: checkpoint.createdAt,
			memoryUpdates: checkpoint.memoryMutations.length
		}));
	}
	/** Add per-turn changed-file counts after the list is already visible. */
	async describe(sessionId) {
		const checkpoints = this.requireCheckpoints(sessionId);
		const currentTrees = /* @__PURE__ */ new Map();
		return Promise.all(checkpoints.map(async (checkpoint, index) => {
			const next = checkpoints[index + 1];
			let turnEndTree;
			if (next?.root === checkpoint.root) turnEndTree = next.tree;
			else {
				let currentTree = currentTrees.get(checkpoint.root);
				if (currentTree === void 0) {
					currentTree = captureTree(checkpoint.root);
					currentTrees.set(checkpoint.root, currentTree);
				}
				turnEndTree = await currentTree;
			}
			const names = await runGit(checkpoint.root, [
				"diff",
				"--name-only",
				"-z",
				"--no-renames",
				checkpoint.tree,
				turnEndTree
			]);
			return {
				checkpointId: checkpoint.id,
				sessionId,
				turn: checkpoint.turn,
				prompt: checkpoint.prompt,
				createdAt: checkpoint.createdAt,
				turnChangedFiles: parseNulList(names).length,
				memoryUpdates: checkpoint.memoryMutations.length
			};
		}));
	}
	/** Compare the live worktree with one selected user-turn checkpoint. */
	async preview(sessionId, checkpointId) {
		const checkpoints = this.requireCheckpoints(sessionId);
		const checkpointIndex = checkpoints.findIndex((candidate) => candidate.id === checkpointId);
		const checkpoint = checkpoints[checkpointIndex];
		if (checkpoint === void 0) throw new Error("the selected rewind checkpoint is no longer available");
		const currentTree = await captureTree(checkpoint.root);
		return {
			checkpointId: checkpoint.id,
			sessionId,
			turn: checkpoint.turn,
			prompt: checkpoint.prompt,
			createdAt: checkpoint.createdAt,
			...checkpoint.previousTurnEndSeq === void 0 ? {} : { previousTurnEndSeq: checkpoint.previousTurnEndSeq },
			files: await changedFiles(checkpoint.root, checkpoint.tree, currentTree),
			currentTree,
			memoryMutations: checkpoints.slice(checkpointIndex).flatMap((candidate) => candidate.memoryMutations)
		};
	}
	/** Attach one memory mutation to the same user turn's unified checkpoint. */
	recordMemoryMutation(mutation) {
		if (mutation.sourceSessionId === void 0 || mutation.sourceTurn === void 0) return;
		const checkpoint = this.checkpoints.get(mutation.sourceSessionId)?.find((candidate) => candidate.turn === mutation.sourceTurn);
		if (checkpoint === void 0 || checkpoint.memoryMutations.some((candidate) => candidate.id === mutation.id)) return;
		checkpoint.memoryMutations.push(mutation);
	}
	/** Restore a confirmed preview and return a guarded rollback for later session-fork failure. */
	async restore(preview) {
		const checkpoint = this.checkpoints.get(preview.sessionId)?.find((candidate) => candidate.id === preview.checkpointId);
		if (checkpoint === void 0) throw new Error("the selected rewind checkpoint is no longer available");
		await applyTree(checkpoint.root, checkpoint.tree, preview.currentTree);
		return async () => applyTree(checkpoint.root, preview.currentTree, checkpoint.tree);
	}
	/** Move checkpoints before the restored turn onto the forked conversation. */
	continueFrom(preview, targetSessionId) {
		const checkpoints = this.checkpoints.get(preview.sessionId);
		const selectedIndex = checkpoints?.findIndex((checkpoint) => checkpoint.id === preview.checkpointId) ?? -1;
		if (selectedIndex === -1) throw new Error("the restored rewind checkpoint is no longer available");
		const ancestors = checkpoints?.slice(0, selectedIndex).map((checkpoint) => ({
			...checkpoint,
			sessionId: targetSessionId
		})) ?? [];
		this.checkpoints.delete(preview.sessionId);
		this.failures.delete(preview.sessionId);
		if (ancestors.length === 0) this.checkpoints.delete(targetSessionId);
		else this.checkpoints.set(targetSessionId, ancestors);
		this.failures.delete(targetSessionId);
	}
	requireCheckpoints(sessionId) {
		const checkpoints = this.checkpoints.get(sessionId);
		if (checkpoints !== void 0 && checkpoints.length > 0) return checkpoints;
		const failure = this.failures.get(sessionId);
		throw new Error(failure === void 0 ? "no rewind checkpoint is available for this session" : `the latest checkpoint capture failed: ${failure}`);
	}
};
/** Capture user turns through the documented pre-step waterfall without changing its decision. */
function installCheckpointCapture(ctx, store) {
	ctx.on("agent/pre-step", async ({ agent, messages, turn, step }, next) => {
		const prompt = step === 1 ? promptText(messages) : void 0;
		if (prompt !== void 0) {
			const previous = agent.session.events.findLast((event) => event.type === "turn/end" && event.data.turn < turn);
			try {
				await store.capture({
					sessionId: String(agent.session.id),
					turn,
					cwd: agent.session.header.cwd ?? process.cwd(),
					prompt,
					...previous === void 0 ? {} : { previousTurnEndSeq: previous.seq }
				});
			} catch (error) {
				store.fail(String(agent.session.id), error);
				ctx.logger.warn(`tui rewind checkpoint failed for session "${agent.session.id}": ${String(error)}`);
			}
		}
		return next();
	});
}
//#endregion
//#region src/config.ts
/** Loader schema for the public plugin configuration. */
const Config = z.object({
	historyMessages: z.natural().min(10).max(2e3).default(200),
	rewindCheckpoints: z.natural().min(2).max(100).default(20),
	maxToolOutputLines: z.natural().min(2).max(200).default(12),
	thinkingMaxLines: z.natural().min(3).max(30).default(8),
	showReasoning: z.boolean().default(true),
	showHardwareCursor: z.boolean().default(false),
	color: z.boolean().default(true),
	title: z.string().default("DeepSeek Harness"),
	cwd: z.string(),
	sessionId: z.string()
});
/** Resolve optional loader fields once at application startup. */
function resolveConfig(config) {
	return {
		historyMessages: config.historyMessages ?? 200,
		rewindCheckpoints: config.rewindCheckpoints ?? 20,
		maxToolOutputLines: config.maxToolOutputLines ?? 12,
		thinkingMaxLines: config.thinkingMaxLines ?? 8,
		showReasoning: config.showReasoning ?? true,
		showHardwareCursor: config.showHardwareCursor ?? false,
		color: config.color ?? true,
		title: config.title ?? "DeepSeek Harness",
		cwd: config.cwd ?? process.cwd(),
		...config.sessionId === void 0 ? {} : { sessionId: config.sessionId }
	};
}
//#endregion
//#region src/index.ts
/** Stable Cordis plugin name. */
const name = "community-tui";
/** The in-process API gateway must exist before the terminal can activate. */
const inject = [
	"apiProxy",
	"agents",
	"memory"
];
function parseArgs(args, base) {
	const config = { ...base };
	let help = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--help" || argument === "-h") {
			help = true;
			continue;
		}
		if (argument === "--resume") {
			const value = args[index + 1];
			if (value === void 0) throw new Error("--resume requires a session id");
			config.sessionId = value;
			index += 1;
			continue;
		}
		if (argument === "--cwd") {
			const value = args[index + 1];
			if (value === void 0) throw new Error("--cwd requires a path");
			config.cwd = value;
			index += 1;
			continue;
		}
		if (argument === "--no-color") {
			config.color = false;
			continue;
		}
		throw new Error(`unknown TUI option: ${argument}`);
	}
	return {
		help,
		config
	};
}
const HELP = `Usage: dsh --profile tui [options]

Options:
  --resume <session-id>  Resume an existing session
  --cwd <path>           Start a new session in this directory
  --no-color             Disable ANSI color
  -h, --help             Show this help
`;
/** Mount the terminal application and bind its lifetime to the plugin effect. */
function apply(ctx, config) {
	const exit = ctx.get("appExit");
	if (exit === void 0) throw new Error("community-tui requires the dsh launcher appExit service");
	const parsed = parseArgs(ctx.get("cmdlineArgs")?.get() ?? [], config);
	if (parsed.help) {
		process.stdout.write(HELP);
		exit(0);
		return;
	}
	const runtime = {
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: process.stderr,
		exit
	};
	const api = new InProcessApiClient(toFetchHandler(ctx.apiProxy));
	const resolved = resolveConfig(parsed.config);
	const checkpoints = new WorkspaceCheckpointStore(resolved.rewindCheckpoints);
	installCheckpointCapture(ctx, checkpoints);
	const app = new TuiApplication(api, resolved, runtime, checkpoints, ctx.memory);
	ctx.effect(() => {
		let active = true;
		const removeMemoryMutation = ctx.memory.onMutation((mutation) => {
			checkpoints.recordMemoryMutation(mutation);
		});
		(async () => {
			await ctx.get("loader")?.await();
			if (!active) return;
			await app.start();
		})().catch((error) => {
			if (!active) return;
			runtime.stderr.write(`dsh tui: ${error instanceof Error ? error.message : String(error)}\n`);
			app.dispose().finally(() => exit(1));
		});
		return async () => {
			active = false;
			removeMemoryMutation();
			await app.dispose();
		};
	});
}
//#endregion
export { Config, HarnessController, TranscriptComponent, apply, inject, name, resolveConfig, sanitizeTerminalText };

//# sourceMappingURL=index.js.map