// Metro (the app's bundler) in the monorepo: the shared packages are TypeScript written for Node's
// module rules, so "./time.js" inside them means the file "./time.ts".
const { getDefaultConfig } = require('expo/metro-config');
const fs = require('node:fs');
const path = require('node:path');

const config = getDefaultConfig(__dirname);
const resolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, name, platform) => {
  if (name.startsWith('.') && name.endsWith('.js')) {
    const ts = path.resolve(path.dirname(context.originModulePath), name.replace(/\.js$/, '.ts'));
    if (fs.existsSync(ts)) return { type: 'sourceFile', filePath: ts };
  }
  return (resolve ?? context.resolveRequest)(context, name, platform);
};
module.exports = config;
