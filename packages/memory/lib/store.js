import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
//#region src/store.ts
/** Markdown file storage for global and project-scoped agent memory. */
const MEMORY_TOPICS = [
	"preferences",
	"conventions",
	"decisions",
	"debugging"
];
const TOPIC_PATTERN = /^[a-z][a-z0-9-]*$/u;
function expandHome(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}
function utf8Bytes(value) {
	return Buffer.byteLength(value, "utf8");
}
function normalizedLine(value) {
	return value.trim().replaceAll(/\s+/gu, " ");
}
function normalizedKey(value) {
	return normalizedLine(value).toLocaleLowerCase("en-US");
}
function safeSlug(value) {
	const normalized = value.normalize("NFKD").toLocaleLowerCase("en-US").replaceAll(/[^a-z0-9]+/gu, "-").replaceAll(/^-+|-+$/gu, "");
	return normalized === "" ? "project" : normalized.slice(0, 48);
}
function normalizeRemote(value) {
	const trimmed = value.trim().replace(/\.git$/u, "");
	try {
		const url = new URL(trimmed);
		url.username = "";
		url.password = "";
		url.hash = "";
		url.search = "";
		return url.toString().replace(/\/$/u, "");
	} catch {
		return trimmed.replace(/^[^@\s]+@/u, "");
	}
}
function memoryDocumentName(name) {
	return name === "MEMORY.md" || name.endsWith(".md") && MEMORY_TOPICS.includes(name.slice(0, -3));
}
function mergeMemoryDocuments(current, legacy) {
	if (current === null || current.trim() === "") return ensureTrailingNewline(legacy);
	if (current === legacy) return current;
	const existing = new Set(current.split("\n").map(normalizedLine).filter(Boolean));
	const legacyLines = legacy.split("\n");
	if (legacyLines[0]?.startsWith("# ")) legacyLines.shift();
	const additions = legacyLines.filter((line) => {
		const normalized = normalizedLine(line);
		if (normalized === "" || existing.has(normalized)) return false;
		existing.add(normalized);
		return true;
	});
	if (additions.length === 0) return ensureTrailingNewline(current);
	return `${current.replaceAll(/\n+$/gu, "")}\n\n${additions.join("\n")}\n`;
}
function runGit(cwd, args) {
	return new Promise((resolveOutput) => {
		execFile("git", [
			"-C",
			cwd,
			...args
		], {
			encoding: "utf8",
			maxBuffer: 1048576,
			timeout: 3e3
		}, (error, stdout) => {
			resolveOutput(error === null ? stdout.trim() : void 0);
		});
	});
}
async function readableFile(path, maxBytes) {
	try {
		const info = await stat(path);
		if (!info.isFile()) throw new Error(`memory path is not a regular file: ${path}`);
		if (info.size > maxBytes) throw new Error(`memory document exceeds maxDocumentBytes ${String(maxBytes)}: ${path}`);
		const content = await readFile(path, "utf8");
		if (utf8Bytes(content) > maxBytes) throw new Error(`memory document exceeds maxDocumentBytes ${String(maxBytes)}: ${path}`);
		return content;
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}
async function atomicWrite(path, content) {
	await mkdir(dirname(path), {
		recursive: true,
		mode: 448
	});
	const temporary = join(dirname(path), `.memory-${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, content, {
			encoding: "utf8",
			mode: 384
		});
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}
function documentTitle(scope, topic) {
	if (topic !== void 0) return `# ${topic[0]?.toLocaleUpperCase("en-US") ?? ""}${topic.slice(1)} memory\n\n`;
	return scope === "global" ? "# Global memory\n\n" : "# Project memory\n\n";
}
function ensureTrailingNewline(value) {
	return `${value.replaceAll(/\n+$/gu, "")}\n`;
}
function appendUniqueBullet(content, title, bullet, key) {
	const base = content === null || content.trim() === "" ? title : ensureTrailingNewline(content);
	return base.split("\n").some((line) => {
		if (!line.startsWith("- ")) return false;
		const remembered = normalizedKey(line.slice(2).replace(/\s+\(\[[^\]]+\]\([^)]+\)\)$/u, ""));
		return remembered === key || remembered.startsWith(`${key} — `);
	}) ? base : `${base.endsWith("\n\n") ? base : `${base}\n`}- ${bullet}\n`;
}
function removeBullet(content, summary) {
	if (content === null) return null;
	const key = normalizedKey(summary);
	return ensureTrailingNewline(content.split("\n").filter((line) => {
		if (!line.startsWith("- ")) return true;
		const remembered = normalizedKey(line.slice(2).replace(/\s+\(\[[^\]]+\]\([^)]+\)\)$/u, ""));
		return remembered !== key && !remembered.startsWith(`${key} — `);
	}).join("\n"));
}
function assertTopic(topic) {
	if (topic === void 0) return;
	if (!TOPIC_PATTERN.test(topic) || !MEMORY_TOPICS.includes(topic)) throw new Error(`unsupported memory topic "${topic}"`);
}
function containsSensitiveMaterial(value) {
	return /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/u.test(value) || /\b(?:api[_ -]?key|password|passwd|secret|access[_ -]?token)\s*[:=]\s*[^\s*`]{8,}/iu.test(value);
}
/** Local Markdown implementation used by the Harness service. */
var MemoryFileStore = class {
	options;
	root;
	queues = /* @__PURE__ */ new Map();
	constructor(options) {
		this.options = options;
		this.root = resolve(expandHome(options.root));
		for (const [name, value] of Object.entries({
			maxDocumentBytes: options.maxDocumentBytes,
			maxSummaryChars: options.maxSummaryChars,
			maxDetailsChars: options.maxDetailsChars
		})) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`memory: ${name} must be a positive safe integer`);
	}
	/** Resolve a stable project directory, sharing identity across clones with the same origin URL. */
	async project(cwd) {
		const gitRoot = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
		const root = await realpath(gitRoot === void 0 || gitRoot === "" ? cwd : gitRoot);
		const remoteValue = await runGit(root, [
			"config",
			"--get",
			"remote.origin.url"
		]);
		const remote = remoteValue === void 0 || remoteValue === "" ? void 0 : normalizeRemote(remoteValue);
		const commonDirectoryValue = remote === void 0 ? await runGit(root, [
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir"
		]) : void 0;
		const commonDirectory = commonDirectoryValue === void 0 || commonDirectoryValue === "" ? void 0 : await realpath(resolve(root, commonDirectoryValue));
		const repositoryRoot = commonDirectory !== void 0 && basename(commonDirectory) === ".git" ? await realpath(dirname(commonDirectory)) : commonDirectory;
		const identity = remote ?? repositoryRoot ?? root;
		const digest = createHash("sha256").update(identity).digest("hex").slice(0, 12);
		const id = `${safeSlug(basename(identity))}-${digest}`;
		const directory = join(this.root, "projects", id);
		const legacyIdentity = remote ?? root;
		const legacyDigest = createHash("sha256").update(legacyIdentity).digest("hex").slice(0, 12);
		const legacyDirectory = join(this.root, "projects", `${safeSlug(basename(root))}-${legacyDigest}`);
		await this.migrateLegacyProjectDirectories(directory, legacyDirectory, remote === void 0 ? void 0 : digest);
		return {
			id,
			root,
			directory
		};
	}
	/** Read one bounded Markdown memory document without creating it. */
	async read(cwd, scope, topic) {
		assertTopic(topic);
		const project = await this.project(cwd);
		const path = this.pathFor(project, scope, topic);
		const content = await readableFile(path, this.options.maxDocumentBytes);
		return {
			scope,
			...topic === void 0 ? {} : { topic },
			path,
			exists: content !== null,
			content: content ?? "",
			bytes: content === null ? 0 : utf8Bytes(content)
		};
	}
	/** List existing Markdown documents for both memory scopes. */
	async list(cwd) {
		const project = await this.project(cwd);
		const documents = [];
		for (const scope of ["project", "global"]) {
			const directory = scope === "global" ? join(this.root, "global") : project.directory;
			let names;
			try {
				names = await readdir(directory);
			} catch (error) {
				if (error.code === "ENOENT") continue;
				throw error;
			}
			const markdown = names.filter((name) => name === "MEMORY.md" || name.endsWith(".md")).sort();
			for (const name of markdown) {
				const topic = name === "MEMORY.md" ? void 0 : name.slice(0, -3);
				if (topic !== void 0 && !MEMORY_TOPICS.includes(topic)) continue;
				documents.push(await this.read(cwd, scope, topic));
			}
		}
		return documents;
	}
	/** Append one deduplicated memory and return the exact reversible file mutation. */
	async write(input) {
		assertTopic(input.topic);
		const summary = this.cleanText("summary", input.summary, this.options.maxSummaryChars);
		const details = input.details === void 0 ? void 0 : this.cleanText("details", input.details, this.options.maxDetailsChars);
		if (containsSensitiveMaterial(`${summary}\n${details ?? ""}`)) throw new Error("memory: refusing to persist content that looks like a credential or secret");
		const project = await this.project(input.cwd);
		const directory = input.scope === "global" ? join(this.root, "global") : project.directory;
		return this.enqueue(directory, async () => {
			const indexPath = this.pathFor(project, input.scope);
			const beforeIndex = await readableFile(indexPath, this.options.maxDocumentBytes);
			const link = input.topic === void 0 ? summary : `${summary} ([${input.topic}](${input.topic}.md))`;
			const afterIndex = appendUniqueBullet(beforeIndex, documentTitle(input.scope), link, normalizedKey(summary));
			const mutations = [];
			if (afterIndex !== beforeIndex) {
				this.assertDocumentSize(afterIndex);
				await atomicWrite(indexPath, afterIndex);
				mutations.push({
					path: indexPath,
					before: beforeIndex,
					after: afterIndex
				});
			}
			if (input.topic !== void 0) {
				const topicPath = this.pathFor(project, input.scope, input.topic);
				const beforeTopic = await readableFile(topicPath, this.options.maxDocumentBytes);
				const bullet = details === void 0 ? summary : `${summary} — ${details}`;
				const afterTopic = appendUniqueBullet(beforeTopic, documentTitle(input.scope, input.topic), bullet, normalizedKey(summary));
				if (afterTopic !== beforeTopic) {
					this.assertDocumentSize(afterTopic);
					await atomicWrite(topicPath, afterTopic);
					mutations.push({
						path: topicPath,
						before: beforeTopic,
						after: afterTopic
					});
				}
			}
			return {
				files: mutations,
				changed: mutations.length > 0
			};
		});
	}
	/** Remove one exact remembered summary from its index and optional topic. */
	async forget(input) {
		assertTopic(input.topic);
		const summary = this.cleanText("summary", input.summary, this.options.maxSummaryChars);
		const project = await this.project(input.cwd);
		const directory = input.scope === "global" ? join(this.root, "global") : project.directory;
		return this.enqueue(directory, async () => {
			const paths = [this.pathFor(project, input.scope), ...input.topic === void 0 ? [] : [this.pathFor(project, input.scope, input.topic)]];
			const mutations = [];
			for (const path of paths) {
				const before = await readableFile(path, this.options.maxDocumentBytes);
				const after = removeBullet(before, summary);
				if (before === null || after === before) continue;
				this.assertDocumentSize(after ?? "");
				await atomicWrite(path, after ?? "");
				mutations.push({
					path,
					before,
					after
				});
			}
			return {
				files: mutations,
				changed: mutations.length > 0
			};
		});
	}
	/** Apply an exact before/after mutation direction with stale-state protection. */
	async restore(files, direction) {
		const ordered = direction === "before" ? [...files].reverse() : [...files];
		if (ordered.length === 0) return;
		if (new Set(ordered.map((file) => dirname(file.path))).size !== 1) throw new Error("memory mutation files must share one scope directory");
		for (const file of ordered) if (!this.isOwnedPath(file.path)) throw new Error(`memory mutation path is outside the memory root: ${file.path}`);
		await this.enqueue(dirname(ordered[0]?.path ?? this.root), async () => {
			const expected = ordered.map((file) => direction === "before" ? file.after : file.before);
			const replacement = ordered.map((file) => direction === "before" ? file.before : file.after);
			const current = await Promise.all(ordered.map((file) => readableFile(file.path, this.options.maxDocumentBytes)));
			for (const [index, file] of ordered.entries()) if (current[index] !== expected[index]) throw new Error(`memory document changed after the checkpoint preview: ${file.path}`);
			const applied = [];
			try {
				for (const [index, file] of ordered.entries()) {
					const content = replacement[index];
					if (content === null) await rm(file.path, { force: true });
					else if (content !== void 0) await atomicWrite(file.path, content);
					applied.push(index);
				}
			} catch (error) {
				for (const index of applied.reverse()) {
					const file = ordered[index];
					const content = current[index];
					if (file === void 0) continue;
					if (content === null) await rm(file.path, { force: true });
					else if (content !== void 0) await atomicWrite(file.path, content);
				}
				throw error;
			}
		});
	}
	pathFor(project, scope, topic) {
		const directory = scope === "global" ? join(this.root, "global") : project.directory;
		return join(directory, topic === void 0 ? "MEMORY.md" : `${topic}.md`);
	}
	cleanText(name, value, maxChars) {
		const normalized = normalizedLine(value);
		if (normalized === "") throw new Error(`memory: ${name} must not be empty`);
		if (normalized.length > maxChars) throw new Error(`memory: ${name} exceeds ${String(maxChars)} characters`);
		return normalized;
	}
	assertDocumentSize(content) {
		if (utf8Bytes(content) > this.options.maxDocumentBytes) throw new Error(`memory: write would exceed maxDocumentBytes ${String(this.options.maxDocumentBytes)}`);
	}
	isOwnedPath(path) {
		const absolute = resolve(path);
		return absolute === path && absolute.startsWith(`${this.root}${sep}`);
	}
	async migrateLegacyProjectDirectories(directory, legacyDirectory, remoteDigest) {
		const candidates = /* @__PURE__ */ new Set();
		if (legacyDirectory !== directory) candidates.add(legacyDirectory);
		if (remoteDigest !== void 0) {
			const projectsDirectory = join(this.root, "projects");
			try {
				const entries = await readdir(projectsDirectory, { withFileTypes: true });
				for (const entry of entries) {
					const candidate = join(projectsDirectory, entry.name);
					if (entry.isDirectory() && candidate !== directory && entry.name.endsWith(`-${remoteDigest}`)) candidates.add(candidate);
				}
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
		}
		if (candidates.size === 0) return;
		await this.enqueue(directory, async () => {
			for (const candidate of candidates) await this.migrateLegacyProjectDirectory(candidate, directory);
		});
	}
	async migrateLegacyProjectDirectory(source, destination) {
		let sourceEntries;
		try {
			sourceEntries = await readdir(source);
		} catch (error) {
			if (error.code === "ENOENT") return;
			throw error;
		}
		try {
			await stat(destination);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			await mkdir(dirname(destination), {
				recursive: true,
				mode: 448
			});
			try {
				await rename(source, destination);
				return;
			} catch (renameError) {
				if (![
					"EEXIST",
					"ENOENT",
					"ENOTEMPTY"
				].includes(renameError.code ?? "")) throw renameError;
			}
		}
		const documents = sourceEntries.filter(memoryDocumentName);
		for (const name of documents) {
			const sourcePath = join(source, name);
			const destinationPath = join(destination, name);
			const legacy = await readableFile(sourcePath, this.options.maxDocumentBytes);
			if (legacy === null) continue;
			const current = await readableFile(destinationPath, this.options.maxDocumentBytes);
			const merged = mergeMemoryDocuments(current, legacy);
			this.assertDocumentSize(merged);
			if (merged !== current) await atomicWrite(destinationPath, merged);
		}
		for (const name of documents) await rm(join(source, name), { force: true });
		try {
			await rmdir(source);
		} catch (error) {
			if (!["ENOENT", "ENOTEMPTY"].includes(error.code ?? "")) throw error;
		}
	}
	enqueue(key, operation) {
		const current = (this.queues.get(key) ?? Promise.resolve()).then(operation, operation);
		this.queues.set(key, current);
		current.finally(() => {
			if (this.queues.get(key) === current) this.queues.delete(key);
		}).catch(() => {});
		return current;
	}
};
/** Public topic vocabulary shared by tools and UI consumers. */
const memoryTopics = MEMORY_TOPICS;
//#endregion
export { MemoryFileStore, memoryTopics };

//# sourceMappingURL=store.js.map