import { commands, LanguageClient, workspace } from 'coc.nvim';
import { statusBar } from '../../lib/status';
import { cmdPrefix } from '../../util/constant';
import { Range, Position } from 'vscode-languageserver-protocol';

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
const outlineBufferName = '__flutter_widget_tree';

function ucs2ToBinaryString(str) {
	const escstr = encodeURIComponent(str);
	const binstr = escstr.replace(/%([0-9A-F]{2})/gi, function(match, hex) {
		const i = parseInt(hex, 16);
		return String.fromCharCode(i);
	});
	return binstr;
}

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
	lineNumber: number | undefined;
	startCol: number | undefined;
	endCol: number | undefined;
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
	public curOutlineItem: OutlineParams | undefined;
	public highlightIds: number[] = [];
	public showPath: boolean | undefined;

	constructor(client: LanguageClient) {
		super();
		this.init(client);
		const config = workspace.getConfiguration('flutter');
		this.showPath = config.get<boolean>('UIPath', true);
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
			const newLine = `${indent} ${icon}${outline.element.name}: ${outline.codeRange.start.line}`;
			outline.lineNumber = lines.length;
			outline.startCol = ucs2ToBinaryString(indent).length;
			outline.endCol = ucs2ToBinaryString(newLine).length;
			lines.push(newLine);
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

	updateOutlineBuffer = async (uri: string, force = false) => {
		if (
			((this.outlineVersions[uri] === this.outlineVersions_Rendered[uri] && this.outlineVersions[uri] === undefined) ||
				this.outlineVersions[uri] !== this.outlineVersions_Rendered[uri] ||
				uri !== this.renderedOutlineUri ||
				force) &&
			this.outlineBuffer
		) {
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
					strictIndexing: false,
				});
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
		const windows = await workspace.nvim.windows;
		if (
			this.curOutlineItem !== undefined &&
			this.outlineBuffer !== undefined &&
			this.curOutlineItem.lineNumber !== undefined &&
			this.curOutlineItem.startCol !== undefined &&
			this.curOutlineItem.endCol !== undefined
		) {
			// workspace.nvim.pauseNotification();
			// workspace.nvim.resumeNotification();
			for (const win of windows) {
				const buf = await win.buffer;
				if (buf.id === this.outlineBuffer.id) {
					buf.clearHighlight();
					win.setCursor([this.curOutlineItem.lineNumber, 0]).catch(() => {});
					buf
						.addHighlight({
							hlGroup: 'HighlightedOutlineArea',
							line: this.curOutlineItem.lineNumber,
							colStart: this.curOutlineItem.startCol,
							colEnd: this.curOutlineItem.endCol,
						})
						.catch(() => {});
				}
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
		this.curOutlineItem = outline;
		statusBar.show(elementPath, false);
	}

	async getCurrentUri() {
		const path = await workspace.nvim.commandOutput('echo expand("%:p")');
		return `file://${path}`;
	}

	async init(client: LanguageClient) {
		const { nvim } = workspace;
		nvim.on('notification', async (...args) => {
			if (args[0] === 'CocAutocmd' && args[1][0] === 'CursorMoved') {
				const cursor = args[1][2];
				const uri = await this.getCurrentUri();
				const outline = this.outlines[uri];
				if (outline) {
					if (this.showPath) this.getUIPathFromCursor(outline, cursor);
					this.updateOutlineBuffer(uri);
				}
			}
		});
		client.onNotification('dart/textDocument/publishOutline', this.onOutline);
		commands.registerCommand(`${cmdPrefix}.outline`, async () => {
			const curWin = await nvim.window;
			await nvim.command('set splitright');
			await nvim.command(`30vsplit ${outlineBufferName}`);
			const win = await nvim.window;
			await nvim.command('set buftype=nofile');
			// await nvim.command('setlocal nomodifiable');
			await nvim.command('setlocal nocursorline');
			await nvim.command('setlocal nonumber');
			await nvim.command('setlocal norelativenumber');
			await nvim.command('setlocal nowrap');
			await nvim.command(
				`syntax match OutlineLine /^\\(${verticalLine}\\| \\)*\\(${middleCorner}\\|${bottomCorner}\\)\\?/`,
			);
			await nvim.command('highlight default link HighlightedOutlineArea IncSearch');
			await nvim.command(`highlight default link OutlineLine Comment`);
			await nvim.command(`syntax match FlutterOutlineFunction /${icons.FUNCTION}/`);
			await nvim.command(`highlight default link FlutterOutlineFunction Function`);
			await nvim.command(`syntax match FlutterOutlineType /${icons.FIELD}/`);
			await nvim.command(`highlight default link FlutterOutlineType Identifier`);
			await nvim.command(`syntax match FlutterOutlineClass /${icons.CLASS}/`);
			await nvim.command(`highlight default link FlutterOutlineClass Type`);
			await nvim.command(`syntax match FlutterOutlineMethod /${icons.METHOD}/`);
			await nvim.command(`highlight default link FlutterOutlineMethod Function`);
			await nvim.command(`syntax match FlutterOutlineTopLevelVar /${icons.TOP_LEVEL_VARIABLE}/`);
			await nvim.command(`highlight default link FlutterOutlineTopLevelVar Identifier`);
			await nvim.command(`syntax match FlutterOutlineConstructor /${icons.CONSTRUCTOR}/`);
			await nvim.command(`highlight default link FlutterOutlineConstructor Function`);
			await nvim.command(`syntax match FlutterOutlineConstructorInvocation /${icons.CONSTRUCTOR_INVOCATION}/`);
			await nvim.command(`highlight default link FlutterOutlineConstructorInvocation Special`);
			await nvim.command(`syntax match FlutterOutlineLineNumber /: \\d\\+$/`);
			await nvim.command(`highlight default link FlutterOutlineLineNumber Number`);
			this.outlineBuffer = await win.buffer;
			await nvim.call('win_gotoid', [curWin.id]);
			const uri = await this.getCurrentUri();
			this.updateOutlineBuffer(uri, true);
			// const buf = await win.buffer;
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
		this.generateOutlineStrings(uri);
		this.updateOutlineBuffer(uri);
	};
}
