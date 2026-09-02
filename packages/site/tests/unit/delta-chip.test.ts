import { render } from 'lit';
import { describe, expect, it } from 'vitest';
import { renderDeltaChip } from '../../src/components/analytics/delta-chip';

function renderToContainer(template: unknown): HTMLDivElement {
  const container = document.createElement('div');
  render(template as Parameters<typeof render>[0], container);
  return container;
}

describe('renderDeltaChip', () => {
  it('renders nothing when delta is undefined', () => {
    const container = renderToContainer(renderDeltaChip(undefined));
    expect(container.querySelector('.delta-chip')).toBeNull();
  });

  it('renders an up triangle polygon', () => {
    const container = renderToContainer(renderDeltaChip({ direction: 'up', text: '+5%' }));
    const chip = container.querySelector('.delta-chip.up');
    expect(chip?.textContent).toContain('+5%');
    expect(chip?.querySelector('polygon')).not.toBeNull();
  });

  it('renders a down triangle polygon', () => {
    const container = renderToContainer(renderDeltaChip({ direction: 'down', text: '-5%' }));
    expect(container.querySelector('.delta-chip.down polygon')).not.toBeNull();
  });

  it('renders a flat rect glyph', () => {
    const container = renderToContainer(renderDeltaChip({ direction: 'flat', text: '0%' }));
    expect(container.querySelector('.delta-chip.flat rect')).not.toBeNull();
  });
});
