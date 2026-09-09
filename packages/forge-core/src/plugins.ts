/**
 * Plugin runtime (API v1). Plugins extend Core with tools, providers,
 * event hooks and CLI/server-accessible commands — without modifying Core.
 *
 * SECURITY BOUNDARY (v0.1): local plugins run in-process and are FULLY
 * TRUSTED (same privilege as Core). Only load plugins from directories you
 * control. Remote/marketplace plugins and sandboxing are explicitly NOT
 * supported yet — see SECURITY.md. The loader refuses to fetch remote code.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ForgeError } from './errors.js';
import type { EventBus } from './events.js';
import type { ToolRegistry, ToolDefinition, ToolHandler } from './tools.js';
import type { ModelProvider } from './providers.js';
import type { ModelRouter } from './router.js';

export const PLUGIN_API_VERSION = 'forge-plugin/1';

export interface PluginManifest {
  name: string;
  version: string;
  /** Must equal forge-plugin/1. */
  api: string;
  entry: string;
  description?: string;
}

export interface PluginContext {
  apiVersion: string;
  pluginName: string;
  tools: ToolRegistry;
  router: ModelRouter;
  bus: EventBus;
  projectDir: string;
  /** Register a namespaced tool (name auto-prefixed when missing). */
  registerTool: (def: ToolDefinition, handler: ToolHandler) => void;
  /** Register an additional model provider. */
  registerProvider: (provider: ModelProvider) => void;
  log: (message: string) => void;
}

export interface PluginModule {
  activate: (ctx: PluginContext) => void | Promise<void>;
  deactivate?: () => void | Promise<void>;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  module: PluginModule;
}

export interface PluginHost {
  tools: ToolRegistry;
  router: ModelRouter;
  bus: EventBus;
  projectDir: string;
}

function readManifest(dir: string): PluginManifest | undefined {
  const path = join(dir, 'forge.plugin.json');
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PluginManifest>;
    if (!raw.name || !raw.version || !raw.entry) return undefined;
    return { name: raw.name, version: raw.version, api: raw.api ?? '', entry: raw.entry, description: raw.description };
  } catch {
    return undefined;
  }
}

/**
 * Load all plugins from a directory (each subdirectory with a manifest).
 * Throws on API mismatch; skips directories without manifests.
 */
export async function loadPlugins(pluginsDir: string, host: PluginHost): Promise<LoadedPlugin[]> {
  const root = resolve(pluginsDir);
  if (!existsSync(root)) return [];
  const loaded: LoadedPlugin[] = [];
  const errors: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const manifest = readManifest(dir);
    if (!manifest) continue;
    if (manifest.api !== PLUGIN_API_VERSION) {
      errors.push(`${manifest.name}: unsupported plugin API '${manifest.api}' (host speaks ${PLUGIN_API_VERSION})`);
      continue;
    }
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(manifest.name)) {
      errors.push(`${dir}: invalid plugin name '${manifest.name}'`);
      continue;
    }
    const entryPath = resolve(dir, manifest.entry);
    if (!entryPath.startsWith(dir + '/') && entryPath !== resolve(dir, manifest.entry)) {
      errors.push(`${manifest.name}: entry escapes plugin directory`);
      continue;
    }
    if (!existsSync(entryPath)) {
      errors.push(`${manifest.name}: entry not found: ${manifest.entry}`);
      continue;
    }
    try {
      const mod = (await import(pathToFileURL(entryPath).href)) as Partial<PluginModule> & { default?: Partial<PluginModule> };
      const activate = mod.activate ?? mod.default?.activate;
      if (typeof activate !== 'function') throw new Error('plugin entry must export activate(ctx)');
      const ctx: PluginContext = {
        apiVersion: PLUGIN_API_VERSION,
        pluginName: manifest.name,
        tools: host.tools,
        router: host.router,
        bus: host.bus,
        projectDir: host.projectDir,
        registerTool: (def, handler) => {
          const name = def.name.includes('.') ? def.name : `${manifest.name}.${def.name}`;
          host.tools.register({ ...def, name }, handler);
        },
        registerProvider: (provider) => host.router.registerProvider(provider),
        log: (message) => host.bus.emit({ type: 'runtime.warning', data: { message: `[plugin:${manifest.name}] ${message}` } }),
      };
      await activate(ctx);
      loaded.push({ manifest, dir, module: { activate, deactivate: mod.deactivate ?? mod.default?.deactivate } });
      host.bus.emit({ type: 'runtime.warning', data: { message: `Plugin loaded: ${manifest.name}@${manifest.version}` } });
    } catch (e) {
      errors.push(`${manifest.name}: ${(e as Error).message}`);
    }
  }
  if (errors.length > 0) {
    throw new ForgeError('CONFIG_ERROR', `Plugin load errors:\n${errors.map((e) => `- ${e}`).join('\n')}`, { details: { errors } });
  }
  return loaded;
}
