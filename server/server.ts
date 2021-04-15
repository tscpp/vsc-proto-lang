import {
	createConnection,
	TextDocuments,
	Diagnostic,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	CompletionItemKind,
	TextDocumentSyncKind,
	InitializeResult,
	Range,
	Position,
	DiagnosticSeverity
} from 'vscode-languageserver/node'

import { TextDocument } from 'vscode-languageserver-textdocument'
import * as Uri from 'url'
import * as Path from 'path'
import * as Fs from 'fs'

const connection = createConnection(ProposedFeatures.all)

const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument)

let hasConfigurationCapability = false
let hasWorkspaceFolderCapability = false
let hasDiagnosticRelatedInformationCapability = false

connection.onInitialize((params: InitializeParams) => {
	let capabilities = params.capabilities

	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	)
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	)
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	)

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			completionProvider: {
				resolveProvider: true
			}
		}
	}
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		}
	}
	return result
})

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		connection.client.register(DidChangeConfigurationNotification.type, undefined)
	}
})

interface ProtoSettings {
	include: string[]
}

const defaultSettings: ProtoSettings = { include: [] }
let globalSettings: ProtoSettings = defaultSettings

let documentSettings: Map<string, Thenable<ProtoSettings>> = new Map()

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		documentSettings.clear()
	} else {
		globalSettings = change.settings['proto-lang'] ?? defaultSettings
	}

	// Revalidate all open text documents
	documents.all().forEach(validateTextDocument)
})

function getDocumentSettings(resource: string): Thenable<ProtoSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings)
	}
	let result = documentSettings.get(resource)
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'proto-lang'
		})
		documentSettings.set(resource, result)
	}
	return result ?? globalSettings
}

documents.onDidClose(e => {
	documentSettings.delete(e.document.uri)
})

documents.onDidChangeContent(change => {
	// validateTextDocument(change.document)
})

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
	const diagnostics: Diagnostic[] = []

	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics })
}

// connection.onDidChangeWatchedFiles(_change => {
// 	// Monitored files have change in VS Code
// })

function execAll(string: string, regex: RegExp): RegExpExecArray[] {
	let all: RegExpExecArray[] = []
	let match

	while ((match = regex.exec(string)) !== null) {
		all.push(match)
	}

	return all
}

class ParseErrorPosition {
	constructor(public x: number, public y: number) { }

	toPosition(): Position {
		return Position.create(this.y, this.x)
	}
}

class ParseError extends Error {
	constructor(
		public positive: string,
		public negative: string,
		public filename: string,
		public start: ParseErrorPosition,
		public end = new ParseErrorPosition(start.y, start.x + 1)
	) {
		super([
			filename,
			':',
			start.x,
			':',
			start.y,
			': Expected \'',
			positive,
			'\' got \'',
			negative,
			'\'.'
		].join(''))
	}

	static isParserError(err: any): err is ParseError {
		return (err ?? null) === null && typeof err === 'object' && err instanceof ParseError
	}
}

function offsetToPosition(document: string, offset: number): ParseErrorPosition {
	let position = new ParseErrorPosition(0, 0)

	const lines = document.split('\n')
	let currentOffset = 0

	for (const line of lines) {
		if (currentOffset + line.length <= offset) {
			position.y += line.length
		} else {
			position.x = currentOffset - offset
			break
		}
		currentOffset += line.length
	}

	return position
}

function positionToOffset(document: string, line: number, column: number): number {
	const lines = document.split('\n')
	let offset = column

	for (let index = 0; index < lines.length; index++) {
		if (index === line) {
			break
		} else {
			offset += lines[index].length
		}
	}

	return offset
}

// eslint-disable-next-line @typescript-eslint/naming-convention
interface _Node {
	name: string
}

interface Message extends _Node {
	type: 'message'
}

interface Enum extends _Node {
	type: 'enum'
}

type Node = Message | Enum

// eslint-disable-next-line @typescript-eslint/naming-convention
interface _Module {
	package: string | undefined
	modules: Module[]
	nodes: Node[]
}

interface RootModule extends _Module { }

interface Module extends _Module {
	id: string
	public: boolean
}

