/**
 * Storybook-style fixture page for the shared analytics card components
 * (issue #166). Dev-only entry, wired via `analytics-cards-demo.html` —
 * not part of the production `app-root` bundle or router.
 */
import '../components/analytics/analytics-card';
import '../components/analytics/stat-tile-hero';
import '../components/analytics/stat-tile-delta';
import '../components/analytics/stat-tile-missing';
import '../components/analytics/stat-ring';
import '../components/analytics/stat-strip';
import '../components/charts/sparkline';
import type { StatStrip } from '../components/analytics/stat-strip';
import type { StatTileDelta } from '../components/analytics/stat-tile-delta';
import type { StatTileHero } from '../components/analytics/stat-tile-hero';
import type { Sparkline } from '../components/charts/sparkline';

function wireDeltas(): void {
  const up = document.getElementById('hero-up') as StatTileHero | null;
  if (up) up.delta = { direction: 'up', text: '+12%' };
  const down = document.getElementById('hero-down') as StatTileHero | null;
  if (down) down.delta = { direction: 'down', text: '-4%' };
  const flat = document.getElementById('hero-flat') as StatTileHero | null;
  if (flat) flat.delta = { direction: 'flat', text: '0%' };
}

function wireSparklines(): void {
  const points = Array.from({ length: 20 }, (_, i) => Math.sin(i / 2) * 10 + 20 + i * 0.6);
  for (const id of ['hero-up', 'hero-down', 'hero-flat']) {
    const hero = document.getElementById(id) as StatTileHero | null;
    if (hero) hero.sparklinePoints = points;
  }

  const empty = document.getElementById('spark-empty') as Sparkline | null;
  if (empty) empty.points = [];
  const one = document.getElementById('spark-one') as Sparkline | null;
  if (one) one.points = [12];
  const many = document.getElementById('spark-many') as Sparkline | null;
  if (many) many.points = Array.from({ length: 60 }, (_, i) => Math.sin(i / 4) * 10 + 20);
}

function wireDeltaTile(): void {
  const tile = document.getElementById('delta-tile') as StatTileDelta | null;
  if (!tile) return;
  tile.delta = { direction: 'up', text: '+6%' };
  tile.breakdown = [
    { label: 'Pass', value: '812', color: '#3ecf8e' },
    { label: 'Fail', value: '30', color: '#ff6b6b' },
  ];
}

function wireStrip(): void {
  const wrap = document.getElementById('strip-wrap');
  if (!wrap) return;
  const strip = document.createElement('stat-strip') as StatStrip;
  strip.items = [
    { label: 'Sessions', value: '128', sampleLabel: 'n=128' },
    { label: 'Tool calls', value: '842', sampleLabel: 'n=842' },
    { label: 'Tokens', value: '1.4M', sampleLabel: 'n=128' },
    { label: 'Avg. cost', value: '$0.42', sampleLabel: 'n=90' },
  ];
  wrap.appendChild(strip);
}

function wireClickLog(): void {
  const log = document.getElementById('log');
  if (!log) return;
  document.body.addEventListener('card-click', (event) => {
    const detail = (event as CustomEvent).detail;
    log.textContent = `card-click: ${JSON.stringify(detail)}\n${log.textContent ?? ''}`;
  });
}

wireDeltas();
wireSparklines();
wireDeltaTile();
wireStrip();
wireClickLog();
