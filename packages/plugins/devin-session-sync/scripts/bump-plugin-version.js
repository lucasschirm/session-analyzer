import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

for (const manifestDir of ['.devin-plugin', '.claude-plugin']) {
  const pluginPath = join(__dirname, '..', manifestDir, 'plugin.json');
  const plugin = JSON.parse(readFileSync(pluginPath, 'utf8'));
  plugin.version = pkg.version;
  writeFileSync(pluginPath, `${JSON.stringify(plugin, null, 2)}\n`);
}
