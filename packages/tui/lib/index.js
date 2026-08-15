import { InProcessApiClient, toFetchHandler } from "@deepseek-ai/dsh-host-apiproxy";
import { CombinedAutocompleteProvider, Container, Editor, Key, Markdown, ProcessTerminal, SelectList, Text, TuiMainScreen, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, rmdir, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { highlight, supportsLanguage } from "cli-highlight";
import { diffLines } from "diff";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
//#region src/runtime/submission.ts
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
		this.settle(key);
	}
	/** Retire input settled without a durable user-message event, such as a command. */
	settle(key) {
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
//#region src/runtime/controller.ts
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
			historyHasMore: false,
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
	/** Prepend one older, message-aligned history page without disturbing live tail events. */
	async loadEarlierHistory() {
		const sessionId = this.requireSession();
		const generation = this.generation;
		const beforeSeq = this.state.events.at(0)?.event.seq;
		if (!this.state.historyHasMore || beforeSeq === void 0) return false;
		const page = valueOf(await this.api.sessions.history({
			sessionId,
			beforeSeq,
			maxMessages: this.historyMessages
		}));
		if (generation !== this.generation || sessionId !== this.state.sessionId) return false;
		const present = new Set(this.state.events.map((entry) => entry.event.seq));
		const earlier = page.events.filter((entry) => !present.has(entry.event.seq));
		this.patch({
			events: [...earlier, ...this.state.events],
			historyHasMore: page.hasMore,
			error: void 0
		});
		return earlier.length > 0;
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
		if (response.result.value.command !== void 0) {
			this.submissions.settle(pending.key);
			this.patch({ pendingSubmissions: this.submissions.snapshot });
			return;
		}
		this.submissions.accept(pending.key, response.rpcId);
		this.patch({ pendingSubmissions: this.submissions.snapshot });
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
				historyHasMore: page.hasMore,
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
			historyHasMore: false,
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
//#region src/presentation/dialogs.ts
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
//#region src/presentation/theme.ts
function ansi(enabled, open, close) {
	return enabled ? (text) => `\u001b[${open}m${text}\u001b[${close}m` : (text) => text;
}
function ansiSequence(enabled, open, close) {
	return enabled ? (text) => `\u001b[${open}m${text}\u001b[${close}m` : (text) => text;
}
/** Build the complete color-disabled or standard-ANSI theme. */
function createTheme(enabled) {
	const accent = ansi(enabled, 36, 39);
	const bold = ansi(enabled, 1, 22);
	const dim = ansi(enabled, 2, 22);
	const diffAdded = ansiSequence(enabled, "48;2;12;48;28", "49");
	const diffRemoved = ansiSequence(enabled, "48;2;58;23;31", "49");
	const error = ansi(enabled, 31, 39);
	const reasoning = ansiSequence(enabled, "38;2;148;163;184", "39");
	const success = ansi(enabled, 32, 39);
	const tool = ansiSequence(enabled, "38;2;125;211;252", "39");
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
		bold,
		dim,
		diffAdded,
		diffRemoved,
		error,
		hover,
		reasoning,
		success,
		tool,
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
			heading: (text) => /^#{3,6} $/u.test(stripTerminalSequences(text)) ? "" : bold(accent(text)),
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
//#region src/presentation/stats.ts
/** Compact token count using the same thresholds as the Harness Web composer. */
function formatTokens(value) {
	const scaled = (number) => number >= 100 ? String(Math.round(number)) : String(Math.round(number * 10) / 10);
	if (value < 1e3) return String(value);
	if (value < 1e6) return `${scaled(value / 1e3)}K`;
	return `${scaled(value / 1e6)}M`;
}
/** Compact duration using the same rounding as the Harness Web composer. */
function formatDuration$1(milliseconds) {
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
	if (stats.llmMs > 0) durations.push(`LLM ${formatDuration$1(stats.llmMs)}`);
	if (stats.toolMs > 0) durations.push(`Tool call ${formatDuration$1(stats.toolMs)}`);
	if (durations.length > 0) groups.push(durations.join(" · "));
	const speeds = [];
	if (stats.ttftSteps > 0) speeds.push(`TTFT avg ${formatDuration$1(stats.ttftMs / stats.ttftSteps)}`);
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
//#region src/presentation/diff-location.ts
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
//#region src/presentation/diff.ts
/** Presentation-only projection for Harness file-diff render intent. */
const CONTEXT_RADIUS = 2;
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
function compactContext(lines, path) {
	const changed = lines.map((line, index) => line.kind === "add" || line.kind === "del" ? index : -1).filter((index) => index >= 0);
	if (changed.length === 0) return [...lines];
	const visible = /* @__PURE__ */ new Set();
	for (const index of changed) {
		const first = Math.max(0, index - CONTEXT_RADIUS);
		const last = Math.min(lines.length - 1, index + CONTEXT_RADIUS);
		for (let cursor = first; cursor <= last; cursor += 1) visible.add(cursor);
	}
	const compacted = [];
	let omitted = false;
	for (const [index, line] of lines.entries()) {
		if (!visible.has(index)) {
			omitted = true;
			continue;
		}
		if (omitted) compacted.push({
			kind: "gap",
			path,
			text: "⋯"
		});
		compacted.push(line);
		omitted = false;
	}
	if (omitted) compacted.push({
		kind: "gap",
		path,
		text: "⋯"
	});
	return compacted;
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
	const hunkLines = [];
	for (const change of diffLines(diff.oldText, diff.newText, { ignoreNewlineAtEof: true })) for (const text of contentLines(change.value)) if (change.removed === true) {
		hunkLines.push({
			kind: "del",
			path: diff.path,
			text,
			number: oldNumber
		});
		if (oldNumber !== void 0) oldNumber += 1;
		removed += 1;
	} else if (change.added === true) {
		hunkLines.push({
			kind: "add",
			path: diff.path,
			text,
			number: newNumber
		});
		if (newNumber !== void 0) newNumber += 1;
		added += 1;
	} else {
		hunkLines.push({
			kind: "context",
			path: diff.path,
			text,
			number: newNumber
		});
		if (oldNumber !== void 0) oldNumber += 1;
		if (newNumber !== void 0) newNumber += 1;
	}
	lines.push(...compactContext(hunkLines, diff.path));
	return {
		added,
		removed
	};
}
/** Build changed rows while folding unchanged context far from each edit. */
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
//#region src/presentation/transcript.ts
const DIFF_CONTENT_INDENT = "  ";
const DISCLOSURE_COLLAPSED = "›";
const DISCLOSURE_EXPANDED = "⌄";
function stepKey$3(turn, step) {
	return `${turn}:${step}`;
}
function messageText$1(content, reasoning) {
	return content.filter((block) => block.type === "text" || reasoning && block.type === "reasoning").map((block) => block.type === "reasoning" ? `> ${block.text ?? ""}` : block.text ?? "").join("\n");
}
function reasoningText(content) {
	return content.filter((block) => block.type === "reasoning").map((block) => block.text ?? "").join("\n");
}
function callTitle$1(name, view) {
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
function padToWidth(value, width) {
	const clipped = truncateToWidth(value, width, "…", true);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}
function toolArguments(value, limit) {
	const clean = sanitizeTerminalText(value).trim();
	if (clean === "") return void 0;
	try {
		const parsed = JSON.parse(clean);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && Object.keys(parsed).length === 0) return;
		return boundedLines(displayUnknown(parsed), limit);
	} catch {
		return boundedLines(clean, limit);
	}
}
function rawResultText(entry) {
	if (entry.event.type !== "tool/result") return "";
	const result = entry.event.data.message.content[0];
	if (result?.type !== "tool-result") return "";
	return messageText$1(result.content, true);
}
function resultTitle$1(view) {
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
		case "generic": return boundedLines(view.content === void 0 ? fallback : messageText$1(view.content, true), limit);
	}
}
function rowsFromState(state, theme, showReasoning, showDetails, maxToolOutputLines) {
	const rows = [];
	const finalSteps = /* @__PURE__ */ new Set();
	const results = /* @__PURE__ */ new Map();
	const commandRuns = /* @__PURE__ */ new Set();
	const commandResults = /* @__PURE__ */ new Map();
	for (const entry of state.events) {
		const event = entry.event;
		if (event.type === "assistant/message") finalSteps.add(stepKey$3(event.data.turn, event.data.step));
		if (event.type === "tool/result") results.set(String(event.data.message.source.callId), entry);
		if (event.type === "command/run") commandRuns.add(String(event.data.commandId));
		if (event.type === "command/done") commandResults.set(String(event.data.commandId), entry);
	}
	const partials = /* @__PURE__ */ new Map();
	for (const entry of state.events) {
		const event = entry.event;
		switch (event.type) {
			case "user/message": {
				if (event.surfaceOp !== "append") break;
				const human = event.data.source.kind === "user";
				if (!human && !showDetails) break;
				const text = messageText$1(event.data.content, showReasoning);
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
				const key = stepKey$3(event.data.turn, event.data.step);
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
					key: `${stepKey$3(event.data.turn, event.data.step)}:thinking`,
					text: reasoning,
					streaming: false
				} });
				const text = messageText$1(event.data.message.content, false);
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
				const title = resultTitle$1(resultView) ?? callTitle$1(event.data.name, callView);
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
				const argumentsBody = toolArguments(event.data.arguments, maxToolOutputLines);
				rows.push({ tool: {
					key: `${String(event.data.callId)}:tool`,
					title: sanitizeTerminalText(title),
					status: result === void 0 ? "pending" : failed ? "failed" : "completed",
					...argumentsBody === void 0 ? {} : { arguments: argumentsBody },
					...result === void 0 ? {} : { result: resultBody(resultView, rawResultText(result), maxToolOutputLines) }
				} });
				break;
			}
			case "command/run": {
				const completed = commandResults.get(String(event.data.commandId));
				const result = completed?.event.type === "command/done" ? completed.event.data : void 0;
				const failed = result?.kind === "error";
				rows.push({
					label: failed ? "Command failed" : result === void 0 ? "Command running" : "Command",
					labelPaint: failed ? theme.error : result === void 0 ? theme.warning : theme.accent,
					body: [`/${event.data.name}${event.data.args ?? ""}`, result?.text].filter((value) => value !== void 0 && value !== "").join("\n")
				});
				break;
			}
			case "command/done":
				if (!commandRuns.has(String(event.data.commandId))) rows.push({
					label: event.data.kind === "error" ? "Command failed" : "Command",
					labelPaint: event.data.kind === "error" ? theme.error : theme.accent,
					body: event.data.text ?? `${event.data.kind} command completion`
				});
				break;
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
		const body = messageText$1(item.message.content, false);
		if (body.trim() === "") continue;
		const source = item.message.source;
		if (source.kind === "user" && "rpcId" in source) visibleQueueRpcIds.add(String(source.rpcId));
		rows.push({
			prompt: true,
			body,
			promptStatus: item.placement === "steering" ? "Steering next step…" : "Queued"
		});
	}
	for (const submission of state.pendingSubmissions) {
		if (submission.rpcId !== void 0 && visibleQueueRpcIds.has(String(submission.rpcId))) continue;
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
	toolExpansion = /* @__PURE__ */ new Map();
	collapsedDiffs = /* @__PURE__ */ new Set();
	followingThinking = /* @__PURE__ */ new Set();
	blockOffsets = /* @__PURE__ */ new Map();
	blockMaxOffsets = /* @__PURE__ */ new Map();
	blockHits = [];
	hoveredBlockKey;
	diffLineStarts = /* @__PURE__ */ new Map();
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
			this.toolExpansion.clear();
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
		this.toolExpansion.clear();
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
			} else if (hit.kind === "tool") this.toolExpansion.set(hit.key, !this.isToolExpanded(hit.key));
			else if (!this.collapsedDiffs.delete(hit.key)) {
				this.collapsedDiffs.add(hit.key);
				this.blockOffsets.delete(hit.key);
			}
			return true;
		}
		if (hit === void 0 || hit.kind === "tool" || hit.kind === "thinking" && !this.expandedThinking.has(hit.key) || hit.kind === "diff" && this.collapsedDiffs.has(hit.key)) return false;
		return this.scrollBlock(hit.key, action === "wheel-up" ? -3 : 3, hit.kind === "thinking");
	}
	render(width) {
		const safeWidth = Math.max(1, width);
		const lines = [];
		const rows = rowsFromState(this.state, this.theme, this.showReasoning, this.showDetails, this.maxToolOutputLines);
		this.blockHits = [];
		for (const [index, row] of rows.entries()) {
			if (index > 0) lines.push("");
			if (row.thinking !== void 0) {
				const contentWidth = this.contentWidth(safeWidth);
				this.pushBlock(lines, this.frameContent(this.renderThinking(row.thinking, contentWidth), safeWidth), row.thinking.key, "thinking");
				continue;
			}
			if (row.tool !== void 0) {
				const contentWidth = this.contentWidth(safeWidth);
				this.pushBlock(lines, this.frameContent(this.renderTool(row.tool, contentWidth), safeWidth), row.tool.key, "tool");
				continue;
			}
			if (row.diff !== void 0) {
				const contentWidth = this.contentWidth(safeWidth);
				this.pushBlock(lines, this.frameContent(this.renderDiff(row.diff, contentWidth), safeWidth), row.diff.key, "diff");
				continue;
			}
			if (row.prompt && row.body !== void 0) {
				lines.push(...this.renderPromptBlock(row.body, row.promptStatus, safeWidth));
				continue;
			}
			const contentWidth = this.contentWidth(safeWidth);
			const contentLines = [];
			if (row.label !== void 0) contentLines.push(truncateToWidth((row.labelPaint ?? ((text) => text))(row.label), contentWidth));
			if (row.body !== void 0 && row.body !== "") {
				const body = sanitizeTerminalText(row.body);
				if (row.markdown) {
					const markdown = new Markdown(body, 0, 0, this.theme.markdown, row.dim ? { color: this.theme.dim } : void 0);
					contentLines.push(...markdown.render(contentWidth));
				} else {
					const styled = row.dim ? this.theme.dim(body) : body;
					contentLines.push(...wrapTextWithAnsi(styled, contentWidth));
				}
			}
			lines.push(...this.frameContent(contentLines, safeWidth));
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
	contentWidth(width) {
		return Math.max(1, width - (width >= 24 ? 2 : 0));
	}
	frameContent(lines, width) {
		const gutter = width >= 24 ? 1 : 0;
		if (gutter === 0) return lines;
		const contentWidth = this.contentWidth(width);
		return lines.map((line) => {
			const content = truncateToWidth(line, contentWidth, "…");
			const right = " ".repeat(Math.max(gutter, width - gutter - visibleWidth(content)));
			return `${" ".repeat(gutter)}${content}${right}`;
		});
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
		const marker = expanded ? DISCLOSURE_EXPANDED : DISCLOSURE_COLLAPSED;
		const label = thinking.streaming ? "Thinking…" : "Thought";
		if (!expanded) return [this.renderBlockTitle(`${marker} ${label}`, thinking.key, width, this.theme.reasoning)];
		const contentWidth = Math.max(1, width - 2);
		const content = new Markdown(sanitizeTerminalText(thinking.text), 0, 0, this.theme.markdown, { color: this.theme.reasoning }).render(contentWidth);
		const { offset, maxOffset } = this.resolveBlockOffset(thinking.key, content.length, this.thinkingMaxLines, thinking.streaming && this.followingThinking.has(thinking.key));
		const visible = content.slice(offset, offset + this.thinkingMaxLines);
		const range = maxOffset === 0 ? "" : ` · ${offset + 1}-${Math.min(content.length, offset + this.thinkingMaxLines)}/${content.length}`;
		return [this.renderBlockTitle(`${marker} ${label}${range}`, thinking.key, width, this.theme.reasoning), ...visible.map((line) => truncateToWidth(`${this.theme.reasoning("│")} ${line}`, width))];
	}
	renderTool(tool, width) {
		const expanded = this.isToolExpanded(tool.key);
		const marker = expanded ? DISCLOSURE_EXPANDED : DISCLOSURE_COLLAPSED;
		const glyph = tool.status === "pending" ? "○" : tool.status === "failed" ? "×" : "•";
		const paint = tool.status === "pending" ? this.theme.warning : tool.status === "failed" ? this.theme.error : this.theme.success;
		const renderedGlyph = tool.status === "completed" ? this.theme.bold(paint(glyph)) : paint(glyph);
		const title = `${marker} ${glyph} ${tool.title}`;
		const renderedTitle = this.hoveredBlockKey === tool.key ? this.theme.hover(truncateToWidth(title, width, "…")) : truncateToWidth(`${this.theme.dim(`${marker} `)}${renderedGlyph} ${this.theme.tool(tool.title)}`, width, "…");
		if (!expanded) return [renderedTitle];
		const sections = [...tool.arguments === void 0 ? [] : [{
			label: "Arguments",
			value: tool.arguments
		}], ...tool.result === void 0 || tool.result === "" ? [] : [{
			label: "Result",
			value: tool.result
		}]];
		if (sections.length === 0) return [renderedTitle, truncateToWidth(`  ${this.theme.reasoning("No details recorded yet.")}`, width)];
		return [renderedTitle, ...sections.flatMap((section, index) => [
			...index === 0 ? [] : [""],
			truncateToWidth(`  ${this.theme.dim(section.label)}`, width),
			...sanitizeTerminalText(section.value).split("\n").flatMap((line) => {
				const wrapped = wrapTextWithAnsi(line, Math.max(1, width - 4));
				return (wrapped.length === 0 ? [""] : wrapped).map((part) => truncateToWidth(`  ${this.theme.reasoning("│")} ${this.theme.reasoning(part)}`, width, "…"));
			})
		])];
	}
	isToolExpanded(key) {
		return this.toolExpansion.get(key) ?? this.showDetails;
	}
	renderDiff(diff, width) {
		const model = buildDiffDisplay(diff.title, diff.diffs, this.diffLineStarts.get(diff.key) ?? []);
		const collapsed = this.collapsedDiffs.has(diff.key);
		const title = this.renderDiffTitle(model.operation, model.target, diff.settled, collapsed, diff.key, width);
		if (collapsed) return [title];
		const { offset } = this.resolveBlockOffset(diff.key, model.lines.length, this.maxToolOutputLines, false);
		const visible = model.lines.slice(offset, offset + this.maxToolOutputLines);
		const numberWidth = Math.max(2, ...model.lines.map((line) => String(line.number ?? "").length));
		const contentWidth = Math.max(1, width - 2);
		return [
			title,
			truncateToWidth(this.theme.reasoning(`${DIFF_CONTENT_INDENT}└ ${diffSummary(model.added, model.removed)}`), width),
			...visible.flatMap((line) => this.renderDiffLine(line, contentWidth, numberWidth).map((rendered) => `${DIFF_CONTENT_INDENT}${rendered}`))
		];
	}
	renderDiffTitle(operation, target, settled, collapsed, key, width) {
		const marker = `${collapsed ? DISCLOSURE_COLLAPSED : DISCLOSURE_EXPANDED} `;
		const cleanOperation = sanitizeTerminalText(operation);
		const cleanTarget = sanitizeTerminalText(target);
		const status = settled ? "•" : "○";
		const plain = `${marker}${status} ${cleanOperation}(${cleanTarget})`;
		if (this.hoveredBlockKey === key) return this.theme.hover(truncateToWidth(plain, width, "…"));
		return truncateToWidth([
			marker,
			settled ? this.theme.bold(this.theme.success(status)) : this.theme.warning(status),
			` ${this.theme.tool(cleanOperation)}(`,
			this.theme.underline(cleanTarget),
			")"
		].join(""), width, "…");
	}
	renderDiffLine(line, width, numberWidth) {
		switch (line.kind) {
			case "file": return [truncateToWidth(this.theme.bold(sanitizeTerminalText(line.text)), width)];
			case "gap": return [truncateToWidth(this.theme.dim("⋯"), width)];
			case "context": {
				const gutterWidth = numberWidth + 3;
				const firstPrefix = this.theme.dim(`${String(line.number ?? "").padStart(numberWidth)}   `);
				const continuationPrefix = " ".repeat(gutterWidth);
				const code = this.theme.reasoning(sanitizeTerminalText(line.text));
				const wrapped = wrapTextWithAnsi(code, Math.max(1, width - gutterWidth));
				return (wrapped.length === 0 ? [""] : wrapped).map((part, index) => truncateToWidth(`${index === 0 ? firstPrefix : continuationPrefix}${part}`, width, "…"));
			}
			case "del": {
				const gutterWidth = numberWidth + 3;
				const firstPrefix = this.theme.error(`${String(line.number ?? "").padStart(numberWidth)} - `);
				const continuationPrefix = " ".repeat(gutterWidth);
				const code = highlightDiffText(sanitizeTerminalText(line.text), line.path, this.theme);
				const wrapped = wrapTextWithAnsi(code, Math.max(1, width - gutterWidth));
				return (wrapped.length === 0 ? [""] : wrapped).map((part, index) => this.theme.diffRemoved(padToWidth(`${index === 0 ? firstPrefix : continuationPrefix}${part}`, width)));
			}
			case "add": {
				const gutterWidth = numberWidth + 3;
				const firstPrefix = this.theme.success(`${String(line.number ?? "").padStart(numberWidth)} + `);
				const continuationPrefix = " ".repeat(gutterWidth);
				const code = highlightDiffText(sanitizeTerminalText(line.text), line.path, this.theme);
				const wrapped = wrapTextWithAnsi(code, Math.max(1, width - gutterWidth));
				return (wrapped.length === 0 ? [""] : wrapped).map((part, index) => this.theme.diffAdded(padToWidth(`${index === 0 ? firstPrefix : continuationPrefix}${part}`, width)));
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
//#region src/presentation/layout.ts
/** Composer-anchored layout primitives for the terminal presentation layer. */
/** Main-screen layout with a fixed composer and a scrollable conversation viewport. */
var ComposerAnchoredLayout = class extends Container {
	header;
	transcript;
	status;
	editor;
	footer;
	viewportRows;
	composerOverride;
	conversationTop;
	renderedTranscriptTop = 0;
	renderedTranscriptRows = 0;
	renderedTranscriptScreenRow = 0;
	maxConversationTop = 0;
	conversationPageRows = 1;
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
		return this.conversationTop === void 0;
	}
	render(width) {
		const header = this.header.render(width);
		const transcript = this.transcript.render(width);
		const composer = this.renderComposer(width);
		const transcriptStart = header.length + 1;
		const conversation = [
			...header,
			"",
			...transcript
		];
		const viewportRows = Math.max(0, this.viewportRows());
		const composerGapRows = this.composerOverride === void 0 && viewportRows > composer.length ? 1 : 0;
		const availableRows = Math.max(0, viewportRows - composer.length - composerGapRows);
		this.conversationPageRows = Math.max(1, availableRows);
		this.maxConversationTop = Math.max(0, conversation.length - availableRows);
		const requestedTop = this.conversationTop ?? this.maxConversationTop;
		const top = Math.max(0, Math.min(this.maxConversationTop, requestedTop));
		if (this.conversationTop !== void 0 && top === this.maxConversationTop) this.conversationTop = void 0;
		const visible = conversation.slice(top, top + availableRows);
		const visibleTranscriptStart = Math.max(top, transcriptStart);
		const visibleTranscriptEnd = Math.min(top + visible.length, conversation.length);
		this.renderedTranscriptTop = Math.max(0, visibleTranscriptStart - transcriptStart);
		this.renderedTranscriptRows = Math.max(0, visibleTranscriptEnd - visibleTranscriptStart);
		this.renderedTranscriptScreenRow = visibleTranscriptStart - top;
		const gap = Math.max(0, availableRows - visible.length);
		return [
			...visible,
			...Array(gap + composerGapRows).fill(""),
			...composer
		];
	}
	/** Replace the editor area with an inline modal surface, or restore the editor. */
	setComposerOverride(component) {
		if (this.composerOverride !== void 0) this.removeChild(this.composerOverride);
		this.composerOverride = component;
		if (component !== void 0) this.addChild(component);
	}
	/** Move the conversation viewport by rendered lines; positive values move toward newer output. */
	scrollTranscript(delta) {
		const current = this.conversationTop ?? this.maxConversationTop;
		const next = Math.max(0, Math.min(this.maxConversationTop, current + delta));
		const normalized = next === this.maxConversationTop ? void 0 : next;
		if (normalized === this.conversationTop) return false;
		this.conversationTop = normalized;
		return true;
	}
	/** Move one conversation page while keeping one context line visible. */
	pageTranscript(direction) {
		return this.scrollTranscript(direction * Math.max(1, this.conversationPageRows - 1));
	}
	/** Resume automatic tail following after viewing older output. */
	followTranscript() {
		if (this.conversationTop === void 0) return false;
		this.conversationTop = void 0;
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
//#region src/trajectory/model.ts
function stepKey$2(turn, step) {
	return `${String(turn)}:${String(step)}`;
}
function effectiveDuration(record, now) {
	if (record.completedAt !== void 0) return Math.max(0, record.completedAt - record.startedAt);
	return record.status === "pending" ? Math.max(0, now - record.startedAt) : void 0;
}
/**
* Immutable relationship index for one trace snapshot. Parent lookup is O(1),
* and a complete timing measurement is O(n) even for long paged sessions.
*/
var TrajectoryModel = class {
	records;
	parents = /* @__PURE__ */ new Map();
	constructor(records) {
		this.records = records;
		const turns = /* @__PURE__ */ new Map();
		const steps = /* @__PURE__ */ new Map();
		for (const record of records) {
			if (record.kind === "turn" && record.turn !== void 0) turns.set(record.turn, record);
			if (record.kind === "step" && record.turn !== void 0 && record.step !== void 0) steps.set(stepKey$2(record.turn, record.step), record);
		}
		for (const record of records) {
			if (record.kind === "turn" || record.turn === void 0) continue;
			const parent = record.kind === "step" ? turns.get(record.turn) : record.step === void 0 ? turns.get(record.turn) : steps.get(stepKey$2(record.turn, record.step)) ?? turns.get(record.turn);
			if (parent !== void 0) this.parents.set(record.key, parent);
		}
	}
	parentOf(record) {
		return this.parents.get(record.key);
	}
	measure(now) {
		const metrics = /* @__PURE__ */ new Map();
		const firstStart = this.records.reduce((minimum, record) => Math.min(minimum, record.startedAt), Number.POSITIVE_INFINITY);
		const turnStarts = /* @__PURE__ */ new Map();
		const groups = /* @__PURE__ */ new Map();
		for (const record of this.records) if (record.kind === "turn" && record.turn !== void 0) turnStarts.set(record.turn, record.startedAt);
		for (const record of this.records) {
			const parent = this.parentOf(record);
			const durationMs = effectiveDuration(record, now);
			const parentDurationMs = parent === void 0 ? void 0 : effectiveDuration(parent, now);
			const baseline = record.turn === void 0 ? Number.isFinite(firstStart) ? firstStart : record.startedAt : turnStarts.get(record.turn) ?? (Number.isFinite(firstStart) ? firstStart : record.startedAt);
			metrics.set(record.key, {
				...durationMs === void 0 ? {} : { durationMs },
				offsetMs: Math.max(0, record.startedAt - baseline),
				...durationMs === void 0 || parentDurationMs === void 0 || parentDurationMs <= 0 ? {} : { shareOfParent: Math.max(0, Math.min(1, durationMs / parentDurationMs)) },
				slowest: false,
				...parent === void 0 ? {} : { parentTitle: parent.title }
			});
			if (record.kind === "turn" || durationMs === void 0) continue;
			const group = parent?.key ?? "root";
			const siblings = groups.get(group) ?? [];
			siblings.push({
				record,
				durationMs
			});
			groups.set(group, siblings);
		}
		for (const siblings of groups.values()) {
			const slowest = siblings.reduce((current, candidate) => candidate.durationMs > current.durationMs ? candidate : current);
			const metric = metrics.get(slowest.record.key);
			if (metric !== void 0) metric.slowest = true;
		}
		const timedLeaves = this.records.filter((record) => record.kind !== "turn" && record.kind !== "step" && metrics.get(record.key)?.durationMs !== void 0);
		return {
			metrics,
			bottleneck: (timedLeaves.length === 0 ? this.records.filter((record) => record.kind === "step" && metrics.get(record.key)?.durationMs !== void 0) : timedLeaves).reduce((slowest, candidate) => {
				if (slowest === void 0) return candidate;
				return (metrics.get(candidate.key)?.durationMs ?? 0) > (metrics.get(slowest.key)?.durationMs ?? 0) ? candidate : slowest;
			}, void 0)
		};
	}
};
//#endregion
//#region src/trajectory/records.ts
function recordValue(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function numericField(value, field) {
	const candidate = recordValue(value)?.[field];
	return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : void 0;
}
function position(entry) {
	const turn = numericField(entry.event.data, "turn");
	const step = numericField(entry.event.data, "step");
	return {
		...turn === void 0 ? {} : { turn },
		...step === void 0 ? {} : { step }
	};
}
function locatedPosition(entry, activeTurn, activeStep) {
	const explicit = position(entry);
	const turn = explicit.turn ?? activeTurn;
	const step = explicit.step ?? activeStep;
	return {
		...turn === void 0 ? {} : { turn },
		...step === void 0 ? {} : { step }
	};
}
function stepKey$1(turn, step) {
	return `${String(turn)}:${String(step)}`;
}
function contentText(value) {
	if (!Array.isArray(value)) return "";
	const parts = [];
	for (const item of value) {
		const block = recordValue(item);
		if (block === void 0) continue;
		if (typeof block.text === "string") parts.push(block.text);
		if (Array.isArray(block.content)) {
			const nested = contentText(block.content);
			if (nested !== "") parts.push(nested);
		}
	}
	return parts.join("\n");
}
function messageText(value) {
	return contentText(recordValue(value)?.content);
}
function oneLine(value, maximum = 140) {
	const normalized = sanitizeTerminalText(value).replaceAll(/\s+/gu, " ").trim();
	if (normalized.length <= maximum) return normalized;
	return `${normalized.slice(0, Math.max(1, maximum - 1))}…`;
}
function parsedJson(value) {
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}
function resultTitle(entry) {
	if (entry?.view?.for !== "result") return void 0;
	return entry.view.view.title;
}
function callTitle(entry) {
	if (entry.view?.for !== "call") return void 0;
	return entry.view.view.title;
}
function turnStatus(reason) {
	const kind = recordValue(reason)?.kind;
	if (kind === "completed") return "completed";
	if (kind === "error") return "failed";
	return "warning";
}
function resultFailed(entry) {
	if (entry.event.type !== "tool/result") return false;
	const block = entry.event.data.message.content[0];
	return entry.event.data.error !== void 0 || block?.isError === true;
}
function toolResult(entry) {
	if (entry.event.type !== "tool/result") return void 0;
	const text = messageText(entry.event.data.message);
	if (entry.event.data.error === void 0) return text === "" ? entry.event.data.message.content : text;
	return {
		error: entry.event.data.error,
		...text === "" ? { content: entry.event.data.message.content } : { content: text }
	};
}
function toolSchemaMap(entry) {
	if (entry.event.type !== "request/header") return void 0;
	const schemas = /* @__PURE__ */ new Map();
	for (const tool of entry.event.data.header.tools ?? []) schemas.set(tool.name, tool);
	return schemas;
}
/** Pair lifecycle boundaries and tool call/results into an ordered diagnostic ledger. */
function buildTrajectoryRecords(entries) {
	const turnEnds = /* @__PURE__ */ new Map();
	const stepEnds = /* @__PURE__ */ new Map();
	const stepStarts = /* @__PURE__ */ new Map();
	const toolResults = /* @__PURE__ */ new Map();
	const commandRuns = /* @__PURE__ */ new Set();
	const commandResults = /* @__PURE__ */ new Map();
	for (const entry of entries) {
		const event = entry.event;
		if (event.type === "turn/end") turnEnds.set(event.data.turn, entry);
		if (event.type === "step/start") stepStarts.set(stepKey$1(event.data.turn, event.data.step), entry);
		if (event.type === "step/end") stepEnds.set(stepKey$1(event.data.turn, event.data.step), entry);
		if (event.type === "tool/result") toolResults.set(String(event.data.message.source.callId), entry);
		if (event.type === "command/run") commandRuns.add(String(event.data.commandId));
		if (event.type === "command/done") commandResults.set(String(event.data.commandId), entry);
	}
	let schemas = /* @__PURE__ */ new Map();
	let activeTurn;
	let activeStep;
	const records = [];
	for (const entry of entries) {
		const event = entry.event;
		if (event.type === "turn/start") activeTurn = event.data.turn;
		if (event.type === "step/start") activeStep = event.data.step;
		const at = locatedPosition(entry, activeTurn, activeStep);
		const schemaSnapshot = toolSchemaMap(entry);
		if (schemaSnapshot !== void 0) schemas = schemaSnapshot;
		switch (event.type) {
			case "assistant/chunk":
			case "turn/end":
			case "step/end":
			case "tool/result": break;
			case "command/done": {
				if (commandRuns.has(String(event.data.commandId))) break;
				const detail = event.data.text ?? `${event.data.kind} command completion`;
				records.push({
					key: `command:${String(event.data.commandId)}:${String(event.seq)}`,
					kind: "command",
					type: event.type,
					seq: event.seq,
					title: "Command completion",
					summary: oneLine(detail),
					detail,
					status: event.data.kind === "error" ? "failed" : "completed",
					startedAt: event.time,
					result: event.data
				});
				break;
			}
			case "turn/start": {
				const completed = turnEnds.get(event.data.turn);
				const reason = completed?.event.type === "turn/end" ? completed.event.data.reason : void 0;
				const reasonKind = recordValue(reason)?.kind;
				records.push({
					key: `turn:${String(event.data.turn)}:${String(event.seq)}`,
					kind: "turn",
					type: event.type,
					...completed === void 0 ? {} : {
						completionType: completed.event.type,
						completionSeq: completed.event.seq
					},
					seq: event.seq,
					turn: event.data.turn,
					title: `Turn ${String(event.data.turn)}`,
					summary: completed === void 0 ? "Running" : `Finished · ${typeof reasonKind === "string" ? reasonKind : "completed"}`,
					status: completed === void 0 ? "pending" : turnStatus(reason),
					startedAt: event.time,
					...completed === void 0 ? {} : {
						completedAt: completed.event.time,
						result: reason
					},
					payload: event.data
				});
				break;
			}
			case "step/start": {
				const completed = stepEnds.get(stepKey$1(event.data.turn, event.data.step));
				records.push({
					key: `step:${String(event.data.turn)}:${String(event.data.step)}:${String(event.seq)}`,
					kind: "step",
					type: event.type,
					...completed === void 0 ? {} : {
						completionType: completed.event.type,
						completionSeq: completed.event.seq
					},
					seq: event.seq,
					turn: event.data.turn,
					step: event.data.step,
					title: `Step ${String(event.data.step)}`,
					summary: completed === void 0 ? "Running" : "Completed",
					status: completed === void 0 ? "pending" : "completed",
					startedAt: event.time,
					...completed === void 0 ? {} : {
						completedAt: completed.event.time,
						result: completed.event.data
					},
					payload: event.data
				});
				break;
			}
			case "user/message": {
				const text = messageText(event.data);
				const source = recordValue(event.data.source)?.kind;
				const detail = text === "" ? displayUnknown(event.data.content) : text;
				records.push({
					key: `event:${String(event.seq)}`,
					kind: "user",
					type: event.type,
					seq: event.seq,
					...at,
					title: source === "user" ? "User input" : "Context input",
					summary: oneLine(detail),
					detail,
					status: "info",
					startedAt: event.time,
					payload: event.data
				});
				break;
			}
			case "assistant/message": {
				const start = stepStarts.get(stepKey$1(event.data.turn, event.data.step));
				const text = messageText(event.data.message);
				const detail = text === "" ? "(empty response)" : text;
				records.push({
					key: `event:${String(event.seq)}`,
					kind: "assistant",
					type: event.type,
					seq: event.seq,
					turn: event.data.turn,
					step: event.data.step,
					title: "Assistant response",
					summary: oneLine(detail),
					detail,
					status: "completed",
					startedAt: start?.event.time ?? event.time,
					completedAt: event.time,
					payload: { source: event.data.message.source },
					result: {
						content: text === "" ? event.data.message.content : text,
						...event.data.usage === void 0 ? {} : { usage: event.data.usage }
					}
				});
				break;
			}
			case "tool/call": {
				const completed = toolResults.get(String(event.data.callId));
				const displayTitle = resultTitle(completed) ?? callTitle(entry) ?? event.data.name;
				const failed = completed === void 0 ? false : resultFailed(completed);
				records.push({
					key: `tool:${String(event.data.callId)}:${String(event.seq)}`,
					kind: "tool",
					type: event.type,
					...completed === void 0 ? {} : {
						completionType: completed.event.type,
						completionSeq: completed.event.seq
					},
					seq: event.seq,
					turn: event.data.turn,
					step: event.data.step,
					title: displayTitle,
					summary: `${event.data.name} · ${completed === void 0 ? "Running" : failed ? "Failed" : "Completed"}`,
					detail: displayTitle,
					status: completed === void 0 ? "pending" : failed ? "failed" : "completed",
					startedAt: event.time,
					...completed === void 0 ? {} : {
						completedAt: completed.event.time,
						result: toolResult(completed)
					},
					payload: {
						callId: event.data.callId,
						name: event.data.name,
						arguments: parsedJson(event.data.arguments)
					},
					...schemas.get(event.data.name) === void 0 ? {} : { schema: schemas.get(event.data.name) }
				});
				break;
			}
			case "command/run": {
				const completed = commandResults.get(String(event.data.commandId));
				const failed = completed?.event.type === "command/done" && completed.event.data.kind === "error";
				const result = completed?.event.type === "command/done" ? completed.event.data : void 0;
				const commandLine = `/${event.data.name}${event.data.args ?? ""}`;
				const detail = result?.text ?? commandLine;
				records.push({
					key: `command:${String(event.data.commandId)}:${String(event.seq)}`,
					kind: "command",
					type: event.type,
					...completed === void 0 ? {} : {
						completionType: completed.event.type,
						completionSeq: completed.event.seq
					},
					seq: event.seq,
					title: `/${event.data.name}`,
					summary: completed === void 0 ? "Running" : failed ? `Failed${result?.text === void 0 ? "" : ` · ${oneLine(result.text)}`}` : `Completed${result?.text === void 0 ? "" : ` · ${oneLine(result.text)}`}`,
					detail,
					status: completed === void 0 ? "pending" : failed ? "failed" : "completed",
					startedAt: event.time,
					...completed === void 0 ? {} : {
						completedAt: completed.event.time,
						result
					},
					payload: {
						commandId: event.data.commandId,
						name: event.data.name,
						...event.data.args === void 0 ? {} : { arguments: event.data.args },
						source: event.data.source
					}
				});
				break;
			}
			case "request/header": {
				const config = event.data.header.config;
				records.push({
					key: `event:${String(event.seq)}`,
					kind: "request",
					type: event.type,
					seq: event.seq,
					...at,
					title: "Model request",
					summary: `${config.provider}/${config.model}${config.reasoningEffort === void 0 ? "" : ` · ${String(config.reasoningEffort)}`}`,
					detail: `Model request to ${config.provider}/${config.model}${config.reasoningEffort === void 0 ? "" : ` with ${String(config.reasoningEffort)} reasoning`}`,
					status: "info",
					startedAt: event.time,
					payload: event.data.header,
					...event.data.header.tools === void 0 ? {} : { schema: event.data.header.tools }
				});
				break;
			}
			case "request/context":
				records.push({
					key: `event:${String(event.seq)}`,
					kind: "context",
					type: event.type,
					seq: event.seq,
					...at,
					title: "Request context",
					summary: `${event.data.provider}/${event.data.model}${event.data.contextWindow === void 0 ? "" : ` · ${String(event.data.contextWindow)} context`}`,
					detail: `Request context for ${event.data.provider}/${event.data.model}${event.data.contextWindow === void 0 ? "" : ` with a ${String(event.data.contextWindow)} token window`}`,
					status: "info",
					startedAt: event.time,
					payload: event.data
				});
				break;
			default: {
				const detail = displayUnknown(event.data);
				records.push({
					key: `event:${String(event.seq)}`,
					kind: event.type === "todo/write" ? "context" : "event",
					type: event.type,
					seq: event.seq,
					...at,
					title: event.type,
					summary: oneLine(detail),
					detail,
					status: "info",
					startedAt: event.time,
					payload: event.data
				});
			}
		}
		if (event.type === "step/end") activeStep = void 0;
		if (event.type === "turn/end") {
			activeStep = void 0;
			activeTurn = void 0;
		}
	}
	return records;
}
//#endregion
//#region src/trajectory/view.ts
const TABS = [
	{
		id: "summary",
		label: "Summary"
	},
	{
		id: "payload",
		label: "Input"
	},
	{
		id: "result",
		label: "Output"
	},
	{
		id: "schema",
		label: "Schema"
	},
	{
		id: "timing",
		label: "Timing"
	}
];
const SPLIT_MIN_WIDTH = 120;
const SHARE_BAR_WIDTH = 7;
function stepKey(turn, step) {
	return `${String(turn)}:${String(step)}`;
}
function formatDuration(milliseconds) {
	if (milliseconds < 1e3) return `${String(Math.max(0, Math.round(milliseconds)))} ms`;
	if (milliseconds < 6e4) return `${(milliseconds / 1e3).toFixed(milliseconds < 1e4 ? 2 : 1)} s`;
	const minutes = Math.floor(milliseconds / 6e4);
	const seconds = Math.floor(milliseconds % 6e4 / 1e3);
	return `${String(minutes)}m ${String(seconds)}s`;
}
function tabValue(record, tab, metrics) {
	switch (tab) {
		case "summary": return [
			`Status       ${record.status}`,
			`Duration     ${metrics.durationMs === void 0 ? "Not measured" : formatDuration(metrics.durationMs)}`,
			...metrics.shareOfParent === void 0 ? [] : [`Share        ${(metrics.shareOfParent * 100).toFixed(1)}% of ${metrics.parentTitle ?? "parent"}`],
			...metrics.slowest ? [`Bottleneck   Slowest timed block in ${metrics.parentTitle ?? "current scope"}`] : [],
			`Location     ${[record.turn === void 0 ? void 0 : `Turn ${String(record.turn)}`, record.step === void 0 ? void 0 : `Step ${String(record.step)}`].filter((value) => value !== void 0).join(" / ") || "Session"}`,
			`Event        ${record.type}${record.completionType === void 0 ? "" : ` → ${record.completionType}`}`,
			`Sequence     ${String(record.seq)}${record.completionSeq === void 0 ? "" : ` → ${String(record.completionSeq)}`}`,
			"",
			record.title,
			...(record.detail ?? record.summary).split("\n"),
			"",
			`Started      ${new Date(record.startedAt).toISOString()}`,
			`Completed    ${record.completedAt === void 0 ? "Still running or not applicable" : new Date(record.completedAt).toISOString()}`
		];
		case "payload": return record.payload === void 0 ? ["No payload recorded for this event."] : displayUnknown(record.payload).split("\n");
		case "result": return record.result === void 0 ? ["No result recorded for this event."] : displayUnknown(record.result).split("\n");
		case "schema": return record.schema === void 0 ? ["Schema unavailable for this event."] : displayUnknown(record.schema).split("\n");
		case "timing": {
			const end = record.completedAt;
			return [
				`Started: ${new Date(record.startedAt).toISOString()}`,
				...end === void 0 ? ["Completed: still running or not applicable"] : [`Completed: ${new Date(end).toISOString()}`, `Duration: ${formatDuration(metrics.durationMs ?? Math.max(0, end - record.startedAt))}`],
				...metrics.shareOfParent === void 0 ? [] : [`Parent share: ${(metrics.shareOfParent * 100).toFixed(1)}% of ${metrics.parentTitle ?? "parent"}`],
				`Start offset: +${formatDuration(metrics.offsetMs)}`,
				"",
				"Timing source: durable session event timestamps"
			];
		}
	}
}
function wrapped(lines, width) {
	return lines.flatMap((line) => {
		const rendered = wrapTextWithAnsi(sanitizeTerminalText(line), Math.max(1, width));
		return rendered.length === 0 ? [""] : rendered;
	});
}
function kindLabel(kind) {
	switch (kind) {
		case "turn": return "TURN";
		case "step": return "STEP";
		case "user": return "USER";
		case "request": return "REQUEST";
		case "assistant": return "ASSISTANT";
		case "tool": return "TOOL";
		case "command": return "COMMAND";
		case "context": return "CONTEXT";
		case "event": return "EVENT";
	}
}
function padVisible(text, width) {
	const clipped = truncateToWidth(text, Math.max(0, width), "…");
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}
function compactDuration(milliseconds) {
	if (milliseconds === void 0) return "—";
	if (milliseconds < 1e3) return `${String(Math.round(milliseconds))}ms`;
	if (milliseconds < 6e4) return `${(milliseconds / 1e3).toFixed(milliseconds < 1e4 ? 1 : 0)}s`;
	const minutes = Math.floor(milliseconds / 6e4);
	const seconds = Math.floor(milliseconds % 6e4 / 1e3);
	return `${String(minutes)}m${String(seconds).padStart(2, "0")}s`;
}
/** Full-screen, keyboard-first execution ledger and event detail surface. */
var TrajectoryView = class {
	visibleRows;
	theme;
	onLoadEarlier;
	onInterrupt;
	onCancel;
	onChange;
	state;
	records;
	model;
	index;
	mode = "list";
	tabIndex = 0;
	detailOffset = 0;
	detailPageRows = 1;
	detailMaxOffset = 0;
	listPageRows = 1;
	followTail = true;
	loadingEarlier = false;
	loadError;
	splitLayout = false;
	collapsedTurns = /* @__PURE__ */ new Set();
	collapsedSteps = /* @__PURE__ */ new Set();
	constructor(state, visibleRows, theme, onLoadEarlier, onInterrupt, onCancel, onChange) {
		this.visibleRows = visibleRows;
		this.theme = theme;
		this.onLoadEarlier = onLoadEarlier;
		this.onInterrupt = onInterrupt;
		this.onCancel = onCancel;
		this.onChange = onChange;
		this.state = state;
		this.records = buildTrajectoryRecords(state.events);
		this.model = new TrajectoryModel(this.records);
		this.index = Math.max(0, this.records.length - 1);
	}
	/** Rebuild from the latest live event window while preserving the selected semantic record. */
	setState(state) {
		const sessionChanged = state.sessionId !== this.state.sessionId;
		const selectedKey = this.records[this.index]?.key;
		this.state = state;
		this.records = buildTrajectoryRecords(state.events);
		this.model = new TrajectoryModel(this.records);
		if (sessionChanged) {
			this.mode = "list";
			this.followTail = true;
			this.tabIndex = 0;
			this.detailOffset = 0;
			this.collapsedTurns.clear();
			this.collapsedSteps.clear();
		}
		const preserved = selectedKey === void 0 ? -1 : this.records.findIndex((record) => record.key === selectedKey);
		this.index = this.followTail || preserved === -1 ? Math.max(0, this.records.length - 1) : preserved;
	}
	handleInput(data) {
		if (matchesKey(data, Key.ctrl("c"))) {
			if (this.state.running) this.onInterrupt();
			else this.onCancel();
			return;
		}
		if (this.mode === "detail") {
			if (matchesKey(data, Key.escape)) {
				this.mode = "list";
				this.detailOffset = 0;
				return;
			}
			if (matchesKey(data, Key.tab)) {
				this.selectTab(1);
				return;
			}
			if (matchesKey(data, Key.shift(Key.tab))) {
				this.selectTab(-1);
				return;
			}
			if (matchesKey(data, Key.left)) {
				this.selectTab(-1);
				return;
			}
			if (matchesKey(data, Key.right)) {
				this.selectTab(1);
				return;
			}
			if (matchesKey(data, Key.up) || data === "k") this.scrollDetail(-1);
			if (matchesKey(data, Key.down) || data === "j") this.scrollDetail(1);
			if (matchesKey(data, Key.pageUp)) this.scrollDetail(-this.detailPageRows);
			if (matchesKey(data, Key.pageDown)) this.scrollDetail(this.detailPageRows);
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.onCancel();
			return;
		}
		if (this.splitLayout && matchesKey(data, Key.tab) && this.records[this.index] !== void 0) {
			this.openDetail();
			return;
		}
		if (data === "h") {
			this.collapseSelected();
			return;
		}
		if (data === "l") {
			this.expandSelected();
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			if (this.index === 0) this.loadEarlier();
			else this.move(-1);
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			this.move(1);
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			const previous = this.index;
			this.move(-this.listPageRows);
			if (previous === 0 || this.index === 0) this.loadEarlier();
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.move(this.listPageRows);
			return;
		}
		if (data === "g") {
			this.index = this.visibleRecordIndexes()[0] ?? 0;
			this.followTail = false;
			this.detailOffset = 0;
			return;
		}
		if (data === "G") {
			this.index = this.visibleRecordIndexes().at(-1) ?? Math.max(0, this.records.length - 1);
			this.followTail = true;
			this.detailOffset = 0;
			return;
		}
		if (matchesKey(data, Key.ctrl("u"))) {
			this.move(-Math.max(1, Math.floor(this.listPageRows / 2)));
			return;
		}
		if (matchesKey(data, Key.ctrl("d"))) {
			this.move(Math.max(1, Math.floor(this.listPageRows / 2)));
			return;
		}
		if (matchesKey(data, Key.enter) && this.records[this.index] !== void 0) this.openDetail();
	}
	invalidate() {}
	render(width) {
		const now = Date.now();
		const { metrics, bottleneck } = this.model.measure(now);
		this.splitLayout = width >= SPLIT_MIN_WIDTH && this.records[this.index] !== void 0;
		if (this.splitLayout) return this.renderSplit(width, metrics, bottleneck);
		return this.mode === "detail" ? this.renderDetail(width, metrics) : this.renderList(width, metrics, bottleneck);
	}
	renderList(width, metrics, bottleneck) {
		const height = Math.max(1, this.visibleRows());
		const header = this.renderOverviewHeader(width, metrics, bottleneck);
		const footerText = this.loadingEarlier ? "Loading earlier history…" : this.loadError === void 0 ? "j/k select · h/l fold · Enter inspect · g/G ends · Esc chat" : `History load failed: ${this.loadError}`;
		const footer = [truncateToWidth(this.loadError === void 0 ? this.theme.dim(footerText) : this.theme.warning(footerText), width)];
		const available = Math.max(0, height - header.length - footer.length - 1);
		const body = this.renderListRows(width, available, metrics);
		return this.fit([
			...header,
			this.renderColumnHeader(width),
			...body,
			...Array(Math.max(0, available - body.length)).fill(""),
			...footer
		], height);
	}
	renderSplit(width, metrics, bottleneck) {
		const height = Math.max(1, this.visibleRows());
		const header = this.renderOverviewHeader(width, metrics, bottleneck);
		const footerText = this.mode === "detail" ? "Detail focus · j/k scroll · Tab/←/→ section · Esc events" : "Ledger focus · j/k select · h/l fold · Enter/Tab inspect · Esc chat";
		const footer = [truncateToWidth(this.theme.dim(footerText), width)];
		const available = Math.max(0, height - header.length - footer.length);
		const innerWidth = Math.max(1, width - 3);
		const leftWidth = Math.max(58, Math.min(innerWidth - 42, Math.floor(innerWidth * .58)));
		const rightWidth = Math.max(1, innerWidth - leftWidth);
		const record = this.records[this.index];
		if (record === void 0) return this.renderList(width, metrics, bottleneck);
		const leftBodyRows = Math.max(0, available - 1);
		const left = [this.renderColumnHeader(leftWidth), ...this.renderListRows(leftWidth, leftBodyRows, metrics)];
		const right = this.renderDetailPanel(rightWidth, available, record, metrics.get(record.key) ?? {
			offsetMs: 0,
			slowest: false
		}, true);
		const divider = this.mode === "detail" ? this.theme.accent("│") : this.theme.dim("│");
		const body = Array.from({ length: available }, (_, row) => {
			const leftLine = left[row] ?? "";
			const rightLine = right[row] ?? "";
			return `${padVisible(leftLine, leftWidth)} ${divider} ${truncateToWidth(rightLine, rightWidth, "…")}`;
		});
		return this.fit([
			...header,
			...body,
			...footer
		], height);
	}
	renderDetail(width, metrics) {
		const record = this.records[this.index];
		if (record === void 0) {
			this.mode = "list";
			return this.renderList(width, metrics, void 0);
		}
		return this.renderDetailPanel(width, Math.max(1, this.visibleRows()), record, metrics.get(record.key) ?? {
			offsetMs: 0,
			slowest: false
		}, false);
	}
	renderDetailPanel(width, height, record, metrics, split) {
		const tabs = TABS.map((tab, index) => index === this.tabIndex ? this.theme.bold(this.theme.accent(`[${tab.label}]`)) : this.theme.dim(` ${tab.label} `)).join(" ");
		const location = [
			record.turn === void 0 ? void 0 : `Turn ${String(record.turn)}`,
			record.step === void 0 ? void 0 : `Step ${String(record.step)}`,
			`seq ${String(record.seq)}`
		].filter((value) => value !== void 0).join(" · ");
		const header = split ? [
			truncateToWidth(this.theme.bold(this.theme.accent(`DETAIL · ${record.title}`)), width),
			truncateToWidth(this.theme.dim(`${kindLabel(record.kind)} · ${location}`), width),
			truncateToWidth(tabs, width),
			this.theme.dim("─".repeat(Math.max(0, width)))
		] : [
			truncateToWidth(this.theme.bold(this.theme.accent(`Trajectory · ${record.title}`)), width),
			truncateToWidth(this.theme.dim(`${kindLabel(record.kind)} · ${location}`), width),
			truncateToWidth(tabs, width),
			""
		];
		const available = Math.max(0, height - header.length - 1);
		this.detailPageRows = Math.max(1, available);
		const content = wrapped(tabValue(record, TABS[this.tabIndex]?.id ?? "summary", metrics), width);
		this.detailMaxOffset = Math.max(0, content.length - available);
		this.detailOffset = Math.max(0, Math.min(this.detailMaxOffset, this.detailOffset));
		const body = content.slice(this.detailOffset, this.detailOffset + available);
		const range = content.length <= available ? "" : ` · ${String(this.detailOffset + 1)}-${String(Math.min(content.length, this.detailOffset + available))}/${String(content.length)}`;
		const controls = split && this.mode === "list" ? "Enter/Tab focus details" : "Tab/←/→ section · j/k scroll · Esc events";
		const footer = [truncateToWidth(this.theme.dim(`${controls}${range}`), width)];
		return this.fit([
			...header,
			...body,
			...Array(Math.max(0, available - body.length)).fill(""),
			...footer
		], height);
	}
	renderOverviewHeader(width, metrics, bottleneck) {
		const activeTurn = this.records.filter((record) => record.kind === "turn").at(-1);
		const total = activeTurn === void 0 ? void 0 : metrics.get(activeTurn.key)?.durationMs;
		const visibleCount = this.visibleRecordIndexes().length;
		const recordCount = visibleCount === this.records.length ? `${String(this.records.length)} records` : `${String(visibleCount)}/${String(this.records.length)} visible`;
		const title = [
			"Trajectory",
			this.state.running ? "Live" : "Idle",
			activeTurn?.title,
			total === void 0 ? void 0 : formatDuration(total),
			recordCount
		].filter((value) => value !== void 0).join(" · ");
		const bottleneckMetrics = bottleneck === void 0 ? void 0 : metrics.get(bottleneck.key);
		const bottleneckLine = bottleneck === void 0 || bottleneckMetrics?.durationMs === void 0 ? "Bottleneck · no timed operation available yet" : `Bottleneck · ${bottleneck.title} · ${formatDuration(bottleneckMetrics.durationMs)}${bottleneckMetrics.shareOfParent === void 0 ? "" : ` · ${(bottleneckMetrics.shareOfParent * 100).toFixed(1)}% of ${bottleneckMetrics.parentTitle ?? "parent"}`}`;
		return [
			truncateToWidth(this.theme.bold(this.theme.accent(title)), width),
			truncateToWidth(bottleneck === void 0 ? this.theme.dim(bottleneckLine) : this.theme.warning(bottleneckLine), width),
			this.theme.dim("─".repeat(Math.max(0, width)))
		];
	}
	renderColumnHeader(width) {
		if (width < 44) return this.theme.dim(truncateToWidth("EXECUTION", width));
		const suffix = width >= 72 ? `${padVisible("START", 7)} ${padVisible("TIME", 8)} ${padVisible("SHARE", SHARE_BAR_WIDTH)}` : padVisible("TIME", 8);
		const executionWidth = Math.max(1, width - visibleWidth(suffix) - 1);
		return this.theme.dim(`${padVisible("EXECUTION", executionWidth)} ${suffix}`);
	}
	renderListRows(width, available, metrics) {
		this.listPageRows = Math.max(1, available);
		const visibleIndexes = this.visibleRecordIndexes();
		const selectedPosition = Math.max(0, visibleIndexes.indexOf(this.index));
		const maximumStart = Math.max(0, visibleIndexes.length - available);
		const start = Math.max(0, Math.min(maximumStart, selectedPosition - Math.floor(available / 2)));
		const visible = visibleIndexes.slice(start, start + available);
		if (visible.length === 0 && available > 0) return [this.theme.dim("No execution records yet. Events will appear here while the session runs.")];
		return visible.map((recordIndex) => this.renderRecord(this.records[recordIndex], recordIndex === this.index, width, metrics.get(this.records[recordIndex].key) ?? {
			offsetMs: 0,
			slowest: false
		}));
	}
	renderRecord(record, selected, width, metrics) {
		if (width < 28) return truncateToWidth(`${selected ? "›" : " "} ${kindLabel(record.kind)} ${record.title}`, width, "…");
		const branch = record.kind === "turn" ? "" : record.kind === "step" ? "  ├─" : record.step === void 0 ? "  ├─" : "  │ ├─";
		const glyph = record.status === "pending" ? this.theme.warning("○") : record.status === "warning" ? this.theme.warning("!") : record.status === "failed" ? this.theme.error("×") : record.status === "completed" ? this.theme.success("●") : this.theme.dim("·");
		const turnCollapsed = record.turn !== void 0 && this.collapsedTurns.has(record.turn);
		const stepCollapsed = record.turn !== void 0 && record.step !== void 0 && this.collapsedSteps.has(stepKey(record.turn, record.step));
		const disclosure = record.kind === "turn" ? turnCollapsed ? "▸ " : "▾ " : record.kind === "step" ? stepCollapsed ? "▸ " : "▾ " : "";
		const cursor = selected ? this.theme.accent("›") : " ";
		const compact = width < 48;
		const label = compact ? kindLabel(record.kind).slice(0, 4).padEnd(4) : kindLabel(record.kind).padEnd(9);
		const prefix = `${cursor} ${compact ? "" : branch}${disclosure}${glyph} ${label} `;
		const durationLabel = padVisible(compactDuration(metrics.durationMs).padStart(7), 7);
		const durationCell = metrics.slowest ? this.theme.warning(`▲${durationLabel}`) : ` ${durationLabel}`;
		const detailed = width >= 72;
		const filled = metrics.shareOfParent === void 0 ? 0 : Math.max(1, Math.min(SHARE_BAR_WIDTH, Math.round(metrics.shareOfParent * SHARE_BAR_WIDTH)));
		const rawBar = metrics.shareOfParent === void 0 ? "·".repeat(SHARE_BAR_WIDTH) : `${"█".repeat(filled)}${"·".repeat(SHARE_BAR_WIDTH - filled)}`;
		const bar = metrics.slowest ? this.theme.warning(rawBar) : this.theme.dim(rawBar);
		const offsetCell = padVisible(`+${compactDuration(metrics.offsetMs)}`, 7);
		const suffix = detailed ? `${offsetCell} ${durationCell} ${bar}` : durationCell;
		const contentWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix) - 1);
		const line = `${prefix}${padVisible(`${record.title} · ${record.summary}`, contentWidth)} ${suffix}`;
		return truncateToWidth(selected ? this.theme.bold(line) : line, width, "…");
	}
	visibleRecordIndexes() {
		const indexes = [];
		for (const [index, record] of this.records.entries()) {
			if (record.kind === "turn") {
				indexes.push(index);
				continue;
			}
			if (record.turn !== void 0 && this.collapsedTurns.has(record.turn)) continue;
			if (record.kind === "step") {
				indexes.push(index);
				continue;
			}
			if (record.turn !== void 0 && record.step !== void 0 && this.collapsedSteps.has(stepKey(record.turn, record.step))) continue;
			indexes.push(index);
		}
		return indexes;
	}
	collapseSelected() {
		const record = this.records[this.index];
		if (record?.kind === "turn" && record.turn !== void 0) this.collapsedTurns.add(record.turn);
		else if (record?.kind === "step" && record.turn !== void 0 && record.step !== void 0) this.collapsedSteps.add(stepKey(record.turn, record.step));
		else if (record !== void 0) {
			const parent = this.model.parentOf(record);
			const parentIndex = parent === void 0 ? -1 : this.records.findIndex((candidate) => candidate.key === parent.key);
			if (parentIndex >= 0) this.index = parentIndex;
		}
		this.followTail = false;
		this.detailOffset = 0;
	}
	expandSelected() {
		const record = this.records[this.index];
		if (record?.kind === "turn" && record.turn !== void 0) this.collapsedTurns.delete(record.turn);
		else if (record?.kind === "step" && record.turn !== void 0 && record.step !== void 0) this.collapsedSteps.delete(stepKey(record.turn, record.step));
		this.detailOffset = 0;
	}
	move(offset) {
		const visible = this.visibleRecordIndexes();
		const position = Math.max(0, visible.indexOf(this.index));
		const target = Math.max(0, Math.min(visible.length - 1, position + offset));
		this.index = visible[target] ?? this.index;
		this.followTail = this.index === this.records.length - 1;
		this.detailOffset = 0;
	}
	openDetail() {
		this.mode = "detail";
		this.followTail = false;
		this.tabIndex = 0;
		this.detailOffset = 0;
	}
	selectTab(offset) {
		this.tabIndex = (this.tabIndex + offset + TABS.length) % TABS.length;
		this.detailOffset = 0;
	}
	scrollDetail(offset) {
		this.detailOffset = Math.max(0, Math.min(this.detailMaxOffset, this.detailOffset + offset));
	}
	async loadEarlier() {
		if (!this.state.historyHasMore || this.loadingEarlier) return;
		this.loadingEarlier = true;
		this.loadError = void 0;
		this.followTail = false;
		this.onChange();
		try {
			await this.onLoadEarlier();
		} catch (error) {
			this.loadError = error instanceof Error ? error.message : String(error);
		} finally {
			this.loadingEarlier = false;
			this.onChange();
		}
	}
	fit(lines, height) {
		return [...lines.slice(0, height), ...Array(Math.max(0, height - lines.length)).fill("")];
	}
};
//#endregion
//#region src/presentation/mouse.ts
/** Enable SGR mouse coordinates and pointer-motion reports for the presentation layer. */
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
//#region src/runtime/commands.ts
function parseCommand(text) {
	const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
	if (match === null || match[1] === void 0) return void 0;
	return {
		name: match[1].toLowerCase(),
		argument: match[2]?.trim() ?? ""
	};
}
function descriptorKey(descriptor) {
	return [
		descriptor.name,
		descriptor.description,
		descriptor.argumentHint ?? ""
	].join("\0");
}
/**
* One command directory for local interaction commands and agent-scoped Host
* commands. Rendering libraries consume its plain descriptors; only local
* definitions execute here, while unresolved slash input continues to Host.
*/
var TerminalCommandDirectory = class {
	local;
	source;
	onChange;
	localByName = /* @__PURE__ */ new Map();
	removeHostListener;
	sessionId;
	host = [];
	signature = "";
	constructor(local, source, onChange = () => {}) {
		this.local = local;
		this.source = source;
		this.onChange = onChange;
		for (const definition of local) {
			this.localByName.set(definition.name, definition);
			for (const alias of definition.aliases ?? []) this.localByName.set(alias, definition);
		}
		this.removeHostListener = source?.subscribe(() => {
			if (this.refreshHost()) this.onChange();
		}) ?? (() => {});
		this.refreshHost();
	}
	/** Effective discovery rows, with TUI-local commands shadowing Host names. */
	get descriptors() {
		const localNames = new Set(this.localByName.keys());
		return [...this.local.map((command) => ({
			name: command.name,
			description: command.description,
			...command.argumentHint === void 0 ? {} : { argumentHint: command.argumentHint }
		})), ...this.host.filter((command) => !localNames.has(command.name))];
	}
	/** Refresh the agent-scoped Host view when the active session changes. */
	setSession(sessionId) {
		if (sessionId === this.sessionId) return false;
		this.sessionId = sessionId;
		return this.refreshHost();
	}
	/** Dispatch a TUI-local command; return false so Host can resolve the rest. */
	async dispatch(text) {
		const parsed = parseCommand(text);
		if (parsed === void 0) return false;
		const command = this.localByName.get(parsed.name);
		if (command === void 0) return false;
		await command.handler(parsed.argument);
		return true;
	}
	/** Complete help content generated from the same effective discovery rows. */
	helpText() {
		return this.descriptors.map((command) => {
			const argument = command.argumentHint === void 0 ? "" : ` ${command.argumentHint}`;
			return `/${command.name}${argument} · ${command.description}`;
		}).join("\n");
	}
	dispose() {
		this.removeHostListener();
	}
	refreshHost() {
		const next = [...this.source?.list(this.sessionId) ?? []].map((command) => ({
			name: command.name.toLowerCase(),
			description: command.description,
			...command.argumentHint === void 0 ? {} : { argumentHint: command.argumentHint }
		})).sort((left, right) => left.name.localeCompare(right.name));
		const signature = next.map(descriptorKey).join("");
		if (signature === this.signature) return false;
		this.host = next;
		this.signature = signature;
		return true;
	}
};
//#endregion
//#region src/application/app.ts
const DOUBLE_ESCAPE_MS = 600;
function sessionDescription(session) {
	return session.cwd ?? String(session.sessionId);
}
function questionTitle(question) {
	return [question.header, question.question].filter(Boolean).join(" · ");
}
function shellArgument(value) {
	if (/^[A-Za-z0-9._:-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", "'\\''")}'`;
}
function resumeHint(sessionId) {
	if (sessionId === void 0) return void 0;
	return `\nResume this session with:\n  dsh-tui --resume ${shellArgument(String(sessionId))}\n\n`;
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
	trajectoryView;
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
	commands;
	autocompleteCwd;
	constructor(api, config, runtime, checkpoints, memory, commandSource) {
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
			historyHasMore: false,
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
		this.commands = new TerminalCommandDirectory(this.localCommands(), commandSource, () => this.refreshAutocomplete());
		this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...this.commands.descriptors], config.cwd));
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
		this.commands.dispose();
		this.removeMemoryActivity();
		this.terminal.write(DISABLE_MOUSE_TRACKING);
		this.removeInputListener?.();
		this.tui.stop();
		await this.terminal.drainInput(250, 30);
	}
	render(state) {
		if (this.disposed) return;
		const commandsChanged = this.commands.setSession(state.sessionId);
		this.transcript.setState(state);
		this.trajectoryView?.setState(state);
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
		if (state.cwd !== this.autocompleteCwd || commandsChanged) this.refreshAutocomplete(state.cwd, false);
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
			const elapsedSeconds = Math.max(0, Math.floor((Date.now() - this.workingStartedAt) / 1e3));
			this.status.setText([this.theme.accent(glyph), this.theme.dim(` Working (${elapsedSeconds}s · esc to interrupt${history})`)].join(""));
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
		return this.commands.dispatch(text);
	}
	localCommands() {
		return [
			{
				name: "help",
				description: "Show terminal and Harness commands",
				handler: () => {
					this.controller.notice(this.commands.helpText());
				}
			},
			{
				name: "clear",
				description: "Clear the conversation and start a new session",
				handler: async () => {
					this.layout.followTranscript();
					await this.controller.clearSession();
				}
			},
			{
				name: "new",
				description: "Create a new session",
				handler: () => this.controller.newSession()
			},
			{
				name: "resume",
				description: "Switch to another session",
				argumentHint: "[session-id]",
				handler: async (argument) => {
					if (argument !== "") await this.controller.resume(argument);
					else await this.openSessionSelector();
				}
			},
			{
				name: "model",
				description: "Select model and provider",
				argumentHint: "[provider/model]",
				handler: async (argument) => {
					if (argument !== "") await this.selectNamedModel(argument);
					else await this.openModelSelector();
				}
			},
			{
				name: "details",
				description: "Toggle expanded tool output",
				handler: () => {
					this.showDetails = !this.showDetails;
					this.transcript.setDetails(this.showDetails);
					this.tui.requestRender();
				}
			},
			{
				name: "trajectory",
				aliases: ["trace"],
				description: "Inspect the session execution chain",
				handler: () => {
					this.openTrajectory();
				}
			},
			{
				name: "status",
				description: "Show current session status",
				handler: () => {
					const state = this.controller.current;
					this.controller.notice([
						`Session: ${state.sessionId === void 0 ? "none" : String(state.sessionId)}`,
						`Directory: ${state.cwd}`,
						`State: ${state.running ? "running" : "idle"}`,
						`Stream: ${state.connected ? "connected" : "reconnecting"}`,
						`Queued: ${state.queue.length}`
					].join("\n"));
				}
			},
			{
				name: "memories",
				aliases: ["memory"],
				description: "Manage project memory and session learning",
				handler: () => this.openMemoryDialog()
			},
			{
				name: "rewind",
				description: "Open workspace and conversation checkpoints",
				handler: () => {
					this.requestRewind();
				}
			},
			{
				name: "exit",
				aliases: ["quit"],
				description: "Exit the terminal client",
				handler: () => this.requestExit(0)
			}
		];
	}
	refreshAutocomplete(cwd = this.controller.current.cwd, requestRender = true) {
		if (this.disposed) return;
		this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...this.commands.descriptors], cwd));
		this.autocompleteCwd = cwd;
		if (requestRender) this.tui.requestRender();
	}
	requestRewind() {
		this.disarmRewind();
		this.runAction(() => this.openRewind());
	}
	openTrajectory() {
		if (this.tui.hasOverlay() || this.composerModalActive) return;
		const close = () => {
			if (this.trajectoryView === void 0) return;
			this.trajectoryView = void 0;
			this.layout.setComposerOverride(void 0);
			this.composerModalActive = false;
			this.tui.setFocus(this.editor);
			this.tui.requestRender();
		};
		const trajectory = new TrajectoryView(this.controller.current, () => this.terminal.rows, this.theme, () => this.controller.loadEarlierHistory(), () => {
			this.runAction(() => this.controller.cancel());
		}, close, () => this.tui.requestRender());
		this.trajectoryView = trajectory;
		this.composerModalActive = true;
		this.layout.setComposerOverride(trajectory);
		this.tui.setFocus(trajectory);
		this.tui.requestRender();
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
		const hint = code === 0 ? resumeHint(this.controller.current.sessionId) : void 0;
		await this.dispose();
		if (hint !== void 0) this.runtime.stdout.write(hint);
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
//#region src/application/config.ts
/** Application-level configuration materialized before runtime construction. */
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
	"commands",
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
const HELP = `Usage: dsh-tui [options]

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
	const app = new TuiApplication(api, resolved, runtime, checkpoints, ctx.memory, {
		list: (sessionId) => {
			if (sessionId === void 0) return [];
			const agent = ctx.agents.get(sessionId);
			if (agent === void 0) return [];
			return ctx.commands.list(agent).map((command) => ({
				name: command.name,
				description: command.description,
				...command.input === void 0 ? {} : { argumentHint: command.input.hint }
			}));
		},
		subscribe: (listener) => ctx.on("commands/change", listener)
	});
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
export { Config, HarnessController, TerminalCommandDirectory, TrajectoryModel, TrajectoryView, TranscriptComponent, apply, buildTrajectoryRecords, inject, name, resolveConfig, sanitizeTerminalText };

//# sourceMappingURL=index.js.map