// TODO: move to a separate package
function parse(uri: string, document: string, settings: ProtoSettings): RootModule {
	const include = settings.include
	const path = Uri.fileURLToPath(uri)

	let nodes: Node[] = []
	let modules: Module[] = []

	let curlyBlocks = 0
	let bracketBlocks = 0
	let parentheses = 0
	let singleComments = 0
	let multiComments = 0

	let latestNegativeCurly: number | undefined
	let latestNegativeBracket: number | undefined
	let latestNegativeParentheses: number | undefined
	let latestNegativeMultiComment: number | undefined

	let package_ = /\s*package\s*([^;\s]+)\s*;/.exec(document)?.[1]

	const imports = execAll(document, /\s*import\s*"([^"]+)"\s*;/gm)

	if (imports.length > 0 && include.length <= 0) {
		const match = /syntax\s=\s(?:"|'|)[^"]+(?:"|'|)(?:;|)/.exec(document)
		const start = match ? offsetToPosition(document, match.index).toPosition() : Position.create(0, 0)
		const end = match ? offsetToPosition(document, match.index + match.length).toPosition() : Position.create(0, 1)

		connection.sendDiagnostics({
			uri: uri,
			diagnostics: [{
				message: 'No include paths were provided',
				range: Range.create(start, end),
				severity: DiagnosticSeverity.Warning
			}]
		})
	}

	for (const import_ of imports) {
		const module = import_[1].trim()
		// TODO: option to always include ./
		const modulepaths = Path.isAbsolute(module) ? [module] : include.map(root => Path.resolve(root, module)).concat(Path.resolve(Path.parse(path).dir, module))

		let doc: RootModule | undefined

		for (const modulepath of modulepaths) {
			let content: string | undefined

			try {
				content = Fs.readFileSync(modulepath, 'utf8')
			} catch {}

			if (!content) continue

			doc = parse(Uri.pathToFileURL(modulepath).toString(), content, settings)
			break
		}

		if (!doc) break // TODO: send error to client

		modules = modules.concat(doc.modules.filter(mod => mod.public), {
			id: module,
			public: false,
			package: doc.package,
			nodes: doc.nodes,
			modules: doc.modules
		})
	}

	let eof = false
	for (const match of execAll(document, /\{|\}|\[|\]|\(|\)|\/\*|\*\/|\/\/|\n|[^]$/g)) {
		const chars = match[0]

		if (eof)
			break

		switch (chars) {
			case '{':
				curlyBlocks++
				break
			case '}':
				curlyBlocks--
				break
			case '[':
				bracketBlocks++
				break
			case ']':
				bracketBlocks--
				break
			case '(':
				parentheses++
				break
			case ')':
				parentheses--
				break
			case '/*':
				multiComments++
				break
			case '*/':
				multiComments = 0
				break
			case '//':
				singleComments++
				break
			case '\n':
				singleComments = 0
				break
			case '':
				if (match.index + 1 === document.length) {
					singleComments = 0
					eof = true
				}
		}

		const subDocument = document.substr(match.index)
		const zone = document.substring(match.index, Math.min(subDocument.indexOf('{'), subDocument.indexOf('}')))

		// Not inside comment
		if (multiComments + singleComments === 0) {
			const message = /^\s*message\s*([^\s{]+)/m.exec(zone)?.[1]
			if (message && !nodes.find(node => node.name === message)) {
				nodes.push({
					type: 'message',
					name: message
				})
			} else {
				// TODO: handle duplicates
			}

			const enum_ = /^\s*enum\s*([^\s{]+)/m.exec(zone)?.[1]
			if (enum_ && !nodes.find(node => node.name === enum_)) {
				nodes.push({
					type: 'enum',
					name: enum_
				})
			} else {
				// TODO: handle duplicates
			}
		}

		if (curlyBlocks > 0) {
			latestNegativeCurly = match.index
		}

		if (bracketBlocks > 0) {
			latestNegativeBracket = match.index
		}

		if (parentheses > 0) {
			latestNegativeParentheses = match.index
		}

		if (multiComments > 0) {
			latestNegativeMultiComment = match.index
		}
	}

	if (curlyBlocks > 0) {
		throw new ParseError('}', '{', path, offsetToPosition(document, latestNegativeCurly ?? 0))
	}

	if (bracketBlocks > 0) {
		throw new ParseError(']', '[', path, offsetToPosition(document, latestNegativeBracket ?? 0))
	}

	if (parentheses > 0) {
		throw new ParseError(')', '(', path, offsetToPosition(document, latestNegativeParentheses ?? 0))
	}

	if (multiComments > 0) {
		throw new ParseError('*/', '/*', path, offsetToPosition(document, latestNegativeMultiComment ?? 0))
	}

	return {
		package: package_,
		nodes: nodes,
		modules
	}
}

function nodeTypeToCompletionItemKind(type: Node['type']): CompletionItemKind {
	switch (type) {
		case 'enum': return CompletionItemKind.Enum
		case 'message': return CompletionItemKind.Class
	}
}

function nodeToCompletionItem(node: Node): CompletionItem {
	return {
		label: node.name,
		kind: nodeTypeToCompletionItemKind(node.type),
		sortText: `!${node.name}`
	}
}

function packageToCompletionItem(package_: string): CompletionItem {
	return {
		label: package_,
		kind: CompletionItemKind.Module,
		sortText: `!${package_}`
	}
}

function flat<T>(array: T[][]): T[] {
	return array.reduce((acc, val) => acc.concat(val), [])
}

// TODO: option to disable/enable
// TODO: fix multiple package items
connection.onCompletion(
	async (params): Promise<CompletionItem[]> => {
		const textDocument = documents.get(params.textDocument.uri)
		if (!textDocument) return []

		const settings = await getDocumentSettings(textDocument.uri)

		const position = params.position
		const content = documents.get(textDocument.uri)?.getText() ?? ''
		const offset = textDocument.offsetAt(position)

		try {
			const root = parse(textDocument.uri, content, settings)

			const getChildModules = (modules: Module[]): Module[] =>
				flat(modules.map(mod => mod.modules.concat(getChildModules(mod.modules))))

			const childModules = getChildModules(root.modules).concat(root.modules)
			const modules = (childModules as (RootModule | Module)[]).concat(root)
			const nodes = flat(modules.map(mod => mod.package ? [] : mod.nodes))

			if (content.charAt(offset - 1) === '.') {
				let i = offset
				while (/[^\s;]/.test(content.charAt(--i))); i++

				let module = modules.find(module => module.package === content.substring(i, offset - 1))

				if (module) {
					return module.nodes.map(node => nodeToCompletionItem(node))
				} else {
					return []
				}
			}

			return nodes.map(node => nodeToCompletionItem(node))
				.concat(childModules
					.map(module => module.package ? packageToCompletionItem(module.package) : undefined)
					.filter((item: CompletionItem | undefined): item is CompletionItem => Boolean(item)))
		} catch (err) {
			if (ParseError.isParserError(err)) {
				connection.sendDiagnostics({
					diagnostics: [{
						message: err.message,
						range: Range.create(err.start.toPosition(), err.end.toPosition())
					}],
					uri: textDocument.uri
				})
			} else {
				throw err
			}

			return []
		}
	}
)

connection.onCompletionResolve(item => item)

documents.listen(connection)
connection.listen()

