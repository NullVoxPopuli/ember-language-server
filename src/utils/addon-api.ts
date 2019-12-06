import { Location, TextDocumentIdentifier, Position, CompletionItem } from 'vscode-languageserver';
import { getProjectAddonsRoots, getPackageJSON, getProjectInRepoAddonsRoots } from './layout-helpers';
import * as path from 'path';
import { log, logInfo, logError } from './logger';
import Server from '../server';
import ASTPath from './../glimmer-utils';
import DAGMap from 'dag-map';

import CoreScriptDefinitionProvider from './../builtin-addons/core/script-definition-provider';
import CoreTemplateDefinitionProvider from './../builtin-addons/core/template-definition-provider';
import ScriptCompletionProvider from './../builtin-addons/core/script-completion-provider';
import TemplateCompletionProvider from './../builtin-addons/core/template-completion-provider';

const ADDON_CONFIG_KEY = 'ember-language-server';
interface BaseAPIParams {
  server: Server;
  textDocument: TextDocumentIdentifier;
  position: Position;
}
interface ExtendedAPIParams extends BaseAPIParams {
  focusPath: ASTPath;
  originalText?: string;
  type: 'script' | 'template';
}
export interface ReferenceFunctionParams extends BaseAPIParams {
  results: Location[];
}
export interface CompletionFunctionParams extends ExtendedAPIParams {
  results: CompletionItem[];
}
export interface DefinitionFunctionParams extends ExtendedAPIParams {
  results: Location[];
}
type ReferenceResolveFunction = (root: string, params: ReferenceFunctionParams) => Promise<Location[]>;
type CompletionResolveFunction = (root: string, params: CompletionFunctionParams) => Promise<CompletionItem[]>;
type DefinitionResolveFunction = (root: string, params: DefinitionFunctionParams) => Promise<Location[]>;
export interface AddonAPI {
  onReference: undefined | ReferenceResolveFunction;
  onComplete: undefined | CompletionResolveFunction;
  onDefinition: undefined | DefinitionResolveFunction;
}

interface PublicAddonAPI {
  onReference?: ReferenceResolveFunction;
  onComplete?: CompletionResolveFunction;
  onDefinition?: DefinitionResolveFunction;
}
interface HandlerObject {
  handler: PublicAddonAPI;
  updateHandler: () => void;
  packageRoot: string;
  debug: boolean;
  packageJSON: any;
  capabilities: NormalizedCapabilities;
}

export async function queryELSAddonsAPIChain(callbacks: any[], root: string, params: any): Promise<any[]> {
  let lastResult = params.results || [];
  for (let callback of callbacks) {
    try {
      let tempResult = await callback(root, Object.assign({}, params, { results: JSON.parse(JSON.stringify(lastResult)) }));
      // API must return array
      if (Array.isArray(tempResult)) {
        lastResult = tempResult;
      }
    } catch (e) {
      logError(e);
      log('ELSAddonsAPIError', callback, e.toString(), root, params);
    }
  }
  return lastResult;
}

export function initBuiltinProviders(): ProjectProviders {
  const scriptDefinition = new CoreScriptDefinitionProvider();
  const templateDefinition = new CoreTemplateDefinitionProvider();
  const scriptCompletion = new ScriptCompletionProvider();
  const templateCompletion = new TemplateCompletionProvider();
  return {
    definitionProviders: [scriptDefinition.onDefinition.bind(scriptDefinition), templateDefinition.onDefinition.bind(templateDefinition)],
    referencesProviders: [],
    completionProviders: [scriptCompletion.onComplete.bind(scriptCompletion), templateCompletion.onComplete.bind(templateCompletion)]
  };
}

function requireUncached(module: string) {
  delete require.cache[require.resolve(module)];
  let result = {};
  try {
    result = require(module);
  } catch (e) {
    logError(e);
  }
  return result;
}

