// Monorepo-aware Metro config: watch the workspace root and resolve
// node_modules from both the project and workspace level.

const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const workspaceRoot = path.resolve(__dirname, "../..");
const projectRoot = __dirname;

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = true;
module.exports = config;
