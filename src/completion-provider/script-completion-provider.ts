import {
  CompletionItem,
  TextDocumentPositionParams
} from 'vscode-languageserver';

import Server from '../server';
import ASTPath from '../glimmer-utils';
import { toPosition } from '../estree-utils';
import { filter } from 'fuzzaldrin';
import { parse } from 'babylon';
const { uniqBy } = require('lodash');
const memoize = require('memoizee');
import { getExtension } from '../utils/file-extension';
import { log } from '../utils/logger';
import {
  isStoreModelLookup,
  isRouteLookup
} from '../utils/ast-helpers';
import {
  listRoutes,
  listModels,
  // mGetProjectAddonsInfo
} from '../utils/layout-helpers';

const mListRoutes = memoize(listRoutes, { length: 1, maxAge: 60000 });
const mListModels = memoize(listModels, { length: 1, maxAge: 60000 });

export default class ScriptCompletionProvider {
  constructor(private server: Server) {}
  provideCompletions(params: TextDocumentPositionParams): CompletionItem[] {
    log('provideCompletions');
    if (getExtension(params.textDocument) !== '.js') {
      return [];
    }
    const uri = params.textDocument.uri;
    const project = this.server.projectRoots.projectForUri(uri);
    if (!project) {
      return [];
    }
    const document = this.server.documents.get(uri);
    const { root } = project;
    const content = document.getText();

    const ast = parse(content, {
      sourceType: 'module'
    });

    const focusPath = ASTPath.toPosition(ast, toPosition(params.position));

    if (!focusPath || !project || !document) {
      return [];
    }

    const completions: CompletionItem[] = [];
    let textPrefix = '';
    try {
      if (isStoreModelLookup(focusPath)) {
        textPrefix = focusPath.node.value;
        mListModels(root).forEach((model: any) => {
          completions.push(model);
        });
      } else if (isRouteLookup(focusPath)) {
        textPrefix = focusPath.node.value;
        mListRoutes(root).forEach((model: any) => {
          completions.push(model);
        });
      }
    } catch (e) {
      log('error', e);
    }

    return filter(uniqBy(completions, 'label'), textPrefix, {
      key: 'label',
      maxResults: 40
    });
  }
}