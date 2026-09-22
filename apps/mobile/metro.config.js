// Metro in a pnpm workspace.
//
// The app imports @cam-nav/core from the workspace, so Metro has to watch the
// repo root and follow symlinks. It must NOT set `disableHierarchicalLookup`:
// that is the npm/yarn monorepo recipe, and under pnpm every package keeps its
// own dependencies in a nested node_modules that only hierarchical lookup can
// reach — turning it off makes expo fail to resolve expo-modules-core.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
