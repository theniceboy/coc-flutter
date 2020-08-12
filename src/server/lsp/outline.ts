import { commands, LanguageClient, workspace } from 'coc.nvim';
import { statusBar } from '../../lib/status';
import { cmdPrefix } from '../../util/constant';
import { Range } from 'vscode-languageserver-protocol';

import { Dispose } from '../../util/dispose';

const verticalLine = '│';
// const horizontalLine = '─';
const bottomCorner = '└';
const middleCorner = '├';
const icons = {
	TOP_LEVEL_VARIABLE: '\uf435',
	CLASS: '\uf0e8 ',
	FIELD: '\uf93d',
	CONSTRUCTOR: '\ue624 ',
	CONSTRUCTOR_INVOCATION: '\ufc2a ',
	FUNCTION: '\u0192 ',
	METHOD: '\uf6a6 ',
};

interface ClientParams_Outline {
	uri: string;
	outline: OutlineParams;
}

interface OutlineParams {
	element: ElementParams;
	range: Range;
	codeRange: Range;
	children: OutlineParams[];
	folded: boolean;
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
	public outlineStrings: Record<string, string[]> = {};
	public outlineVersions: Record<string, number> = {};
	public outlineVersions_Rendered: Record<string, number> = {};
	public renderedOutlineUri = '';
	public outlineBuffer: any;

	constructor(client: LanguageClient) {
		super();
		this.init(client);
	}

	updateOutlineBuffer = async (uri: string) => {
		console.log(uri, this.outlineVersions[uri], this.outlineVersions_Rendered[uri]);
		if (
			this.outlineVersions[uri] == this.outlineVersions_Rendered[uri] &&
			this.outlineVersions[uri] !== undefined &&
			uri == this.renderedOutlineUri
		)
			return;
		if (this.outlineBuffer) {
			this.renderedOutlineUri = uri;
			let content: string[] = [];
			if (this.outlineStrings[uri]) {
				this.outlineVersions_Rendered[uri] = this.outlineVersions[uri];
				content = this.outlineStrings[uri];
			}
			const len = await this.outlineBuffer.length;
			if (len > content.length) {
				await this.outlineBuffer.setLines([], {
					start: 0,
					end: len - 1,
				});
				// console.log(this.outlineStrings[uri]);
				await this.outlineBuffer.setLines(content, {
					start: 0,
					end: 0,
					strictIndexing: false,
				});
			} else {
				await this.outlineBuffer.setLines(content, {
					start: 0,
					end: len - 1,
					strictIndexing: false,
				});
			}
		}
	};

	getUIPathFromCursor(outline: OutlineParams, cursor: number[]) {
		let elementPath = '';
		let foundChild = true;
		while (foundChild) {
			foundChild = false;
			if (Array.isArray(outline.children) && outline.children.length > 0) {
				for (const child of outline.children) {
					const curLine = cursor[0] - 1,
						curCol = cursor[1] - 1;
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

	async getCurrentUri() {
		const path = await workspace.nvim.commandOutput('echo expand("%:p")');
		return `file://${path}`;
	}

	async init(client: LanguageClient) {
		const { nvim } = workspace;
		console.log('list');
		console.log(nvim.eventNames());
		nvim.on('notification', async (...args) => {
			if (args[0] === 'CocAutocmd' && args[1][0] === 'CursorMoved') {
				const cursor = args[1][2];
				const uri = await this.getCurrentUri();
				const outline = this.outlines[uri];
				if (outline) {
					this.getUIPathFromCursor(outline, cursor);
					this.updateOutlineBuffer(uri);
				}
			}
		});
		client.onNotification('dart/textDocument/publishOutline', this.onOutline);
		const outlineBufferName = '__flutter_widget_tree';
		commands.registerCommand(`${cmdPrefix}.openWidgetTree`, async () => {
			const curWin = await nvim.window;
			await nvim.command('set splitright');
			await nvim.command(`30vsplit ${outlineBufferName}`);
			const win = await nvim.window;
			await nvim.command('set buftype=nofile');
			// await nvim.command('setlocal nomodifiable');
			await nvim.command('setlocal nonumber');
			await nvim.command('setlocal norelativenumber');
			await nvim.command('setlocal nowrap');
			await nvim.call('win_gotoid', [curWin.id]);
			this.outlineBuffer = await win.buffer;
			const uri = await this.getCurrentUri();
			this.updateOutlineBuffer(uri);
			// const buf = await win.buffer;
			// const r = await nvim.commandOutput('new');
			// console.log(r);
		});
	}

	generateOutlineStrings = (uri: string) => {
		const root = this.outlines[uri];
		const lines: string[] = [];
		const icon_default = '\ue612';
		function genOutline(outline: OutlineParams, indentStr: string) {
			let indent = indentStr;
			let foldIndicator = '  ';
			let icon = icons[outline.element.kind];
			if (icon === undefined) icon = icon_default;
			// icon += ' ';
			if (Array.isArray(outline.children) && outline.children.length > 0 && outline.folded === true)
				foldIndicator = '▸ ';
			lines.push(indent + ' ' + icon + outline.element.name);
			const len = indent.length;
			if (len > 0) {
				if (indent[len - 1] == middleCorner) {
					indent = indent.substr(0, len - 1) + verticalLine;
				} else if (indent[len - 1] == bottomCorner) {
					indent = indent.substr(0, len - 1) + ' ';
				}
			}
			if (Array.isArray(outline.children))
				if (outline.children.length == 1) {
					genOutline(outline.children[0], `${indent} `);
				} else if (outline.children.length > 1) {
					for (let i = 0; i < outline.children.length; ++i) {
						if (i == outline.children.length - 1) {
							// indent = indent.substr(0, len - 2) + '  ';
							genOutline(outline.children[i], `${indent}${bottomCorner}`);
						} else {
							genOutline(outline.children[i], `${indent}${middleCorner}`);
						}
					}
				}
		}
		if (Array.isArray(root.children) && root.children.length > 0)
			for (const child of root.children) genOutline(child, '');
		this.outlineStrings[uri] = lines;
		if (this.outlineVersions[uri] === undefined) {
			this.outlineVersions[uri] = 0;
		} else {
			this.outlineVersions[uri] += 1;
		}
	};

	onOutline = async (params: ClientParams_Outline) => {
		const { uri, outline } = params;
		const doc = workspace.getDocument(uri);
		// ensure the document is exists
		if (!doc) {
			return;
		}

		this.outlines[uri] = outline;
		this.generateOutlineStrings(uri);
		this.updateOutlineBuffer(uri);
	};
}
