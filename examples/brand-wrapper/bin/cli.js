#!/usr/bin/env node
'use strict';

// A branded front door for the neutral installer. Every field is optional;
// whatever you omit falls back to the neutral default, and a user's own flags
// or CP_* environment variables still win over this profile.
require('context-plugins/run')({
  id: 'acme', // the "name" in your marketplace.json
  displayName: 'Acme AI Plugins', // shown in the banner and help text
  repo: 'acme/plugin-marketplace', // where your plugins live
  bin: 'acme-plugins', // the command name printed in help text
});
