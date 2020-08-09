import { commands, LanguageClient, workspace } from 'coc.nvim';
import { statusBar } from '../../lib/status';
import { cmdPrefix } from '../../util/constant';
import { Range } from 'vscode-languageserver-protocol';

import { Dispose } from '../../util/dispose';

interface ClientParams_Outline {
	uri: string;
	outline: OutlineParams;
}

interface OutlineParams {
	element: ElementParams;
	range: Range;
	codeRange: Range;
	children: OutlineParams[];
}

interface ElementParams {
	name: string;
	range: Range;
	kind: string;
	parameters: string | undefined;
	typeParameters: string | undefined;
	returnType: string | undefined;
}

export class Outline extends Dispose {
	public outlines: Record<string, OutlineParams> = {};

	constructor(client: LanguageClient) {
		super();
		this.init(client);
	}

	async init(client: LanguageClient) {
		const { nvim } = workspace;
		client.onNotification('dart/textDocument/publishOutline', this.onOutline);
		commands.registerCommand(`${cmdPrefix}.updateCursorText`, async () => {
			(await nvim.window).cursor.then(cursor => {
				nvim.commandOutput('echo expand("%:p")').then(path => {
					const uri = `file://${path}`;
					let outline = this.outlines[uri];
					if (outline) {
						let elementPath = '';
						let foundChild = true;
						while (foundChild) {
							foundChild = false;
							if (Array.isArray(outline.children) && outline.children.length > 0) {
								for (const child of outline.children) {
									const curLine = cursor[0] - 1,
										curCol = cursor[1];
									const startLine = child.codeRange.start.line,
										startCol = child.codeRange.start.character;
									const endLine = child.codeRange.end.line,
										endCol = child.codeRange.end.character;
									if (
										(curLine > startLine || (curLine == startLine && curCol >= startCol)) &&
										(curLine < endLine || (curLine == endLine && curCol < endCol))
									) {
										outline = child;
										foundChild = true;
										break;
									}
								}
							}
							if (foundChild) {
								elementPath += ` > ${outline.element.name}`;
							} else {
								break;
							}
						}
						statusBar.show(elementPath, false);
					}
				});
			});
		});
	}

	onOutline = async (params: ClientParams_Outline) => {
		const { uri, outline } = params;
		const doc = workspace.getDocument(uri);
		// ensure the document is exists
		if (!doc) {
			return;
		}

		this.outlines[uri] = outline;
	};
}
