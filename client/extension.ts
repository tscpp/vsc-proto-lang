import * as path from 'path'
import { workspace, ExtensionContext } from 'vscode'

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient/node'

let client: LanguageClient

export function activate(context: ExtensionContext) {
	const serverModule = context.asAbsolutePath('out/server/server.js')
	const debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] }

	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: debugOptions
		}
	}

	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: 'file', language: 'proto3' }]
	}

	client = new LanguageClient(
		'proto-lang-server',
		'Protocol Buffers Language Server',
		serverOptions,
		clientOptions
	)

	client.start()
}

export function deactivate(): Promise<void> | undefined {
	if (!client) return
	return client.stop()
}