export function collectProjectProviders(root: string): ProjectProviders {
  const roots = [root]
    .concat(getProjectAddonsRoots(root) as any, getProjectInRepoAddonsRoots(root) as any)
    .filter((pathItem: any) => typeof pathItem === 'string');
  const dagMap: DAGMap<HandlerObject> = new DAGMap();
  roots.forEach((packagePath: string) => {
    const info = getPackageJSON(packagePath);
    if (hasEmberLanguageServerExtension(info)) {
      const handlerPath = languageServerHandler(info);
      const addonInfo = info['ember-addon'] || {};
      const addon: HandlerObject = {
        handler: requireUncached(path.join(packagePath, handlerPath)),
        updateHandler() {
          this.handler = requireUncached(path.join(packagePath, handlerPath));
        },
        packageRoot: packagePath,
        packageJSON: info,
        debug: isDebugModeEnabled(info),
        capabilities: normalizeCapabilities(extensionCapabilities(info))
      };
      dagMap.add(info.name || packagePath, addon, addonInfo.before, addonInfo.after);
    }
  });

  const result: {
    definitionProviders: DefinitionResolveFunction[];
    referencesProviders: ReferenceResolveFunction[];
    completionProviders: CompletionResolveFunction[];
  } = {
    definitionProviders: [],
    referencesProviders: [],
    completionProviders: []
  };

  // onReference, onComplete, onDefinition

  dagMap.each((_, handlerObject) => {
    if (handlerObject === undefined) {
      return;
    }

    // let's reload files in case of debug mode for each request
    if (handlerObject.debug) {
      logInfo(`els-addon-api: debug mode enabled for ${handlerObject.packageRoot}, for all requests resolvers will be reloaded.`);
      result.completionProviders.push(function(root: string, params: CompletionFunctionParams) {
        handlerObject.updateHandler();
        if (typeof handlerObject.handler.onComplete === 'function') {
          return handlerObject.handler.onComplete(root, params);
        } else {
          return params.results;
        }
      } as CompletionResolveFunction);
      result.referencesProviders.push(function(root: string, params: ReferenceFunctionParams) {
        handlerObject.updateHandler();
        if (typeof handlerObject.handler.onReference === 'function') {
          return handlerObject.handler.onReference(root, params);
        } else {
          return params.results;
        }
      } as ReferenceResolveFunction);
      result.definitionProviders.push(function(root: string, params: DefinitionFunctionParams) {
        handlerObject.updateHandler();
        if (typeof handlerObject.handler.onDefinition === 'function') {
          return handlerObject.handler.onDefinition(root, params);
        } else {
          return params.results;
        }
      } as DefinitionResolveFunction);
    } else {
      if (handlerObject.capabilities.completionProvider && typeof handlerObject.handler.onComplete === 'function') {
        result.completionProviders.push(handlerObject.handler.onComplete);
      }
      if (handlerObject.capabilities.referencesProvider && typeof handlerObject.handler.onReference === 'function') {
        result.referencesProviders.push(handlerObject.handler.onReference);
      }
      if (handlerObject.capabilities.definitionProvider && typeof handlerObject.handler.onDefinition === 'function') {
        result.definitionProviders.push(handlerObject.handler.onDefinition);
      }
    }
  });

  return result;
}

export interface ProjectProviders {
  definitionProviders: DefinitionResolveFunction[];
  referencesProviders: ReferenceResolveFunction[];
  completionProviders: CompletionResolveFunction[];
}

interface ExtensionCapabilities {
  definitionProvider: undefined | true | false;
  referencesProvider:
    | true
    | undefined
    | {
        components: true | false;
      };
  completionProvider: true | undefined;
}

interface NormalizedCapabilities {
  definitionProvider: true | false;
  referencesProvider: true | false;
  completionProvider: true | false;
}

function normalizeCapabilities(raw: ExtensionCapabilities): NormalizedCapabilities {
  return {
    definitionProvider: raw.definitionProvider === true,
    referencesProvider: raw.referencesProvider === true || (typeof raw.referencesProvider === 'object' && raw.referencesProvider.components === true),
    completionProvider: typeof raw.completionProvider === 'object' || raw.completionProvider === true
  };
}

export function extensionCapabilities(info: any): ExtensionCapabilities {
  return info[ADDON_CONFIG_KEY].capabilities;
}
export function languageServerHandler(info: any): string {
  return info[ADDON_CONFIG_KEY].entry;
}
export function isDebugModeEnabled(info: any): boolean {
  return info[ADDON_CONFIG_KEY].debug === true;
}
export function hasEmberLanguageServerExtension(info: any) {
  return ADDON_CONFIG_KEY in info;
}