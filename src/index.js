'use strict';

// Programmatic API. The CLI is a thin layer over exactly these functions.
const { installPlugin, uninstallPlugin, updateAll, listPlugins } = require('./install');
const { resolveBrand, DEFAULT_PROFILE } = require('./brand');
const { loadCatalog, resolvePlugin } = require('./catalog');
const { materialize } = require('./fetch');
const { addPluginLocation, removePluginLocation } = require('./settings-merge');
const { UserError } = require('./util');
const harness = require('./harness');
const manifest = require('./manifest');
const paths = require('./paths');

module.exports = {
  installPlugin,
  uninstallPlugin,
  updateAll,
  listPlugins,
  resolveBrand,
  DEFAULT_PROFILE,
  loadCatalog,
  resolvePlugin,
  materialize,
  addPluginLocation,
  removePluginLocation,
  harness,
  manifest,
  paths,
  UserError,
};
