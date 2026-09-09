// Example Forge plugin (API v1). Install: copy this dir into your plugins
// directory and pass --plugins <dir> (or FORGE_PLUGINS) to forge.
export async function activate(ctx) {
  ctx.registerTool(
    {
      name: 'shout',
      description: 'Uppercase text (example plugin tool)',
      minAutonomy: 'read-only',
      inputSchema: {
        type: 'object',
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
    },
    async (input) => ({ shouted: String(input.text).toUpperCase() }),
  );
  ctx.log('shout plugin activated');
}
